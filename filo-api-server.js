// ═══════════════════════════════════════════════════════════════════
// FILO — Complete Backend API Server
// Node.js + Express + PostgreSQL
// ═══════════════════════════════════════════════════════════════════

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import pg from 'pg';
import AWS from 'aws-sdk';
import Stripe from 'stripe';

// ─── Configuration ───────────────────────────────────────────────

const config = {
  port: process.env.PORT || 4000,
  nodeEnv: process.env.NODE_ENV || 'development',
  jwtSecret: process.env.JWT_SECRET || 'filo-dev-secret-change-in-production',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || 'filo-refresh-secret-change',
  jwtExpiry: '15m',
  jwtRefreshExpiry: '7d',
  database: {
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/filo',
    max: 20,
    idleTimeoutMillis: 30000,
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    basePriceId: process.env.STRIPE_BASE_PRICE_ID,
    userPriceId: process.env.STRIPE_USER_PRICE_ID,
  },
  aws: {
    region: process.env.AWS_REGION || 'us-east-1',
    s3Bucket: process.env.S3_BUCKET || 'filo-uploads',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.GPT_MODEL || 'gpt-4o',
  },
};

// ─── Initialize Services ─────────────────────────────────────────

const pool = new pg.Pool(config.database);
const stripe = new Stripe(config.stripe.secretKey);
const s3 = new AWS.S3({
  region: config.aws.region,
  accessKeyId: config.aws.accessKeyId,
  secretAccessKey: config.aws.secretAccessKey,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/heic', 'image/webp',
      'application/pdf', 'text/csv', 'text/plain',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// ─── Database Helper ─────────────────────────────────────────────

const db = {
  query: (text, params) => pool.query(text, params),

  getOne: async (text, params) => {
    const result = await pool.query(text, params);
    return result.rows[0] || null;
  },

  getMany: async (text, params) => {
    const result = await pool.query(text, params);
    return result.rows;
  },

  transaction: async (callback) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },
};

// ─── Express App ─────────────────────────────────────────────────

const app = express();

// Stripe webhook needs raw body — must come before json parser
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined'));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use('/api/', limiter);

// ─── Auth Middleware ──────────────────────────────────────────────

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(header.split(' ')[1], config.jwtSecret);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

async function requireActiveSubscription(req, res, next) {
  const sub = await db.getOne(
    `SELECT status FROM subscriptions WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [req.user.companyId]
  );
  if (!sub || !['active', 'trialing'].includes(sub.status)) {
    return res.status(403).json({ error: 'Active subscription required. Your account is locked.', code: 'SUBSCRIPTION_LOCKED' });
  }
  next();
}

// Activity logger
async function logActivity(companyId, userId, entityType, entityId, action, description, metadata = {}) {
  await db.query(
    `INSERT INTO activity_log (company_id, user_id, entity_type, entity_id, action, description, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [companyId, userId, entityType, entityId, action, description, metadata]
  );
}

// ═══════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════

// ─── Register Company ────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { companyName, email, password, firstName, lastName, phone } = req.body;

    if (!companyName || !email || !password || !firstName || !lastName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const existing = await db.getOne('SELECT id FROM users WHERE email = $1', [email]);
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const result = await db.transaction(async (client) => {
      // Create company
      const company = await client.query(
        `INSERT INTO companies (name, email, phone) VALUES ($1, $2, $3) RETURNING id`,
        [companyName, email, phone]
      );
      const companyId = company.rows[0].id;

      // Create user
      const passwordHash = await bcrypt.hash(password, 12);
      const user = await client.query(
        `INSERT INTO users (company_id, email, password_hash, first_name, last_name, phone, role)
         VALUES ($1, $2, $3, $4, $5, $6, 'admin') RETURNING id, role`,
        [companyId, email, passwordHash, firstName, lastName, phone]
      );

      // Create trial subscription
      await client.query(
        `INSERT INTO subscriptions (company_id, status, trial_end)
         VALUES ($1, 'trialing', NOW() + INTERVAL '14 days')`,
        [companyId]
      );

      return { companyId, userId: user.rows[0].id, role: user.rows[0].role };
    });

    const token = jwt.sign(
      { userId: result.userId, companyId: result.companyId, role: result.role },
      config.jwtSecret, { expiresIn: config.jwtExpiry }
    );
    const refreshToken = jwt.sign(
      { userId: result.userId }, config.jwtRefreshSecret, { expiresIn: config.jwtRefreshExpiry }
    );

    // Store refresh token
    const tokenHash = await bcrypt.hash(refreshToken, 10);
    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [result.userId, tokenHash]
    );

    await logActivity(result.companyId, result.userId, 'company', result.companyId, 'register', `Company "${companyName}" registered`);

    res.status(201).json({ token, refreshToken, user: { id: result.userId, companyId: result.companyId, role: result.role } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ─── Login ───────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await db.getOne(
      `SELECT u.*, c.name as company_name FROM users u JOIN companies c ON c.id = u.company_id WHERE u.email = $1`,
      [email]
    );
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (!user.is_active) return res.status(403).json({ error: 'Account disabled' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { userId: user.id, companyId: user.company_id, role: user.role },
      config.jwtSecret, { expiresIn: config.jwtExpiry }
    );
    const refreshToken = jwt.sign(
      { userId: user.id }, config.jwtRefreshSecret, { expiresIn: config.jwtRefreshExpiry }
    );

    const tokenHash = await bcrypt.hash(refreshToken, 10);
    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [user.id, tokenHash]
    );

    await db.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
    await logActivity(user.company_id, user.id, 'user', user.id, 'login', 'User logged in');

    res.json({
      token, refreshToken,
      user: {
        id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name,
        role: user.role, companyId: user.company_id, companyName: user.company_name,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─── Refresh Token ───────────────────────────────────────────────
app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    const decoded = jwt.verify(refreshToken, config.jwtRefreshSecret);

    const tokens = await db.getMany(
      'SELECT * FROM refresh_tokens WHERE user_id = $1 AND revoked = false AND expires_at > NOW()',
      [decoded.userId]
    );

    let valid = false;
    for (const t of tokens) {
      if (await bcrypt.compare(refreshToken, t.token_hash)) { valid = true; break; }
    }
    if (!valid) return res.status(401).json({ error: 'Invalid refresh token' });

    const user = await db.getOne('SELECT id, company_id, role FROM users WHERE id = $1', [decoded.userId]);
    const newToken = jwt.sign(
      { userId: user.id, companyId: user.company_id, role: user.role },
      config.jwtSecret, { expiresIn: config.jwtExpiry }
    );

    res.json({ token: newToken });
  } catch (err) {
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// ─── Logout ──────────────────────────────────────────────────────
app.post('/api/auth/logout', authenticate, async (req, res) => {
  await db.query('UPDATE refresh_tokens SET revoked = true WHERE user_id = $1', [req.user.userId]);
  res.json({ message: 'Logged out' });
});

// ─── Invite User ─────────────────────────────────────────────────
app.post('/api/auth/invite', authenticate, requireAdmin, async (req, res) => {
  try {
    const { email, firstName, lastName, role } = req.body;
    const inviteToken = uuidv4();
    const tempPassword = await bcrypt.hash(uuidv4(), 12);

    await db.query(
      `INSERT INTO users (company_id, email, password_hash, first_name, last_name, role, invite_token, invite_expires)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '7 days') RETURNING id`,
      [req.user.companyId, email, tempPassword, firstName, lastName, role || 'estimator', inviteToken]
    );

    // No email — admin shares the invite link directly
    const inviteLink = `${process.env.FRONTEND_URL || 'https://app.filo.com'}/invite/${inviteToken}`;
    res.status(201).json({ message: 'Invite created. Share the link with the user.', inviteToken, inviteLink });
  } catch (err) {
    console.error('Invite error:', err);
    res.status(500).json({ error: 'Failed to invite user' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// COMPANY ROUTES
// ═══════════════════════════════════════════════════════════════════

app.get('/api/company', authenticate, async (req, res) => {
  const company = await db.getOne('SELECT * FROM companies WHERE id = $1', [req.user.companyId]);
  res.json(company);
});

app.put('/api/company', authenticate, requireAdmin, async (req, res) => {
  const fields = req.body;
  const allowed = [
    'name', 'phone', 'email', 'website', 'address_line1', 'address_line2',
    'city', 'state', 'zip', 'country', 'license_number', 'timezone',
    'latitude', 'longitude', 'usda_zone', 'default_design_style',
    'labor_pricing_method', 'material_markup_pct', 'delivery_fee',
    'soil_amendment_per_cy', 'mulch_per_cy', 'edging_per_lf', 'removal_base_fee',
    'irrigation_hourly_rate', 'labor_rate_per_gallon', 'labor_rate_per_hour',
    'labor_lump_default', 'tax_enabled', 'tax_rate', 'default_terms', 'warranty_terms',
  ];

  const updates = [];
  const values = [];
  let idx = 1;
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      updates.push(`${key} = $${idx}`);
      values.push(fields[key]);
      idx++;
    }
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  values.push(req.user.companyId);
  const result = await db.getOne(
    `UPDATE companies SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`, values
  );

  await logActivity(req.user.companyId, req.user.userId, 'company', req.user.companyId, 'update', 'Company settings updated');
  res.json(result);
});

app.put('/api/company/onboarding', authenticate, requireAdmin, async (req, res) => {
  await db.query('UPDATE companies SET onboarding_completed = true WHERE id = $1', [req.user.companyId]);
  res.json({ message: 'Onboarding completed' });
});

// ═══════════════════════════════════════════════════════════════════
// CLIENT ROUTES
// ═══════════════════════════════════════════════════════════════════

app.get('/api/clients', authenticate, requireActiveSubscription, async (req, res) => {
  const { search, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;
  let query = 'SELECT * FROM clients WHERE company_id = $1';
  const params = [req.user.companyId];

  if (search) {
    query += ` AND (display_name ILIKE $2 OR email ILIKE $2 OR phone ILIKE $2)`;
    params.push(`%${search}%`);
  }
  query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  const clients = await db.getMany(query, params);
  const countResult = await db.getOne('SELECT COUNT(*) FROM clients WHERE company_id = $1', [req.user.companyId]);

  res.json({ clients, total: parseInt(countResult.count), page: parseInt(page), limit: parseInt(limit) });
});

app.post('/api/clients', authenticate, requireActiveSubscription, async (req, res) => {
  try {
    const { displayName, firstName, lastName, email, phone, addressLine1, city, state, zip, notes } = req.body;

    const client = await db.getOne(
      `INSERT INTO clients (company_id, display_name, first_name, last_name, email, phone, address_line1, city, state, zip, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [req.user.companyId, displayName, firstName, lastName, email, phone, addressLine1, city, state, zip, notes]
    );

    await logActivity(req.user.companyId, req.user.userId, 'client', client.id, 'create', `Client "${displayName}" created`);

    // Trigger CRM sync
    await triggerCrmSync(req.user.companyId, 'client', client.id, 'create', client);

    res.status(201).json(client);
  } catch (err) {
    console.error('Create client error:', err);
    res.status(500).json({ error: 'Failed to create client' });
  }
});

app.get('/api/clients/:id', authenticate, async (req, res) => {
  const client = await db.getOne('SELECT * FROM clients WHERE id = $1 AND company_id = $2', [req.params.id, req.user.companyId]);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(client);
});

app.put('/api/clients/:id', authenticate, async (req, res) => {
  const fields = req.body;
  const allowed = ['display_name', 'first_name', 'last_name', 'email', 'phone', 'address_line1', 'address_line2', 'city', 'state', 'zip', 'notes'];
  const updates = [], values = [];
  let idx = 1;
  for (const key of allowed) {
    if (fields[key] !== undefined) { updates.push(`${key} = $${idx}`); values.push(fields[key]); idx++; }
  }
  values.push(req.params.id, req.user.companyId);
  const client = await db.getOne(`UPDATE clients SET ${updates.join(', ')} WHERE id = $${idx} AND company_id = $${idx + 1} RETURNING *`, values);
  res.json(client);
});

app.delete('/api/clients/:id', authenticate, requireAdmin, async (req, res) => {
  await db.query('DELETE FROM clients WHERE id = $1 AND company_id = $2', [req.params.id, req.user.companyId]);
  res.json({ message: 'Client deleted' });
});

// ═══════════════════════════════════════════════════════════════════
// PROJECT ROUTES
// ═══════════════════════════════════════════════════════════════════

app.get('/api/projects', authenticate, requireActiveSubscription, async (req, res) => {
  const { status, clientId, page = 1, limit = 50 } = req.query;
  let query = 'SELECT * FROM v_active_projects WHERE company_id = $1';
  const params = [req.user.companyId];

  if (status) { params.push(status); query += ` AND status = $${params.length}`; }
  if (clientId) { params.push(clientId); query += ` AND client_id = $${params.length}`; }

  query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, (page - 1) * limit);

  const projects = await db.getMany(query, params);
  res.json({ projects });
});

app.post('/api/projects', authenticate, requireActiveSubscription, async (req, res) => {
  try {
    const { clientId, name, areas, sunExposure, designStyle, specialRequests, lightingRequested, lightingTypes, hardscapeChanges, hardscapeNotes } = req.body;

    const project = await db.transaction(async (client) => {
      // Create project
      const proj = await client.query(
        `INSERT INTO projects (company_id, client_id, created_by, name, status, sun_exposure, design_style, special_requests, lighting_requested, lighting_types, hardscape_changes, hardscape_notes)
         VALUES ($1, $2, $3, $4, 'photo_upload', $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [req.user.companyId, clientId, req.user.userId, name, sunExposure, designStyle, specialRequests, lightingRequested, lightingTypes, hardscapeChanges, hardscapeNotes]
      );

      // Create property areas
      if (areas?.length) {
        for (let i = 0; i < areas.length; i++) {
          await client.query(
            `INSERT INTO property_areas (project_id, area_type, custom_name, sort_order) VALUES ($1, $2, $3, $4)`,
            [proj.rows[0].id, areas[i].type, areas[i].name, i]
          );
        }
      }

      return proj.rows[0];
    });

    await logActivity(req.user.companyId, req.user.userId, 'project', project.id, 'create', `Project "${project.project_number}" created`);
    res.status(201).json(project);
  } catch (err) {
    console.error('Create project error:', err);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

app.get('/api/projects/:id', authenticate, async (req, res) => {
  const project = await db.getOne(
    'SELECT * FROM v_active_projects WHERE id = $1 AND company_id = $2',
    [req.params.id, req.user.companyId]
  );
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const areas = await db.getMany('SELECT * FROM property_areas WHERE project_id = $1 ORDER BY sort_order', [project.id]);
  const designs = await db.getMany('SELECT * FROM designs WHERE project_id = $1 AND is_current = true', [project.id]);
  const estimates = await db.getMany('SELECT * FROM estimates WHERE project_id = $1 AND is_current = true', [project.id]);
  const revisions = await db.getMany('SELECT * FROM revisions WHERE project_id = $1 ORDER BY created_at DESC LIMIT 20', [project.id]);

  res.json({ ...project, areas, designs, estimates, revisions });
});

app.put('/api/projects/:id', authenticate, async (req, res) => {
  const fields = req.body;
  const allowed = ['name', 'status', 'sun_exposure', 'design_style', 'special_requests', 'lighting_requested', 'lighting_types', 'hardscape_changes', 'hardscape_notes'];
  const updates = [], values = [];
  let idx = 1;
  for (const key of allowed) {
    if (fields[key] !== undefined) { updates.push(`${key} = $${idx}`); values.push(fields[key]); idx++; }
  }
  values.push(req.params.id, req.user.companyId);
  const project = await db.getOne(`UPDATE projects SET ${updates.join(', ')} WHERE id = $${idx} AND company_id = $${idx + 1} RETURNING *`, values);
  res.json(project);
});

app.put('/api/projects/:id/status', authenticate, async (req, res) => {
  const { status } = req.body;
  const project = await db.getOne(
    'UPDATE projects SET status = $1 WHERE id = $2 AND company_id = $3 RETURNING *',
    [status, req.params.id, req.user.companyId]
  );
  await logActivity(req.user.companyId, req.user.userId, 'project', project.id, 'status_change', `Status changed to ${status}`);
  res.json(project);
});

// ─── Property Areas ──────────────────────────────────────────────

app.get('/api/projects/:projectId/areas', authenticate, async (req, res) => {
  const areas = await db.getMany(
    'SELECT * FROM property_areas WHERE project_id = $1 ORDER BY sort_order',
    [req.params.projectId]
  );
  res.json(areas);
});

app.post('/api/projects/:projectId/areas', authenticate, async (req, res) => {
  const { areaType, customName } = req.body;
  const area = await db.getOne(
    `INSERT INTO property_areas (project_id, area_type, custom_name) VALUES ($1, $2, $3) RETURNING *`,
    [req.params.projectId, areaType, customName]
  );
  res.status(201).json(area);
});

// ─── Existing Plants Detection ───────────────────────────────────

app.get('/api/areas/:areaId/existing-plants', authenticate, async (req, res) => {
  const plants = await db.getMany(
    'SELECT * FROM existing_plants WHERE property_area_id = $1 ORDER BY position_x',
    [req.params.areaId]
  );
  res.json(plants);
});

app.put('/api/existing-plants/:id/mark', authenticate, async (req, res) => {
  const { mark, comment } = req.body;
  const plant = await db.getOne(
    'UPDATE existing_plants SET mark = $1, comment = $2 WHERE id = $3 RETURNING *',
    [mark, comment, req.params.id]
  );
  res.json(plant);
});

// ═══════════════════════════════════════════════════════════════════
// FILE UPLOAD ROUTES
// ═══════════════════════════════════════════════════════════════════

app.post('/api/upload', authenticate, upload.single('file'), async (req, res) => {
  try {
    const { fileType } = req.body;
    const file = req.file;
    const key = `${req.user.companyId}/${fileType}/${uuidv4()}-${file.originalname}`;

    await s3.upload({
      Bucket: config.aws.s3Bucket,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      ACL: 'private',
    }).promise();

    const cdnUrl = `https://${config.aws.s3Bucket}.s3.${config.aws.region}.amazonaws.com/${key}`;

    const dbFile = await db.getOne(
      `INSERT INTO files (company_id, uploaded_by, file_type, original_name, s3_key, s3_bucket, cdn_url, mime_type, file_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.user.companyId, req.user.userId, fileType, file.originalname, key, config.aws.s3Bucket, cdnUrl, file.mimetype, file.size]
    );

    res.status(201).json(dbFile);
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.post('/api/upload/photos/:areaId', authenticate, upload.array('photos', 20), async (req, res) => {
  try {
    const photos = [];
    for (const file of req.files) {
      const key = `${req.user.companyId}/photos/${uuidv4()}-${file.originalname}`;
      await s3.upload({ Bucket: config.aws.s3Bucket, Key: key, Body: file.buffer, ContentType: file.mimetype }).promise();
      const cdnUrl = `https://${config.aws.s3Bucket}.s3.${config.aws.region}.amazonaws.com/${key}`;

      const dbFile = await db.getOne(
        `INSERT INTO files (company_id, uploaded_by, file_type, original_name, s3_key, s3_bucket, cdn_url, mime_type, file_size)
         VALUES ($1, $2, 'photo', $3, $4, $5, $6, $7, $8) RETURNING *`,
        [req.user.companyId, req.user.userId, file.originalname, key, config.aws.s3Bucket, cdnUrl, file.mimetype, file.size]
      );

      const photo = await db.getOne(
        `INSERT INTO photos (property_area_id, file_id, sort_order) VALUES ($1, $2, $3) RETURNING *`,
        [req.params.areaId, dbFile.id, photos.length]
      );
      photos.push({ ...photo, file: dbFile });
    }

    // Trigger AI plant detection
    for (const photo of photos) {
      await triggerAIJob(req.user.companyId, null, null, 'plant_detection', { photoId: photo.id, fileUrl: photo.file.cdn_url, areaId: req.params.areaId });
    }

    res.status(201).json(photos);
  } catch (err) {
    console.error('Photo upload error:', err);
    res.status(500).json({ error: 'Photo upload failed' });
  }
});

// Presigned URL for direct upload
app.post('/api/upload/presign', authenticate, async (req, res) => {
  const { fileName, fileType, contentType } = req.body;
  const key = `${req.user.companyId}/${fileType}/${uuidv4()}-${fileName}`;

  const presignedUrl = s3.getSignedUrl('putObject', {
    Bucket: config.aws.s3Bucket, Key: key, ContentType: contentType, Expires: 300,
  });

  res.json({ presignedUrl, key, cdnUrl: `https://${config.aws.s3Bucket}.s3.${config.aws.region}.amazonaws.com/${key}` });
});

// ═══════════════════════════════════════════════════════════════════
// PLANT LIBRARY ROUTES
// ═══════════════════════════════════════════════════════════════════

app.get('/api/plants', authenticate, async (req, res) => {
  const { search, category, sun, page = 1, limit = 100 } = req.query;
  let query = 'SELECT * FROM plant_library WHERE (company_id = $1 OR is_global = true) AND is_available = true';
  const params = [req.user.companyId];

  if (search) { params.push(`%${search}%`); query += ` AND (common_name ILIKE $${params.length} OR botanical_name ILIKE $${params.length})`; }
  if (category) { params.push(category); query += ` AND category = $${params.length}`; }
  if (sun) { params.push(sun); query += ` AND sun_requirement = $${params.length}`; }

  query += ` ORDER BY sort_order, common_name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, (page - 1) * limit);

  const plants = await db.getMany(query, params);
  res.json({ plants });
});

app.post('/api/plants', authenticate, requireAdmin, async (req, res) => {
  const p = req.body;
  const plant = await db.getOne(
    `INSERT INTO plant_library (company_id, common_name, botanical_name, category, container_size, mature_height, mature_width, sun_requirement, water_needs, bloom_color, bloom_season, foliage_color, image_url, description, poetic_description, retail_price, wholesale_price, tags, is_native)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
    [req.user.companyId, p.commonName, p.botanicalName, p.category, p.containerSize, p.matureHeight, p.matureWidth, p.sunRequirement, p.waterNeeds, p.bloomColor, p.bloomSeason, p.foliageColor, p.imageUrl, p.description, p.poeticDescription, p.retailPrice, p.wholesalePrice, p.tags, p.isNative]
  );
  res.status(201).json(plant);
});

app.post('/api/plants/import', authenticate, requireAdmin, upload.single('file'), async (req, res) => {
  try {
    // Parse nursery availability list (CSV, Excel, PDF, or text)
    const file = req.body;
    // Parse nursery list via AI pipeline (GPT-4o parses PDF/Excel/CSV content)
    // The AI job processor in filo-ai-pipeline.js handles this via processJob()

    const nurseryList = await db.getOne(
      `INSERT INTO nursery_lists (company_id, name, source_format, parse_status) VALUES ($1, $2, $3, 'processing') RETURNING *`,
      [req.user.companyId, req.file.originalname, req.file.mimetype]
    );

    await triggerAIJob(req.user.companyId, null, null, 'parse_nursery_list', { nurseryListId: nurseryList.id, fileUrl: req.file.path });

    res.json({ message: 'Import started', nurseryListId: nurseryList.id });
  } catch (err) {
    res.status(500).json({ error: 'Import failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// DESIGN / AI ROUTES
// ═══════════════════════════════════════════════════════════════════

app.post('/api/projects/:projectId/designs/generate', authenticate, requireActiveSubscription, async (req, res) => {
  try {
    const project = await db.getOne('SELECT * FROM projects WHERE id = $1 AND company_id = $2', [req.params.projectId, req.user.companyId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const areas = await db.getMany('SELECT * FROM property_areas WHERE project_id = $1', [project.id]);
    const company = await db.getOne('SELECT * FROM companies WHERE id = $1', [req.user.companyId]);
    const plants = await db.getMany('SELECT * FROM plant_library WHERE (company_id = $1 OR is_global = true) AND is_available = true', [req.user.companyId]);

    const designs = [];
    for (const area of areas) {
      const photos = await db.getMany(
        'SELECT p.*, f.cdn_url FROM photos p JOIN files f ON f.id = p.file_id WHERE p.property_area_id = $1',
        [area.id]
      );
      const existingPlants = await db.getMany('SELECT * FROM existing_plants WHERE property_area_id = $1', [area.id]);

      // Mark previous designs as not current
      await db.query('UPDATE designs SET is_current = false WHERE property_area_id = $1', [area.id]);

      const design = await db.getOne(
        `INSERT INTO designs (project_id, property_area_id, generation_status, generation_started_at, ai_prompt)
         VALUES ($1, $2, 'processing', NOW(), $3) RETURNING *`,
        [project.id, area.id, JSON.stringify({
          location: { city: company.city, state: company.state, zone: company.usda_zone },
          sun: project.sun_exposure, style: project.design_style,
          specialRequests: project.special_requests,
          existingPlants: existingPlants.filter(p => p.mark === 'keep'),
          removedPlants: existingPlants.filter(p => p.mark === 'remove'),
          lighting: project.lighting_requested ? project.lighting_types : null,
          hardscape: project.hardscape_changes ? project.hardscape_notes : null,
        })]
      );

      // Queue AI design generation job
      await triggerAIJob(req.user.companyId, project.id, design.id, 'design_generation', {
        designId: design.id,
        photos: photos.map(p => p.cdn_url),
        sunExposure: project.sun_exposure,
        designStyle: project.design_style,
        specialRequests: project.special_requests,
        availablePlants: plants,
        existingPlants,
        location: { city: company.city, state: company.state, zone: company.usda_zone },
        lighting: project.lighting_requested ? project.lighting_types : null,
      });

      designs.push(design);
    }

    await db.query('UPDATE projects SET status = $1 WHERE id = $2', ['design_generation', project.id]);
    res.json({ designs, message: 'Design generation started' });
  } catch (err) {
    console.error('Design generation error:', err);
    res.status(500).json({ error: 'Failed to start design generation' });
  }
});

app.get('/api/designs/:id', authenticate, async (req, res) => {
  const design = await db.getOne('SELECT * FROM designs WHERE id = $1', [req.params.id]);
  if (!design) return res.status(404).json({ error: 'Design not found' });

  const plants = await db.getMany(
    `SELECT dp.*, pl.common_name, pl.botanical_name, pl.image_url, pl.retail_price, pl.category
     FROM design_plants dp JOIN plant_library pl ON pl.id = dp.plant_library_id
     WHERE dp.design_id = $1 ORDER BY dp.z_index`,
    [design.id]
  );

  res.json({ ...design, plants });
});

// ─── Chat Commands (design adjustments) ──────────────────────────

app.post('/api/designs/:designId/chat', authenticate, async (req, res) => {
  try {
    const { message } = req.body;
    const design = await db.getOne('SELECT * FROM designs WHERE id = $1', [req.params.designId]);

    // Save user message
    await db.query(
      'INSERT INTO chat_messages (project_id, design_id, user_id, role, content) VALUES ($1, $2, $3, $4, $5)',
      [design.project_id, design.id, req.user.userId, 'user', message]
    );

    // Send to AI for interpretation (direct OpenAI calls via filo-ai-pipeline.js)
    const aiResponse = await callManusAI('design_chat', {
      command: message,
      currentDesign: design.plant_placements,
      designId: design.id,
    });

    // Save AI response
    await db.query(
      'INSERT INTO chat_messages (project_id, design_id, role, content, ai_action) VALUES ($1, $2, $3, $4, $5)',
      [design.project_id, design.id, 'assistant', aiResponse.message, aiResponse.actions]
    );

    // Apply changes if any
    if (aiResponse.actions?.length) {
      for (const action of aiResponse.actions) {
        if (action.type === 'swap_plant') {
          await db.query('UPDATE design_plants SET plant_library_id = $1 WHERE design_id = $2 AND plant_library_id = $3',
            [action.newPlantId, design.id, action.oldPlantId]);
        } else if (action.type === 'add_plant') {
          await db.query(
            'INSERT INTO design_plants (design_id, plant_library_id, quantity, position_x, position_y) VALUES ($1, $2, $3, $4, $5)',
            [design.id, action.plantId, action.quantity, action.x, action.y]);
        } else if (action.type === 'remove_plant') {
          await db.query('DELETE FROM design_plants WHERE id = $1', [action.designPlantId]);
        }
      }

      // Create revision
      await db.query(
        `INSERT INTO revisions (project_id, design_id, user_id, version, revision_type, description, chat_command)
         VALUES ($1, $2, $3, (SELECT COALESCE(MAX(version), 0) + 1 FROM revisions WHERE design_id = $2), 'chat_command', $4, $5)`,
        [design.project_id, design.id, req.user.userId, aiResponse.message, message]
      );
    }

    res.json({ message: aiResponse.message, actions: aiResponse.actions });
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Chat processing failed' });
  }
});

// ─── Manual Plant Adjustments (drag/drop) ────────────────────────

app.put('/api/design-plants/:id/position', authenticate, async (req, res) => {
  const { positionX, positionY } = req.body;
  const plant = await db.getOne(
    'UPDATE design_plants SET position_x = $1, position_y = $2 WHERE id = $3 RETURNING *',
    [positionX, positionY, req.params.id]
  );
  res.json(plant);
});

app.post('/api/designs/:designId/plants', authenticate, async (req, res) => {
  const { plantLibraryId, quantity, positionX, positionY, containerSize } = req.body;
  const plant = await db.getOne(
    `INSERT INTO design_plants (design_id, plant_library_id, quantity, position_x, position_y, container_size)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [req.params.designId, plantLibraryId, quantity, positionX, positionY, containerSize]
  );
  res.status(201).json(plant);
});

app.delete('/api/design-plants/:id', authenticate, async (req, res) => {
  await db.query('DELETE FROM design_plants WHERE id = $1', [req.params.id]);
  res.json({ message: 'Plant removed' });
});

// ═══════════════════════════════════════════════════════════════════
// ESTIMATE ROUTES
// ═══════════════════════════════════════════════════════════════════

app.post('/api/projects/:projectId/estimates/generate', authenticate, async (req, res) => {
  try {
    const project = await db.getOne('SELECT * FROM projects WHERE id = $1 AND company_id = $2', [req.params.projectId, req.user.companyId]);
    const company = await db.getOne('SELECT * FROM companies WHERE id = $1', [req.user.companyId]);

    // Mark previous as not current
    await db.query('UPDATE estimates SET is_current = false WHERE project_id = $1', [project.id]);

    const estimate = await db.transaction(async (client) => {
      const est = await client.query(
        `INSERT INTO estimates (project_id, company_id, tax_rate, tax_enabled, labor_method, material_markup, terms, warranty)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [project.id, req.user.companyId, company.tax_rate, company.tax_enabled, company.labor_pricing_method, company.material_markup_pct, company.default_terms, company.warranty_terms]
      );
      const estimateId = est.rows[0].id;

      // Get all design plants
      const designs = await client.query('SELECT id FROM designs WHERE project_id = $1 AND is_current = true', [project.id]);
      let sortOrder = 0;
      let subtotal = 0;

      for (const design of designs.rows) {
        const designPlants = await client.query(
          `SELECT dp.*, pl.common_name, pl.retail_price, pl.container_size as lib_container
           FROM design_plants dp JOIN plant_library pl ON pl.id = dp.plant_library_id WHERE dp.design_id = $1`,
          [design.id]
        );

        for (const dp of designPlants.rows) {
          const price = dp.price_override || (dp.retail_price * (1 + company.material_markup_pct / 100));
          const total = price * dp.quantity;
          await client.query(
            `INSERT INTO estimate_line_items (estimate_id, category, plant_library_id, design_plant_id, description, quantity, unit, unit_price, total_price, sort_order)
             VALUES ($1, 'plant_material', $2, $3, $4, $5, $6, $7, $8, $9)`,
            [estimateId, dp.plant_library_id, dp.id, `${dp.common_name} (${dp.container_size || dp.lib_container})`, dp.quantity, 'ea', price, total, sortOrder++]
          );
          subtotal += total;
        }
      }

      // Add service line items
      const services = [
        { cat: 'labor', desc: 'Installation Labor', price: company.labor_lump_default || 1200 },
        { cat: 'soil_amendment', desc: 'Soil Amendments', price: company.soil_amendment_per_cy * 3 },
        { cat: 'mulch', desc: 'Hardwood Mulch', price: company.mulch_per_cy * 4 },
        { cat: 'edging', desc: 'Steel Edging', price: company.edging_per_lf * 60 },
        { cat: 'delivery', desc: 'Delivery', price: company.delivery_fee },
      ];

      // Add removal if applicable
      const removals = await client.query(
        `SELECT COUNT(*) FROM existing_plants ep
         JOIN property_areas pa ON pa.id = ep.property_area_id
         WHERE pa.project_id = $1 AND ep.mark = 'remove'`, [project.id]
      );
      if (parseInt(removals.rows[0].count) > 0) {
        services.push({ cat: 'removal_disposal', desc: 'Plant Removal & Disposal (lump sum)', price: company.removal_base_fee });
      }

      for (const svc of services) {
        await client.query(
          `INSERT INTO estimate_line_items (estimate_id, category, description, quantity, unit, unit_price, total_price, sort_order)
           VALUES ($1, $2, $3, 1, 'ea', $4, $4, $5)`,
          [estimateId, svc.cat, svc.desc, svc.price, sortOrder++]
        );
        subtotal += svc.price;
      }

      const taxAmount = company.tax_enabled ? subtotal * company.tax_rate : 0;
      const total = subtotal + taxAmount;

      await client.query(
        'UPDATE estimates SET subtotal = $1, tax_amount = $2, total = $3 WHERE id = $4',
        [subtotal, taxAmount, total, estimateId]
      );
      await client.query('UPDATE projects SET estimated_total = $1 WHERE id = $2', [total, project.id]);

      return { ...est.rows[0], subtotal, tax_amount: taxAmount, total };
    });

    res.json(estimate);
  } catch (err) {
    console.error('Estimate generation error:', err);
    res.status(500).json({ error: 'Failed to generate estimate' });
  }
});

app.get('/api/estimates/:id', authenticate, async (req, res) => {
  const estimate = await db.getOne('SELECT * FROM estimates WHERE id = $1 AND company_id = $2', [req.params.id, req.user.companyId]);
  if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

  const lineItems = await db.getMany('SELECT * FROM estimate_line_items WHERE estimate_id = $1 ORDER BY sort_order', [estimate.id]);
  res.json({ ...estimate, lineItems });
});

app.put('/api/estimates/:id/line-items/:lineItemId', authenticate, async (req, res) => {
  const { unitPrice, quantity, description } = req.body;
  const totalPrice = unitPrice * quantity;
  const item = await db.getOne(
    'UPDATE estimate_line_items SET unit_price = $1, quantity = $2, description = $3, total_price = $4 WHERE id = $5 RETURNING *',
    [unitPrice, quantity, description, totalPrice, req.params.lineItemId]
  );

  // Recalculate totals
  const items = await db.getMany('SELECT total_price FROM estimate_line_items WHERE estimate_id = $1', [req.params.id]);
  const subtotal = items.reduce((sum, i) => sum + parseFloat(i.total_price), 0);
  const estimate = await db.getOne('SELECT tax_rate, tax_enabled FROM estimates WHERE id = $1', [req.params.id]);
  const taxAmount = estimate.tax_enabled ? subtotal * parseFloat(estimate.tax_rate) : 0;

  await db.query('UPDATE estimates SET subtotal = $1, tax_amount = $2, total = $3 WHERE id = $4',
    [subtotal, taxAmount, subtotal + taxAmount, req.params.id]);

  res.json(item);
});

app.put('/api/estimates/:id/approve', authenticate, async (req, res) => {
  const estimate = await db.getOne(
    `UPDATE estimates SET status = 'approved', approved_by = $1, approved_at = NOW() WHERE id = $2 AND company_id = $3 RETURNING *`,
    [req.user.userId, req.params.id, req.user.companyId]
  );
  await db.query('UPDATE projects SET status = $1 WHERE id = $2', ['estimate_approved', estimate.project_id]);
  await logActivity(req.user.companyId, req.user.userId, 'estimate', estimate.id, 'approve', 'Estimate approved');
  res.json(estimate);
});

// ═══════════════════════════════════════════════════════════════════
// SUBMITTAL ROUTES
// ═══════════════════════════════════════════════════════════════════

app.post('/api/projects/:projectId/submittals/generate', authenticate, async (req, res) => {
  try {
    const project = await db.getOne(
      `SELECT p.*, c.display_name as client_name, c.address_line1, c.city, c.state
       FROM projects p JOIN clients c ON c.id = p.client_id
       WHERE p.id = $1 AND p.company_id = $2`, [req.params.projectId, req.user.companyId]
    );
    const company = await db.getOne('SELECT * FROM companies WHERE id = $1', [req.user.companyId]);
    const estimate = await db.getOne('SELECT * FROM estimates WHERE project_id = $1 AND is_current = true', [project.id]);

    // Get all unique plants from designs
    const designPlants = await db.getMany(
      `SELECT DISTINCT ON (pl.id) pl.* FROM design_plants dp
       JOIN plant_library pl ON pl.id = dp.plant_library_id
       JOIN designs d ON d.id = dp.design_id
       WHERE d.project_id = $1 AND d.is_current = true`, [project.id]
    );

    // Generate scope narrative via AI
    const narrative = await callManusAI('generate_narrative', {
      companyName: company.name,
      clientName: project.client_name,
      address: `${project.property_address || project.client_name}`,
      designStyle: project.design_style,
      sunExposure: project.sun_exposure,
      plants: designPlants.map(p => p.common_name),
      lighting: project.lighting_requested,
      hardscape: project.hardscape_changes,
    });

    await db.query('UPDATE submittals SET is_current = false WHERE project_id = $1', [project.id]);

    const submittal = await db.transaction(async (client) => {
      const sub = await client.query(
        `INSERT INTO submittals (project_id, company_id, estimate_id, cover_title, scope_narrative, status)
         VALUES ($1, $2, $3, $4, $5, 'generated') RETURNING *`,
        [project.id, req.user.companyId, estimate?.id, `Landscape Design Proposal`, narrative.text]
      );

      // Add plant profiles
      for (let i = 0; i < designPlants.length; i++) {
        const p = designPlants[i];
        await client.query(
          `INSERT INTO submittal_plant_profiles (submittal_id, plant_library_id, sort_order, plant_name, image_url, bloom_info, water_info, sun_info, poetic_desc)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [sub.rows[0].id, p.id, i, p.common_name, p.image_url, `${p.bloom_color}, ${p.bloom_season}`, p.water_needs, p.sun_requirement, p.poetic_description]
        );
      }

      return sub.rows[0];
    });

    // PDF generation is handled by POST /api/submittals/:id/pdf (filo-pdf-engine.js)
    // CRM push is handled by POST /api/submittals/:id/pdf-and-push or POST /api/crm/sync/full/:projectId

    await db.query('UPDATE projects SET status = $1 WHERE id = $2', ['submittal_sent', project.id]);
    await logActivity(req.user.companyId, req.user.userId, 'submittal', submittal.id, 'generate', 'Submittal generated');

    res.json(submittal);
  } catch (err) {
    console.error('Submittal generation error:', err);
    res.status(500).json({ error: 'Failed to generate submittal' });
  }
});

app.get('/api/submittals/:id', authenticate, async (req, res) => {
  const submittal = await db.getOne('SELECT * FROM submittals WHERE id = $1 AND company_id = $2', [req.params.id, req.user.companyId]);
  if (!submittal) return res.status(404).json({ error: 'Submittal not found' });

  const plantProfiles = await db.getMany('SELECT * FROM submittal_plant_profiles WHERE submittal_id = $1 ORDER BY sort_order', [submittal.id]);
  res.json({ ...submittal, plantProfiles });
});

// ═══════════════════════════════════════════════════════════════════
// REVISION ROUTES
// ═══════════════════════════════════════════════════════════════════

app.get('/api/projects/:projectId/revisions', authenticate, async (req, res) => {
  const revisions = await db.getMany(
    `SELECT r.*, u.first_name, u.last_name FROM revisions r
     JOIN users u ON u.id = r.user_id
     WHERE r.project_id = $1 ORDER BY r.created_at DESC`,
    [req.params.projectId]
  );
  res.json(revisions);
});

app.post('/api/projects/:projectId/revisions/:revisionId/revert', authenticate, async (req, res) => {
  const revision = await db.getOne('SELECT * FROM revisions WHERE id = $1', [req.params.revisionId]);
  if (!revision?.previous_state) return res.status(400).json({ error: 'Cannot revert — no previous state saved' });

  if (revision.design_id) {
    await db.query('UPDATE designs SET plant_placements = $1 WHERE id = $2', [revision.previous_state, revision.design_id]);
  }

  await logActivity(req.user.companyId, req.user.userId, 'revision', revision.id, 'revert', `Reverted to version ${revision.version}`);
  res.json({ message: `Reverted to version ${revision.version}` });
});

// ═══════════════════════════════════════════════════════════════════
// USERS / TEAM ROUTES
// ═══════════════════════════════════════════════════════════════════

app.get('/api/team', authenticate, async (req, res) => {
  const users = await db.getMany(
    'SELECT id, email, first_name, last_name, role, is_active, last_login_at, created_at FROM users WHERE company_id = $1 ORDER BY created_at',
    [req.user.companyId]
  );
  res.json(users);
});

app.put('/api/team/:userId', authenticate, requireAdmin, async (req, res) => {
  const { role, isActive } = req.body;
  const user = await db.getOne(
    'UPDATE users SET role = COALESCE($1, role), is_active = COALESCE($2, is_active) WHERE id = $3 AND company_id = $4 RETURNING id, email, role, is_active',
    [role, isActive, req.params.userId, req.user.companyId]
  );
  res.json(user);
});

app.delete('/api/team/:userId', authenticate, requireAdmin, async (req, res) => {
  if (req.params.userId === req.user.userId) return res.status(400).json({ error: 'Cannot delete yourself' });
  await db.query('UPDATE users SET is_active = false WHERE id = $1 AND company_id = $2', [req.params.userId, req.user.companyId]);
  res.json({ message: 'User deactivated' });
});

// ═══════════════════════════════════════════════════════════════════
// DATA EXPORT ROUTES
// ═══════════════════════════════════════════════════════════════════

app.get('/api/export/projects', authenticate, async (req, res) => {
  const projects = await db.getMany('SELECT * FROM projects WHERE company_id = $1', [req.user.companyId]);
  res.json(projects);
});

app.get('/api/export/plants/csv', authenticate, async (req, res) => {
  const plants = await db.getMany(
    'SELECT common_name, botanical_name, category, container_size, retail_price, sun_requirement, water_needs FROM plant_library WHERE company_id = $1 OR is_global = true',
    [req.user.companyId]
  );

  const header = 'Common Name,Botanical Name,Category,Size,Price,Sun,Water\n';
  const rows = plants.map(p => `"${p.common_name}","${p.botanical_name}","${p.category}","${p.container_size}",${p.retail_price},"${p.sun_requirement}","${p.water_needs}"`).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=plant_library.csv');
  res.send(header + rows);
});

// ═══════════════════════════════════════════════════════════════════
// AI INTEGRATION (Direct OpenAI API via filo-ai-pipeline.js)
// ═══════════════════════════════════════════════════════════════════

// Import and initialize: const { createAIHandler } = await import('./filo-ai-pipeline.js');
// const callAI = createAIHandler(db);
// Then replace all callManusAI() calls with callAI()

// For now, this wrapper delegates to the AI pipeline module.
// If OPENAI_API_KEY is not set, returns graceful fallbacks for development.

import { createAIHandler } from './filo-ai-pipeline.js';
const callAI = createAIHandler(db);

async function callManusAI(taskType, data) {
  // Legacy function name kept for compatibility — routes to direct OpenAI calls
  return callAI(taskType, data);
}

async function triggerAIJob(companyId, projectId, designId, jobType, inputData) {
  return db.getOne(
    `INSERT INTO ai_jobs (company_id, project_id, design_id, job_type, input_data, status)
     VALUES ($1, $2, $3, $4, $5, 'queued') RETURNING *`,
    [companyId, projectId, designId, jobType, inputData]
  );
}

// AI job status polling
app.get('/api/ai-jobs/:id', authenticate, async (req, res) => {
  const job = await db.getOne('SELECT * FROM ai_jobs WHERE id = $1 AND company_id = $2', [req.params.id, req.user.companyId]);
  res.json(job);
});

app.get('/api/projects/:projectId/ai-jobs', authenticate, async (req, res) => {
  const jobs = await db.getMany(
    'SELECT * FROM ai_jobs WHERE project_id = $1 ORDER BY created_at DESC',
    [req.params.projectId]
  );
  res.json(jobs);
});

// ═══════════════════════════════════════════════════════════════════
// STRIPE WEBHOOK
// ═══════════════════════════════════════════════════════════════════

async function handleStripeWebhook(req, res) {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], config.stripe.webhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Log webhook
  await db.query(
    'INSERT INTO webhook_events (source, event_type, event_id, payload) VALUES ($1, $2, $3, $4)',
    ['stripe', event.type, event.id, event.data]
  );

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        await db.query(
          `UPDATE subscriptions SET status = $1, current_period_start = to_timestamp($2), current_period_end = to_timestamp($3),
           cancel_at_period_end = $4, stripe_subscription_id = $5
           WHERE company_id = (SELECT id FROM companies WHERE stripe_customer_id = $6)`,
          [mapStripeStatus(sub.status), sub.current_period_start, sub.current_period_end, sub.cancel_at_period_end, sub.id, sub.customer]
        );
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await db.query(
          `UPDATE subscriptions SET status = 'canceled', canceled_at = NOW()
           WHERE stripe_subscription_id = $1`, [sub.id]
        );
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        await db.query(
          `UPDATE subscriptions SET status = 'past_due'
           WHERE company_id = (SELECT id FROM companies WHERE stripe_customer_id = $1)`,
          [invoice.customer]
        );
        break;
      }
      case 'invoice.paid': {
        const invoice = event.data.object;
        await db.query(
          `UPDATE subscriptions SET status = 'active'
           WHERE company_id = (SELECT id FROM companies WHERE stripe_customer_id = $1)`,
          [invoice.customer]
        );
        break;
      }
    }

    await db.query('UPDATE webhook_events SET processed = true, processed_at = NOW() WHERE event_id = $1', [event.id]);
  } catch (err) {
    console.error('Webhook processing error:', err);
    await db.query('UPDATE webhook_events SET error = $1 WHERE event_id = $2', [err.message, event.id]);
  }

  res.json({ received: true });
}

function mapStripeStatus(stripeStatus) {
  const map = { active: 'active', trialing: 'trialing', past_due: 'past_due', canceled: 'canceled', incomplete: 'past_due', unpaid: 'locked' };
  return map[stripeStatus] || 'active';
}

// ═══════════════════════════════════════════════════════════════════
// CRM INTEGRATION HELPER
// ═══════════════════════════════════════════════════════════════════

async function triggerCrmSync(companyId, entityType, entityId, action, data) {
  const integration = await db.getOne(
    'SELECT * FROM crm_integrations WHERE company_id = $1 AND is_active = true',
    [companyId]
  );
  if (!integration) return;

  await db.query(
    `INSERT INTO crm_sync_log (crm_integration_id, company_id, entity_type, entity_id, action, request_payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [integration.id, companyId, entityType, entityId, action, data]
  );

  // Async CRM push will be handled by the CRM integration module
}

// ─── Health Check ────────────────────────────────────────────────

app.get('/api/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'healthy', timestamp: new Date().toISOString(), version: '1.0.0' });
  } catch (err) {
    res.status(500).json({ status: 'unhealthy', error: err.message });
  }
});

// ─── 404 ─────────────────────────────────────────────────────────

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Error Handler ───────────────────────────────────────────────

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: config.nodeEnv === 'production' ? 'Internal server error' : err.message });
});

// ─── Start Server ────────────────────────────────────────────────

app.listen(config.port, () => {
  console.log(`🌿 FILO API server running on port ${config.port}`);
  console.log(`   Environment: ${config.nodeEnv}`);
});

export default app;
