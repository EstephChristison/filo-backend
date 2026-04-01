// ═══════════════════════════════════════════════════════════════════
// FILO — Complete Backend API Server
// Node.js + Express + PostgreSQL
// ═══════════════════════════════════════════════════════════════════

// Polyfill: OpenAI SDK v6 requires globalThis.File (Node 20+)
import { File as NodeFile } from 'node:buffer';
if (!globalThis.File) globalThis.File = NodeFile;

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
import Stripe from 'stripe';
import sharp from 'sharp';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { createAIHandler } from './filo-ai-pipeline.js';

// ─── Configuration ───────────────────────────────────────────────

const config = {
  port: process.env.PORT || 4000,
  nodeEnv: process.env.NODE_ENV || 'development',
  jwtSecret: process.env.JWT_SECRET || (process.env.NODE_ENV === 'production' ? null : 'filo-dev-secret-local-only'),
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || (process.env.NODE_ENV === 'production' ? null : 'filo-refresh-secret-local-only'),
  jwtExpiry: '2h',
  jwtRefreshExpiry: '7d',
  database: {
    connectionString: process.env.DATABASE_URL || 'postgresql://localhost:5432/filo',
    max: 20,
    idleTimeoutMillis: 30000,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    basePriceId: process.env.STRIPE_BASE_PRICE_ID,
    userPriceId: process.env.STRIPE_USER_PRICE_ID,
  },
  supabaseStorage: {
    url: process.env.SUPABASE_URL || 'https://yxgwtrbbczgffrzmjahe.supabase.co',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    bucket: 'filo-uploads',
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.GPT_MODEL || 'gpt-4o',
  },
};

// ─── Initialize Services ─────────────────────────────────────────

const pool = new pg.Pool(config.database);
const stripe = config.stripe.secretKey ? new Stripe(config.stripe.secretKey) : null;

// ─── Supabase Storage Helper ────────────────────────────────────
// Uses Supabase Storage REST API directly (no extra dependency)
const supaStorage = config.supabaseStorage.serviceRoleKey ? {
  async ensureBucket() {
    try {
      const res = await fetch(`${config.supabaseStorage.url}/storage/v1/bucket/${config.supabaseStorage.bucket}`, {
        headers: {
          'Authorization': `Bearer ${config.supabaseStorage.serviceRoleKey}`,
          'apikey': config.supabaseStorage.serviceRoleKey,
        },
      });
      if (res.status === 404) {
        await fetch(`${config.supabaseStorage.url}/storage/v1/bucket`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${config.supabaseStorage.serviceRoleKey}`,
            'apikey': config.supabaseStorage.serviceRoleKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            id: config.supabaseStorage.bucket,
            name: config.supabaseStorage.bucket,
            public: true,
            file_size_limit: 26214400, // 25MB
            allowed_mime_types: ['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf', 'text/csv'],
          }),
        });
        console.log('✅ Created Supabase Storage bucket: filo-uploads');
      } else {
        console.log('✅ Supabase Storage bucket exists: filo-uploads');
      }
    } catch (err) {
      console.error('⚠️  Could not verify Supabase Storage bucket:', err.message);
    }
  },

  async upload(path, buffer, contentType) {
    const res = await fetch(`${config.supabaseStorage.url}/storage/v1/object/${config.supabaseStorage.bucket}/${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.supabaseStorage.serviceRoleKey}`,
        'apikey': config.supabaseStorage.serviceRoleKey,
        'Content-Type': contentType,
        'x-upsert': 'true',
      },
      body: buffer,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(`Supabase Storage upload failed: ${err.error || err.message || res.status}`);
    }
    return res.json();
  },

  getPublicUrl(path) {
    return `${config.supabaseStorage.url}/storage/v1/object/public/${config.supabaseStorage.bucket}/${path}`;
  },

  async createSignedUploadUrl(path) {
    const res = await fetch(`${config.supabaseStorage.url}/storage/v1/object/upload/sign/${config.supabaseStorage.bucket}/${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.supabaseStorage.serviceRoleKey}`,
        'apikey': config.supabaseStorage.serviceRoleKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error('Failed to create signed upload URL');
    const data = await res.json();
    return `${config.supabaseStorage.url}/storage/v1${data.url}`;
  },
} : null;

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

// ─── Input Sanitization ──────────────────────────────────────────
// Strips HTML tags from string inputs to prevent stored XSS.
// Applied at all user-facing string boundaries.
function stripHtml(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/<[^>]*>/g, '').trim();
}

// Sanitize a filename for use in storage key paths — strips path traversal sequences
// and characters that could escape the intended directory prefix.
function sanitizeFilename(name) {
  if (typeof name !== 'string') return 'upload';
  return name
    .replace(/\.\.[/\\]/g, '')   // strip ../ and ..\
    .replace(/[/\\]/g, '_')      // replace remaining slashes
    .replace(/[^a-zA-Z0-9._\-]/g, '_') // allow only safe chars
    .substring(0, 200) || 'upload';
}

// ─── User Response Formatter ────────────────────────────────────
// Issue 4 fix: Ensure consistent camelCase user object across all auth endpoints
function formatUserResponse(user) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.first_name || user.firstName || null,
    lastName: user.last_name || user.lastName || null,
    role: user.role,
    companyId: user.company_id || user.companyId,
    companyName: user.company_name || user.companyName || null,
    onboardingCompleted: user.onboarding_completed ?? user.onboardingCompleted ?? false,
    phone: user.phone || null,
  };
}

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
app.set('trust proxy', 1); // Trust Railway's reverse proxy for rate limiting + real IPs

// Stripe webhook needs raw body — must come before json parser
app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);

app.use(helmet());
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'https://app.myfilocrm.com',
    'https://myfilocrm.com',
    'https://filo-app-five.vercel.app',
    'http://localhost:3000',
    'http://localhost:5173',
  ],
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined'));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });
app.use('/api/', limiter);

// Validate all UUID route params before hitting the DB (prevents 502 on bad UUIDs)
registerUUIDParamValidation(app);

// Stricter rate limit on auth endpoints to prevent brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts. Please wait 15 minutes and try again.' },
});

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
  try {
    const sub = await db.getOne(
      `SELECT status FROM subscriptions WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [req.user.companyId]
    );
    // Allow if active, trialing, OR no subscription yet (new trial signups before Stripe is wired)
    if (sub && !['active', 'trialing'].includes(sub.status)) {
      return res.status(403).json({ error: 'Active subscription required. Your account is locked.', code: 'SUBSCRIPTION_LOCKED' });
    }
    next();
  } catch (err) {
    console.error('[requireActiveSubscription] DB error:', err.message);
    next(); // Fail open — don't lock out users due to DB issues
  }
}

// ─── UUID Validation Middleware ───────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateUUID(...paramNames) {
  return (req, res, next) => {
    for (const name of paramNames) {
      const val = req.params[name];
      if (val && !UUID_RE.test(val)) {
        return res.status(400).json({ error: `Invalid ${name}: must be a valid UUID` });
      }
    }
    next();
  };
}

// Applied after app is created — validates all :id, :lineItemId route params
// This prevents PostgreSQL UUID cast errors from causing 502s
function registerUUIDParamValidation(app) {
  for (const param of ['id', 'lineItemId', 'fileId', 'projectId', 'clientId', 'companyId', 'userId']) {
    app.param(param, (req, res, next, val) => {
      if (!UUID_RE.test(val)) {
        return res.status(400).json({ error: `Invalid ${param}: must be a valid UUID` });
      }
      next();
    });
  }
}

// Activity logger — fire-and-forget, never crashes the calling route
async function logActivity(companyId, userId, entityType, entityId, action, description, metadata = {}) {
  try {
    await db.query(
      `INSERT INTO activity_log (company_id, user_id, entity_type, entity_id, action, description, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [companyId, userId, entityType, entityId, action, description, JSON.stringify(metadata)]
    );
  } catch (err) {
    console.error('[logActivity] Failed (non-fatal):', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════════════

// ─── Register Company ────────────────────────────────────────────
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const rawBody = req.body;
    const companyName = stripHtml(rawBody.companyName);
    const email = (rawBody.email || '').trim().toLowerCase();
    const password = rawBody.password || '';
    const firstName = stripHtml(rawBody.firstName);
    const lastName = stripHtml(rawBody.lastName);
    const phone = stripHtml(rawBody.phone);

    if (!companyName || !email || !password || !firstName || !lastName) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!EMAIL_RE.test(email) || email.length > 254) {
      return res.status(400).json({ error: 'Invalid email address' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    if (companyName.length > 255 || firstName.length > 100 || lastName.length > 100) {
      return res.status(400).json({ error: 'One or more fields exceed maximum length' });
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

    // Issue 4 fix: Return consistent user object shape
    res.status(201).json({ token, refreshToken, user: formatUserResponse({
      id: result.userId, email, first_name: firstName, last_name: lastName,
      role: result.role, company_id: result.companyId, company_name: companyName,
      onboarding_completed: false, phone,
    }) });
  } catch (err) {
    console.error('Register error:', err);
    if (err.code === '22001') return res.status(400).json({ error: 'One or more fields exceed maximum length' });
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ─── Login ───────────────────────────────────────────────────────
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
    if (typeof email !== 'string' || email.length > 320) return res.status(400).json({ error: 'Invalid email' });

    const user = await db.getOne(
      `SELECT u.*, c.name as company_name, c.onboarding_completed FROM users u JOIN companies c ON c.id = u.company_id WHERE u.email = $1`,
      [email]
    );
    if (!user) {
      // Constant-time dummy comparison to prevent email enumeration via timing
      await bcrypt.compare(password, '$2b$12$notarealhashXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
      return res.status(401).json({ error: 'Invalid credentials' });
    }
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
    // Clean up expired/revoked tokens before inserting new one (prevents unbounded growth)
    await db.query('DELETE FROM refresh_tokens WHERE user_id = $1 AND (expires_at < NOW() OR revoked = true)', [user.id]);
    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [user.id, tokenHash]
    );

    await db.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
    await logActivity(user.company_id, user.id, 'user', user.id, 'login', 'User logged in');

    // Issue 4 fix: Use consistent formatUserResponse helper
    res.json({ token, refreshToken, user: formatUserResponse(user) });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─── Refresh Token ───────────────────────────────────────────────
app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken || typeof refreshToken !== 'string') {
      return res.status(400).json({ error: 'Refresh token required' });
    }
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
  try {
    await db.query('UPDATE refresh_tokens SET revoked = true WHERE user_id = $1', [req.user.userId]);
    res.json({ message: 'Logged out' });
  } catch (err) {
    // Still report success — client should clear tokens regardless
    console.error('[logout] DB error (non-fatal):', err.message);
    res.json({ message: 'Logged out' });
  }
});

// ─── Invite User ─────────────────────────────────────────────────
app.post('/api/auth/invite', authenticate, requireAdmin, async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    const firstName = stripHtml(req.body.firstName);
    const lastName = stripHtml(req.body.lastName);
    const role = req.body.role;
    if (!email || !firstName || !lastName) return res.status(400).json({ error: 'email, firstName, and lastName are required' });
    const inviteToken = uuidv4();
    const tempPassword = await bcrypt.hash(uuidv4(), 12);

    await db.query(
      `INSERT INTO users (company_id, email, password_hash, first_name, last_name, role, invite_token, invite_expires)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '7 days') RETURNING id`,
      [req.user.companyId, email, tempPassword, firstName, lastName, role || 'estimator', inviteToken]
    );

    const inviteLink = `${process.env.FRONTEND_URL || 'https://app.myfilocrm.com'}/invite/${inviteToken}`;
    res.status(201).json({ message: 'Invite created. Share the link with the user.', inviteToken, inviteLink });
  } catch (err) {
    console.error('Invite error:', err);
    res.status(500).json({ error: 'Failed to invite user' });
  }
});

// ─── Accept Invite ───────────────────────────────────────────────
app.post('/api/auth/accept-invite', async (req, res) => {
  try {
    const { inviteToken, password } = req.body;
    if (!inviteToken || !password) return res.status(400).json({ error: 'inviteToken and password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const user = await db.getOne(
      `SELECT * FROM users WHERE invite_token = $1 AND invite_expires > NOW() AND is_active = true`,
      [inviteToken]
    );
    if (!user) return res.status(400).json({ error: 'Invalid or expired invite link' });

    const passwordHash = await bcrypt.hash(password, 12);
    const updated = await db.getOne(
      `UPDATE users SET password_hash = $1, invite_token = NULL, invite_expires = NULL WHERE id = $2 RETURNING id, company_id, role`,
      [passwordHash, user.id]
    );

    const token = jwt.sign(
      { userId: updated.id, companyId: updated.company_id, role: updated.role },
      config.jwtSecret, { expiresIn: config.jwtExpiry }
    );
    const refreshToken = jwt.sign(
      { userId: updated.id }, config.jwtRefreshSecret, { expiresIn: config.jwtRefreshExpiry }
    );
    const tokenHash = await bcrypt.hash(refreshToken, 10);
    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [updated.id, tokenHash]
    );

    await logActivity(updated.company_id, updated.id, 'user', updated.id, 'invite_accepted', 'User accepted invite and set password');
    // Issue 4 fix: Use consistent formatUserResponse
    const fullUser = await db.getOne(
      `SELECT u.*, c.name as company_name, c.onboarding_completed FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = $1`,
      [updated.id]
    );
    res.json({ token, refreshToken, user: formatUserResponse(fullUser || { id: updated.id, company_id: updated.company_id, role: updated.role }) });
  } catch (err) {
    console.error('Accept invite error:', err);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

// ─── Forgot Password (Request Reset) ────────────────────────────
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  try {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ error: 'Email is required' });

    // Always return success to prevent email enumeration
    const user = await db.getOne('SELECT id, email FROM users WHERE email = $1', [email]);
    if (user) {
      const crypto = await import('crypto');
      const token = crypto.randomUUID();
      const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      await db.query(
        'UPDATE users SET recovery_token = $1, recovery_sent_at = $2 WHERE id = $3',
        [token, expires, user.id]
      );
      // TODO: Send actual email when email provider is configured
      console.log(`[PASSWORD RESET] Token for ${email}: ${token} (expires ${expires.toISOString()})`);
    }
    res.json({ message: 'If an account with that email exists, a reset link has been sent.' });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// ─── Admin password reset (temporary — remove after use) ────────
app.post('/api/auth/admin-reset', async (req, res) => {
  try {
    const { email, password, secret } = req.body;
    if (secret !== 'filo-temp-reset-2026') return res.status(403).json({ error: 'Forbidden' });
    const hash = await bcrypt.hash(password, 12);
    const result = await db.query(
      'UPDATE users SET password_hash = $1 WHERE email = $2 RETURNING id, email',
      [hash, email]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'Password reset', user: result.rows[0].email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Reset Password (with token) ───────────────────────────────
app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and new password are required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const user = await db.getOne(
      'SELECT id, email FROM users WHERE recovery_token = $1 AND recovery_sent_at > NOW()',
      [token]
    );
    if (!user) return res.status(400).json({ error: 'Invalid or expired reset token' });

    const hash = await bcrypt.hash(password, 12);
    await db.query(
      'UPDATE users SET password_hash = $1, recovery_token = NULL, recovery_sent_at = NULL WHERE id = $2',
      [hash, user.id]
    );
    // Revoke all refresh tokens for security
    await db.query('UPDATE refresh_tokens SET revoked = true WHERE user_id = $1', [user.id]);

    res.json({ message: 'Password has been reset. You can now sign in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ─── Forgot Email (Lookup by name/phone) ────────────────────────
app.post('/api/auth/forgot-email', authLimiter, async (req, res) => {
  try {
    const firstName = stripHtml((req.body.firstName || '').trim());
    const lastName = stripHtml((req.body.lastName || '').trim());
    const phone = stripHtml((req.body.phone || '').trim());

    if (!firstName && !lastName && !phone) {
      return res.status(400).json({ error: 'Provide your name or phone number' });
    }

    let query = 'SELECT email FROM users WHERE 1=1';
    const params = [];
    if (firstName) { params.push(firstName.toLowerCase()); query += ` AND LOWER(first_name) = $${params.length}`; }
    if (lastName) { params.push(lastName.toLowerCase()); query += ` AND LOWER(last_name) = $${params.length}`; }
    if (phone) { params.push(phone.replace(/\D/g, '')); query += ` AND REPLACE(phone, '-', '') LIKE '%' || $${params.length} || '%'`; }

    const users = await db.getMany(query, params);
    if (users.length === 0) {
      return res.json({ maskedEmails: [], message: 'No accounts found matching that information.' });
    }

    // Mask emails: show first char, last char before @, domain first char, TLD
    const maskedEmails = users.map(u => {
      const [local, domain] = u.email.split('@');
      const maskedLocal = local.length <= 2
        ? local[0] + '***'
        : local[0] + '***' + local[local.length - 1];
      const domParts = domain.split('.');
      const maskedDomain = domParts[0][0] + '***' + '.' + domParts.slice(1).join('.');
      return maskedLocal + '@' + maskedDomain;
    });

    res.json({ maskedEmails, message: `Found ${maskedEmails.length} account(s) matching your info.` });
  } catch (err) {
    console.error('Forgot email error:', err);
    res.status(500).json({ error: 'Failed to look up account' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// COMPANY ROUTES
// ═══════════════════════════════════════════════════════════════════

app.get('/api/company', authenticate, async (req, res) => {
  try {
    const company = await db.getOne('SELECT * FROM companies WHERE id = $1', [req.user.companyId]);
    if (!company) return res.status(404).json({ error: 'Company not found' });
    res.json(company);
  } catch (err) {
    console.error('GET /api/company error:', err.message);
    res.status(500).json({ error: 'Failed to load company' });
  }
});

app.put('/api/company', authenticate, requireAdmin, async (req, res) => {
  try {
    const fields = req.body;

    // --- Issue 5 fix: Map frontend "address" to DB column "address_line1" ---
    if (fields.address !== undefined && fields.address_line1 === undefined) {
      fields.address_line1 = fields.address;
      delete fields.address;
    }

    const allowed = [
      'name', 'phone', 'email', 'website', 'address_line1', 'address_line2',
      'city', 'state', 'zip', 'country', 'license_number', 'timezone',
      'latitude', 'longitude', 'usda_zone', 'default_design_style',
      'labor_pricing_method', 'material_markup_pct', 'delivery_fee',
      'soil_amendment_per_cy', 'mulch_per_cy', 'edging_per_lf', 'removal_base_fee',
      'irrigation_hourly_rate', 'labor_rate_per_gallon', 'labor_rate_per_hour',
      'labor_lump_default', 'tax_enabled', 'tax_rate', 'default_terms', 'warranty_terms',
    ];

    // Sanitize enum fields — lowercase or null for empty strings
    const ENUM_FIELDS = ['default_design_style', 'labor_pricing_method'];
    for (const key of ENUM_FIELDS) {
      if (fields[key] !== undefined) {
        if (typeof fields[key] === 'string' && fields[key].trim() === '') {
          delete fields[key]; // Don't send empty strings to enum columns
        } else if (typeof fields[key] === 'string') {
          fields[key] = fields[key].toLowerCase();
        }
      }
    }

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
  } catch (err) {
    console.error('PUT /api/company error:', err.message);
    if (err.code === '22001') return res.status(400).json({ error: 'One or more fields exceed maximum length' });
    res.status(500).json({ error: 'Failed to update company' });
  }
});

app.put('/api/company/onboarding', authenticate, requireAdmin, async (req, res) => {
  try {
    await db.query('UPDATE companies SET onboarding_completed = true WHERE id = $1', [req.user.companyId]);
    res.json({ message: 'Onboarding completed', onboardingCompleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Issue 5 fix: Add POST /api/onboarding/complete as an alternative endpoint ---
app.post('/api/onboarding/complete', authenticate, async (req, res) => {
  try {
    await db.query('UPDATE companies SET onboarding_completed = true WHERE id = $1', [req.user.companyId]);
    res.json({ message: 'Onboarding completed', onboardingCompleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// CLIENT ROUTES
// ═══════════════════════════════════════════════════════════════════

app.get('/api/clients', authenticate, requireActiveSubscription, async (req, res) => {
  try {
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

    // Count query must mirror the same search filter to produce accurate pagination totals
    let countQuery = 'SELECT COUNT(*) FROM clients WHERE company_id = $1';
    const countParams = [req.user.companyId];
    if (search) {
      countQuery += ` AND (display_name ILIKE $2 OR email ILIKE $2 OR phone ILIKE $2)`;
      countParams.push(`%${search}%`);
    }
    const countResult = await db.getOne(countQuery, countParams);

    res.json({ clients, total: parseInt(countResult.count), page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error('GET /api/clients error:', err.message);
    res.status(500).json({ error: 'Failed to load clients' });
  }
});

app.post('/api/clients', authenticate, requireActiveSubscription, async (req, res) => {
  try {
    const b = req.body;

    // --- Issue 1 fix: Require at least one identifying field ---
    const rawFirstName = (b.firstName || '').trim();
    const rawLastName = (b.lastName || '').trim();
    const rawCompanyName = (b.companyName || '').trim();
    const rawName = (b.name || '').trim();
    if (!rawFirstName && !rawLastName && !rawCompanyName && !rawName) {
      return res.status(400).json({ error: 'At least one of firstName, lastName, or companyName is required' });
    }

    // Accept both frontend shorthand (name/address) and full field names
    const firstName = stripHtml(rawFirstName || (rawName ? rawName.split(' ')[0] : null));
    const lastName = stripHtml(rawLastName || (rawName && rawName.split(' ').length > 1 ? rawName.split(' ').slice(1).join(' ') : null));
    const email = b.email ? b.email.trim().toLowerCase() : null;
    const phone = b.phone || null;
    const addressLine1 = stripHtml(b.addressLine1 || b.address || null);
    const city = stripHtml(b.city || null);
    const state = stripHtml(b.state || null);
    const zip = b.zip || null;
    const notes = stripHtml(b.notes || null);

    // --- Issue 2 fix: Build display_name from actual data ---
    let displayName;
    if (firstName && lastName) {
      displayName = `${firstName} ${lastName}`;
    } else if (firstName) {
      displayName = firstName;
    } else if (lastName) {
      displayName = lastName;
    } else if (rawCompanyName) {
      displayName = stripHtml(rawCompanyName);
    } else if (email) {
      displayName = email;
    } else {
      displayName = 'Unnamed Client'; // Should never reach here due to validation above
    }

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
  try {
    const client = await db.getOne('SELECT * FROM clients WHERE id = $1 AND company_id = $2', [req.params.id, req.user.companyId]);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json(client);
  } catch (err) {
    console.error('GET /api/clients/:id error:', err.message);
    res.status(500).json({ error: 'Failed to load client' });
  }
});

app.put('/api/clients/:id', authenticate, async (req, res) => {
  try {
    const fields = req.body;
    const allowed = ['display_name', 'first_name', 'last_name', 'email', 'phone', 'address_line1', 'address_line2', 'city', 'state', 'zip', 'notes'];
    const updates = [], values = [];
    let idx = 1;
    for (const key of allowed) {
      if (fields[key] !== undefined) { updates.push(`${key} = $${idx}`); values.push(fields[key]); idx++; }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
    values.push(req.params.id, req.user.companyId);
    const client = await db.getOne(`UPDATE clients SET ${updates.join(', ')} WHERE id = $${idx} AND company_id = $${idx + 1} RETURNING *`, values);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    res.json(client);
  } catch (err) {
    console.error('PUT /api/clients/:id error:', err.message);
    if (err.code === '22001') return res.status(400).json({ error: 'One or more fields exceed maximum length' });
    res.status(500).json({ error: 'Failed to update client' });
  }
});

app.delete('/api/clients/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await db.query('DELETE FROM clients WHERE id = $1 AND company_id = $2', [req.params.id, req.user.companyId]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Client not found' });
    res.json({ message: 'Client deleted' });
  } catch (err) {
    console.error('DELETE /api/clients/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete client' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// PROJECT ROUTES
// ═══════════════════════════════════════════════════════════════════

app.get('/api/projects', authenticate, requireActiveSubscription, async (req, res) => {
  try {
    const { status, clientId, page = 1, limit = 50 } = req.query;
    let query = 'SELECT * FROM v_active_projects WHERE company_id = $1';
    const params = [req.user.companyId];

    if (status) { params.push(status); query += ` AND status = $${params.length}`; }
    if (clientId) { params.push(clientId); query += ` AND client_id = $${params.length}`; }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, (page - 1) * limit);

    const projects = await db.getMany(query, params);
    res.json({ projects });
  } catch (err) {
    console.error('GET /api/projects error:', err.message);
    res.status(500).json({ error: 'Failed to load projects' });
  }
});

app.post('/api/projects', authenticate, requireActiveSubscription, async (req, res) => {
  try {
    const b = req.body;
    // Accept both camelCase and snake_case field names from frontend
    const clientId = b.clientId || b.client_id;
    const name = b.name;
    const areas = b.areas;
    const sunExposure = b.sunExposure || b.sun_exposure || null;
    const designStyle = b.designStyle || b.design_style || null;
    const specialRequests = b.specialRequests || b.special_requests || null;
    const lightingRequested = b.lightingRequested || b.lighting_requested || false;
    const lightingTypes = b.lightingTypes || b.lighting_types || null;
    const hardscapeChanges = b.hardscapeChanges || b.hardscape_changes || null;
    const hardscapeNotes = b.hardscapeNotes || b.hardscape_notes || null;

    if (!clientId) return res.status(400).json({ error: 'client_id is required' });
    if (!UUID_RE.test(clientId)) return res.status(400).json({ error: 'Invalid clientId: must be a valid UUID' });

    // Sanitize enum fields — same maps as PUT /api/projects/:id
    const DESIGN_STYLE_MAP = {
      'formal': 'formal', 'formal / symmetrical': 'formal', 'formal_symmetrical': 'formal',
      'naturalistic': 'naturalistic', 'naturalistic / cottage': 'naturalistic', 'naturalistic_cottage': 'naturalistic',
      'modern': 'modern', 'modern / minimalist': 'modern', 'modern_minimalist': 'modern',
      'tropical': 'tropical',
      'xeriscape': 'xeriscape', 'desert / xeriscape': 'xeriscape', 'desert_xeriscape': 'xeriscape',
      'contemporary': 'modern',
    };
    const SUN_EXPOSURE_MAP = {
      'full_sun': 'full_sun', 'full sun': 'full_sun',
      'partial_shade': 'partial_shade', 'partial shade': 'partial_shade',
      'full_shade': 'full_shade', 'full shade': 'full_shade',
    };
    const rawStyle = designStyle?.toLowerCase().trim();
    const mappedStyle = rawStyle ? (DESIGN_STYLE_MAP[rawStyle] || rawStyle.split(/[\s\/]+/)[0] || null) : null;
    const rawSun = sunExposure?.toLowerCase().trim();
    const mappedSun = rawSun ? (SUN_EXPOSURE_MAP[rawSun] || rawSun.replace(/\s+/g, '_') || null) : null;

    const project = await db.transaction(async (client) => {
      // Create project
      const proj = await client.query(
        `INSERT INTO projects (company_id, client_id, created_by, name, status, sun_exposure, design_style, special_requests, lighting_requested, lighting_types, hardscape_changes, hardscape_notes)
         VALUES ($1, $2, $3, $4, 'photo_upload', $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [req.user.companyId, clientId, req.user.userId, name, mappedSun, mappedStyle, specialRequests, lightingRequested, lightingTypes, hardscapeChanges, hardscapeNotes]
      );

      // Create property areas
      if (areas?.length) {
        const AREA_TYPE_MAP = {
          'front_yard': 'front_yard', 'front yard': 'front_yard', 'front': 'front_yard',
          'back_yard': 'back_yard', 'back yard': 'back_yard', 'back': 'back_yard', 'backyard': 'back_yard',
          'side_yard_left': 'side_yard_left', 'side yard left': 'side_yard_left', 'side_yard': 'side_yard_left',
          'side_yard_right': 'side_yard_right', 'side yard right': 'side_yard_right',
          'left': 'side_yard_left', 'right': 'side_yard_right',
        };
        for (let i = 0; i < areas.length; i++) {
          const rawAreaType = (areas[i].area_type || areas[i].type || 'custom').toLowerCase().trim();
          const mappedAreaType = AREA_TYPE_MAP[rawAreaType] || 'custom';
          await client.query(
            `INSERT INTO property_areas (project_id, area_type, custom_name, sort_order) VALUES ($1, $2, $3, $4)`,
            [proj.rows[0].id, mappedAreaType, areas[i].name, i]
          );
        }
      }

      return proj.rows[0];
    });

    await logActivity(req.user.companyId, req.user.userId, 'project', project.id, 'create', `Project "${project.name || project.id}" created`);
    res.status(201).json(project);
  } catch (err) {
    console.error('Create project error:', err);
    res.status(500).json({ error: 'Failed to create project' });
  }
});

app.get('/api/projects/:id', authenticate, async (req, res) => {
  try {
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
  } catch (err) {
    console.error('GET /api/projects/:id error:', err.message);
    res.status(500).json({ error: 'Failed to load project' });
  }
});

app.put('/api/projects/:id', authenticate, async (req, res) => {
  try {
    const fields = req.body;
    // Sanitize enum fields — DB expects exact enum values
    const DESIGN_STYLE_MAP = {
      'formal': 'formal', 'formal / symmetrical': 'formal', 'formal_symmetrical': 'formal',
      'naturalistic': 'naturalistic', 'naturalistic / cottage': 'naturalistic', 'naturalistic_cottage': 'naturalistic',
      'modern': 'modern', 'modern / minimalist': 'modern', 'modern_minimalist': 'modern',
      'tropical': 'tropical',
      'xeriscape': 'xeriscape', 'desert / xeriscape': 'xeriscape', 'desert_xeriscape': 'xeriscape',
    };
    const SUN_EXPOSURE_MAP = {
      'full_sun': 'full_sun', 'full sun': 'full_sun',
      'partial_shade': 'partial_shade', 'partial shade': 'partial_shade',
      'full_shade': 'full_shade', 'full shade': 'full_shade',
    };
    if (fields.design_style !== undefined && typeof fields.design_style === 'string') {
      const mapped = DESIGN_STYLE_MAP[fields.design_style.toLowerCase().trim()];
      if (mapped) fields.design_style = mapped;
      else if (fields.design_style.trim() === '') delete fields.design_style;
      else fields.design_style = fields.design_style.toLowerCase().split(/[\s\/]+/)[0]; // fallback: first word
    }
    if (fields.sun_exposure !== undefined && typeof fields.sun_exposure === 'string') {
      const mapped = SUN_EXPOSURE_MAP[fields.sun_exposure.toLowerCase().trim()];
      if (mapped) fields.sun_exposure = mapped;
      else if (fields.sun_exposure.trim() === '') delete fields.sun_exposure;
      else fields.sun_exposure = fields.sun_exposure.toLowerCase().replace(/\s+/g, '_');
    }
    const allowed = ['name', 'status', 'sun_exposure', 'design_style', 'special_requests', 'lighting_requested', 'lighting_types', 'hardscape_changes', 'hardscape_notes'];
    const updates = [], values = [];
    let idx = 1;
    for (const key of allowed) {
      if (fields[key] !== undefined) { updates.push(`${key} = $${idx}`); values.push(fields[key]); idx++; }
    }
    if (updates.length === 0) return res.json({ message: 'No fields to update' });
    values.push(req.params.id, req.user.companyId);
    const project = await db.getOne(`UPDATE projects SET ${updates.join(', ')} WHERE id = $${idx} AND company_id = $${idx + 1} RETURNING *`, values);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json(project);
  } catch (err) {
    console.error('PUT /api/projects/:id error:', err.message);
    if (err.code === '22001') return res.status(400).json({ error: 'One or more fields exceed maximum length' });
    res.status(500).json({ error: 'Failed to update project' });
  }
});

app.put('/api/projects/:id/status', authenticate, async (req, res) => {
  try {
    const { status } = req.body;
    const VALID_STATUSES = ['draft', 'photo_upload', 'plant_detection', 'design_questionnaire',
      'design_generation', 'design_review', 'estimate_pending', 'estimate_approved',
      'submittal_sent', 'completed', 'archived'];
    if (!status || !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
    }
    const project = await db.getOne(
      'UPDATE projects SET status = $1 WHERE id = $2 AND company_id = $3 RETURNING *',
      [status, req.params.id, req.user.companyId]
    );
    if (!project) return res.status(404).json({ error: 'Project not found' });
    await logActivity(req.user.companyId, req.user.userId, 'project', project.id, 'status_change', `Status changed to ${status}`);
    res.json(project);
  } catch (err) {
    console.error('PUT /api/projects/:id/status error:', err.message);
    res.status(500).json({ error: 'Failed to update project status' });
  }
});

// ─── Property Areas ──────────────────────────────────────────────

app.get('/api/projects/:projectId/areas', authenticate, async (req, res) => {
  try {
    // Verify project belongs to this company before returning areas
    const project = await db.getOne('SELECT id FROM projects WHERE id = $1 AND company_id = $2', [req.params.projectId, req.user.companyId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const areas = await db.getMany(
      'SELECT * FROM property_areas WHERE project_id = $1 ORDER BY sort_order',
      [req.params.projectId]
    );
    res.json(areas);
  } catch (err) {
    console.error('GET /api/projects/:projectId/areas error:', err.message);
    res.status(500).json({ error: 'Failed to load areas' });
  }
});

app.post('/api/projects/:projectId/areas', authenticate, async (req, res) => {
  try {
    // Verify project belongs to this company
    const project = await db.getOne('SELECT id FROM projects WHERE id = $1 AND company_id = $2', [req.params.projectId, req.user.companyId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const b = req.body;
    const rawType = (b.areaType || b.area_type || 'custom').toLowerCase().trim();

    // Map any variation to valid enum: front_yard | back_yard | side_yard_left | side_yard_right | custom
    const AREA_TYPE_MAP = {
      'front_yard': 'front_yard', 'front yard': 'front_yard', 'front': 'front_yard',
      'back_yard': 'back_yard', 'back yard': 'back_yard', 'back': 'back_yard',
      'side_yard_left': 'side_yard_left', 'side yard left': 'side_yard_left', 'side_yard': 'side_yard_left',
      'side_yard_right': 'side_yard_right', 'side yard right': 'side_yard_right',
      'left': 'side_yard_left', 'right': 'side_yard_right',
    };
    const areaType = AREA_TYPE_MAP[rawType] || 'custom';
    const customName = b.customName || b.name || b.custom_name || rawType;

    const area = await db.getOne(
      `INSERT INTO property_areas (project_id, area_type, custom_name) VALUES ($1, $2, $3) RETURNING *`,
      [req.params.projectId, areaType, customName]
    );
    res.status(201).json(area);
  } catch (err) {
    console.error('Create area error:', err);
    res.status(500).json({ error: 'Failed to create area' });
  }
});

// ─── Existing Plants Detection ───────────────────────────────────

app.get('/api/areas/:areaId/existing-plants', authenticate, async (req, res) => {
  try {
    // Verify the area belongs to this company via project ownership
    const area = await db.getOne(
      `SELECT pa.id FROM property_areas pa
       JOIN projects p ON p.id = pa.project_id
       WHERE pa.id = $1 AND p.company_id = $2`,
      [req.params.areaId, req.user.companyId]
    );
    if (!area) return res.status(404).json({ error: 'Area not found' });
    const plants = await db.getMany(
      'SELECT * FROM existing_plants WHERE property_area_id = $1 ORDER BY position_x',
      [req.params.areaId]
    );
    res.json(plants);
  } catch (err) {
    console.error('GET /api/areas/:areaId/existing-plants error:', err.message);
    res.status(500).json({ error: 'Failed to load plants' });
  }
});

// Manually add an existing plant
app.post('/api/areas/:areaId/existing-plants', authenticate, async (req, res) => {
  try {
    // Verify area ownership
    const area = await db.getOne(
      `SELECT pa.id FROM property_areas pa
       JOIN projects p ON p.id = pa.project_id
       WHERE pa.id = $1 AND p.company_id = $2`,
      [req.params.areaId, req.user.companyId]
    );
    if (!area) return res.status(404).json({ error: 'Area not found' });
    const { name, mark, position_x, position_y, comment } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Plant name is required' });
    const plant = await db.getOne(
      `INSERT INTO existing_plants (property_area_id, identified_name, confidence, position_x, position_y, mark, comment)
       VALUES ($1, $2, 1.0, $3, $4, $5, $6) RETURNING *`,
      [req.params.areaId, name.trim(), position_x || 0.5, position_y || 0.5, mark || 'keep', comment || 'Manually added']
    );
    res.status(201).json(plant);
  } catch (err) {
    console.error('Manual plant add error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete an existing plant
app.delete('/api/existing-plants/:id', authenticate, async (req, res) => {
  try {
    // Verify ownership before deleting
    const owned = await db.getOne(
      `SELECT ep.id FROM existing_plants ep
       JOIN property_areas pa ON pa.id = ep.property_area_id
       JOIN projects p ON p.id = pa.project_id
       WHERE ep.id = $1 AND p.company_id = $2`,
      [req.params.id, req.user.companyId]
    );
    if (!owned) return res.status(404).json({ error: 'Plant not found' });
    await db.query('DELETE FROM existing_plants WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE /api/existing-plants/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete plant' });
  }
});

app.put('/api/existing-plants/:id/mark', authenticate, async (req, res) => {
  try {
    const { mark, comment, rename } = req.body;
    if (!mark || !['keep', 'remove'].includes(mark)) {
      return res.status(400).json({ error: "mark must be 'keep' or 'remove'" });
    }
    // Verify ownership: plant must belong to an area in a project owned by this company
    const owned = await db.getOne(
      `SELECT ep.id FROM existing_plants ep
       JOIN property_areas pa ON pa.id = ep.property_area_id
       JOIN projects p ON p.id = pa.project_id
       WHERE ep.id = $1 AND p.company_id = $2`,
      [req.params.id, req.user.companyId]
    );
    if (!owned) return res.status(404).json({ error: 'Plant not found' });

    let plant;
    if (rename && rename.trim()) {
      plant = await db.getOne(
        'UPDATE existing_plants SET mark = $1, identified_name = $2 WHERE id = $3 RETURNING *',
        [mark, rename.trim(), req.params.id]
      );
    } else {
      plant = await db.getOne(
        'UPDATE existing_plants SET mark = $1, comment = $2 WHERE id = $3 RETURNING *',
        [mark, comment || '', req.params.id]
      );
    }
    res.json(plant);
  } catch (err) {
    console.error('PUT /api/existing-plants/:id/mark error:', err.message);
    res.status(500).json({ error: 'Failed to update plant mark' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ─── Removal Preview (Gemini primary, gpt-image-1 fallback — removes plants from photo) ─
app.post('/api/removal-preview', authenticate, async (req, res) => {
  try {
    if (!googleAI && !openaiClient) return res.status(503).json({ error: 'AI service not configured' });
    const { photoUrl, maskDataUrl } = req.body;
    if (!photoUrl) return res.status(400).json({ error: 'photoUrl is required' });
    if (!maskDataUrl) return res.status(400).json({ error: 'Draw on the photo first to mark areas for removal' });

    // SSRF protection — only allow Supabase Storage URLs or data URLs
    const allowedHosts = [
      config.supabaseStorage.url.replace(/^https?:\/\//, ''),
      'yxgwtrbbczgffrzmjahe.supabase.co',
    ];
    if (!photoUrl.startsWith('data:')) {
      try {
        const parsedUrl = new URL(photoUrl);
        const isAllowed = allowedHosts.some(h => parsedUrl.hostname === h || parsedUrl.hostname.endsWith('.' + h));
        if (!isAllowed) return res.status(400).json({ error: 'photoUrl must be a Supabase Storage URL' });
      } catch {
        return res.status(400).json({ error: 'Invalid photoUrl' });
      }
    }

    console.log('[removal-preview] Downloading original photo...');
    let photoBuffer;
    if (photoUrl.startsWith('data:')) {
      const b64 = photoUrl.replace(/^data:image\/[^;]+;base64,/, '');
      photoBuffer = Buffer.from(b64, 'base64');
    } else {
      const photoResponse = await fetch(photoUrl);
      if (!photoResponse.ok) throw new Error(`Failed to download photo: ${photoResponse.status}`);
      photoBuffer = Buffer.from(await photoResponse.arrayBuffer());
    }

    const metadata = await sharp(photoBuffer).metadata();
    const origW = metadata.width;
    const origH = metadata.height;

    const removalPrompt = 'Remove the marked/highlighted plants from this landscape photo. Fill the areas where plants were removed with what would realistically be behind them — continue the surrounding materials like brick, siding, mulch, soil, or grass seamlessly. Match the exact color temperature, shadow direction, and surface texture. Preserve everything else in the photo exactly as it is.';

    let resultBuffer;

    // Try Gemini first
    if (googleAI) {
      console.log('[removal-preview] Calling Gemini for plant removal...');
      try {
        const resizedBuffer = await sharp(photoBuffer)
          .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();

        // Also send the mask as a second image for context
        const maskB64 = maskDataUrl.replace(/^data:image\/png;base64,/, '');
        const maskResized = await sharp(Buffer.from(maskB64, 'base64'))
          .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();

        const response = await googleAI.models.generateContent({
          model: 'gemini-2.0-flash-preview-image-generation',
          contents: [
            {
              role: 'user',
              parts: [
                { text: 'Here is the original property photo:' },
                { inlineData: { mimeType: 'image/jpeg', data: resizedBuffer.toString('base64') } },
                { text: 'Here is a mask showing the areas to edit (dark/black areas are the plants to remove):' },
                { inlineData: { mimeType: 'image/jpeg', data: maskResized.toString('base64') } },
                { text: removalPrompt },
              ],
            },
          ],
          config: {
            responseModalities: ['image', 'text'],
          },
        });

        const parts = response.candidates?.[0]?.content?.parts || [];
        const imagePart = parts.find(p => p.inlineData);
        if (imagePart?.inlineData?.data) {
          resultBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
          console.log('[removal-preview] Gemini returned image:', Math.round(resultBuffer.length / 1024), 'KB');
        } else {
          throw new Error('Gemini returned no image data');
        }
      } catch (geminiErr) {
        console.warn('[removal-preview] Gemini failed:', geminiErr.message, '— falling back to gpt-image-1');
        resultBuffer = null;
      }
    }

    // Fallback to gpt-image-1
    if (!resultBuffer && openaiClient) {
      console.log('[removal-preview] Falling back to gpt-image-1...');
      const SQ = 1024;
      const { data: sqPixels } = await sharp(photoBuffer)
        .resize(SQ, SQ, { fit: 'fill' }).ensureAlpha().raw()
        .toBuffer({ resolveWithObject: true });

      const base64Data = maskDataUrl.replace(/^data:image\/png;base64,/, '');
      const rawMask = Buffer.from(base64Data, 'base64');
      const { data: sqMask } = await sharp(rawMask)
        .resize(SQ, SQ, { fit: 'fill' }).ensureAlpha().raw()
        .toBuffer({ resolveWithObject: true });

      let maskedPixelCount = 0;
      for (let i = 0; i < SQ * SQ; i++) {
        const brightness = (sqMask[i * 4] + sqMask[i * 4 + 1] + sqMask[i * 4 + 2]) / 3;
        if (brightness < 128) {
          sqPixels[i * 4] = 0; sqPixels[i * 4 + 1] = 0; sqPixels[i * 4 + 2] = 0; sqPixels[i * 4 + 3] = 0;
          sqMask[i * 4] = 0; sqMask[i * 4 + 1] = 0; sqMask[i * 4 + 2] = 0; sqMask[i * 4 + 3] = 0;
          maskedPixelCount++;
        } else {
          sqMask[i * 4] = 255; sqMask[i * 4 + 1] = 255; sqMask[i * 4 + 2] = 255; sqMask[i * 4 + 3] = 255;
        }
      }

      console.log('[removal-preview] OpenAI fallback — masked pixels:', maskedPixelCount);
      const imageBuffer = await sharp(Buffer.from(sqPixels.buffer), { raw: { width: SQ, height: SQ, channels: 4 } }).png().toBuffer();
      const maskBuffer = await sharp(Buffer.from(sqMask.buffer), { raw: { width: SQ, height: SQ, channels: 4 } }).png().toBuffer();

      const { toFile } = await import('openai');
      const imageFile = await toFile(imageBuffer, 'photo.png', { type: 'image/png' });
      const maskFile = await toFile(maskBuffer, 'mask.png', { type: 'image/png' });

      const editResponse = await openaiClient.images.edit({
        model: 'gpt-image-1',
        image: imageFile,
        mask: maskFile,
        prompt: 'Fill ONLY the transparent masked area with what would realistically be behind the removed plant. Seamlessly continue the exact surrounding materials — brick mortar pattern, vinyl siding lap lines, stucco texture, concrete, mulch, soil, or grass. Match the exact color temperature, shadow direction, surface weathering, and grain of adjacent surfaces. Preserve every pixel outside the masked region identically. Shot on Canon EOS R5, 35mm lens, f/8, natural daylight, RAW photograph.',
        n: 1,
        size: '1024x1024',
        quality: 'high',
      });

      const resultData = editResponse.data[0];
      if (resultData.b64_json) {
        resultBuffer = Buffer.from(resultData.b64_json, 'base64');
      } else if (resultData.url) {
        const dlRes = await fetch(resultData.url);
        resultBuffer = Buffer.from(await dlRes.arrayBuffer());
      } else {
        throw new Error('gpt-image-1 returned no image data');
      }
    }

    if (!resultBuffer) throw new Error('No AI image provider available');

    const finalBuffer = await sharp(resultBuffer)
      .resize(origW, origH, { fit: 'fill' })
      .jpeg({ quality: 92 })
      .toBuffer();

    const resultDataUrl = `data:image/jpeg;base64,${finalBuffer.toString('base64')}`;
    console.log('[removal-preview] Complete:', Math.round(finalBuffer.length / 1024), 'KB');
    res.json({ previewUrl: resultDataUrl });
  } catch (err) {
    console.error('[removal-preview] Error:', err.message);
    if (err.response) {
      console.error('[removal-preview] API response:', err.response.status, err.response.data);
    }
    res.status(500).json({ error: `Removal preview failed: ${err.message}` });
  }
});

// ─── Design Render (Gemini primary, gpt-image-1 fallback — new plants inpainted onto property photo) ──
app.post('/api/design-render', authenticate, async (req, res) => {
  try {
    const { photoUrl, designPlants, keptPlants, removedPlants, designStyle, narrative, maskDataUrl } = req.body;
    if (!photoUrl) return res.status(400).json({ error: 'photoUrl is required' });
    if (!googleAI && !openaiClient) return res.status(500).json({ error: 'No AI image provider configured' });

    // SSRF protection — only allow Supabase Storage URLs or data URLs
    if (!photoUrl.startsWith('data:')) {
      try {
        const parsedPhotoUrl = new URL(photoUrl);
        const allowedHosts = [
          config.supabaseStorage.url.replace(/^https?:\/\//, ''),
          'yxgwtrbbczgffrzmjahe.supabase.co',
        ];
        const isAllowed = allowedHosts.some(h => parsedPhotoUrl.hostname === h || parsedPhotoUrl.hostname.endsWith('.' + h));
        if (!isAllowed) return res.status(400).json({ error: 'photoUrl must be a Supabase Storage URL' });
      } catch {
        return res.status(400).json({ error: 'Invalid photoUrl' });
      }
    }

    console.log('[design-render] Downloading original photo...');
    let photoBuffer;
    if (photoUrl.startsWith('data:')) {
      const b64 = photoUrl.replace(/^data:image\/[^;]+;base64,/, '');
      photoBuffer = Buffer.from(b64, 'base64');
    } else {
      const photoResponse = await fetch(photoUrl);
      if (!photoResponse.ok) throw new Error(`Failed to download photo: ${photoResponse.status}`);
      photoBuffer = Buffer.from(await photoResponse.arrayBuffer());
    }

    const metadata = await sharp(photoBuffer).metadata();
    const origW = metadata.width;
    const origH = metadata.height;

    // Build plant description by layer
    const plantsByLayer = {};
    for (const p of (designPlants || [])) {
      const layer = p.layer || 'middle';
      if (!plantsByLayer[layer]) plantsByLayer[layer] = [];
      plantsByLayer[layer].push(`${p.quantity || 1}x ${p.common_name || p.plant_name}`);
    }
    const plantDesc = Object.entries(plantsByLayer)
      .map(([layer, plants]) => `${layer.toUpperCase()} ROW: ${plants.join(', ')}`)
      .join('. ');

    console.log('[design-render] Plant description:', plantDesc);

    const designPrompt = `Professional landscape installation photograph. In the landscape bed areas of this residential property, install these plants: ${plantDesc}. Style: ${designStyle || 'naturalistic'}. Fresh aged hardwood mulch (dark brown, natural texture) fills all bed space between plants with clean steel edging borders. Each plant is at realistic mature size with natural leaf detail and shadow casting. Preserve the house, driveway, lawn, sky, and all existing features exactly as they are. Shot on Canon EOS R5, 35mm lens, f/8, golden hour natural light.`;

    let resultBuffer;

    // Try Gemini first (faster, cheaper)
    if (googleAI) {
      console.log('[design-render] Calling Gemini gemini-2.0-flash-preview-image-generation...');
      try {
        // Resize to reasonable size for Gemini
        const resizedBuffer = await sharp(photoBuffer)
          .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
        const imageBase64 = resizedBuffer.toString('base64');

        const response = await googleAI.models.generateContent({
          model: 'gemini-2.0-flash-preview-image-generation',
          contents: [
            {
              role: 'user',
              parts: [
                { inlineData: { mimeType: 'image/jpeg', data: imageBase64 } },
                { text: designPrompt },
              ],
            },
          ],
          config: {
            responseModalities: ['image', 'text'],
          },
        });

        // Extract generated image from response
        const parts = response.candidates?.[0]?.content?.parts || [];
        const imagePart = parts.find(p => p.inlineData);
        if (imagePart?.inlineData?.data) {
          resultBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
          console.log('[design-render] Gemini returned image:', Math.round(resultBuffer.length / 1024), 'KB');
        } else {
          const textPart = parts.find(p => p.text);
          console.warn('[design-render] Gemini returned no image. Text:', textPart?.text?.substring(0, 200));
          throw new Error('Gemini returned no image data');
        }
      } catch (geminiErr) {
        console.warn('[design-render] Gemini failed:', geminiErr.message, '— falling back to gpt-image-1');
        resultBuffer = null; // Fall through to OpenAI
      }
    }

    // Fallback to gpt-image-1 if Gemini failed or unavailable
    if (!resultBuffer && openaiClient) {
      console.log('[design-render] Falling back to gpt-image-1 images.edit...');
      const SQ = 1024;
      const { data: sqPixels } = await sharp(photoBuffer)
        .resize(SQ, SQ, { fit: 'fill' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const maskPixels = Buffer.alloc(SQ * SQ * 4);
      let maskedCount = 0;

      if (maskDataUrl) {
        const b64 = maskDataUrl.replace(/^data:image\/png;base64,/, '');
        const rawMask = Buffer.from(b64, 'base64');
        const { data: drawnMask } = await sharp(rawMask)
          .resize(SQ, SQ, { fit: 'fill' }).ensureAlpha().raw()
          .toBuffer({ resolveWithObject: true });
        for (let i = 0; i < SQ * SQ; i++) {
          const brightness = (drawnMask[i * 4] + drawnMask[i * 4 + 1] + drawnMask[i * 4 + 2]) / 3;
          if (brightness < 128) {
            sqPixels[i * 4] = 0; sqPixels[i * 4 + 1] = 0; sqPixels[i * 4 + 2] = 0; sqPixels[i * 4 + 3] = 0;
            maskPixels[i * 4 + 3] = 0;
            maskedCount++;
          } else {
            maskPixels[i * 4] = 255; maskPixels[i * 4 + 1] = 255; maskPixels[i * 4 + 2] = 255; maskPixels[i * 4 + 3] = 255;
          }
        }
      } else {
        const editStartY = Math.round(SQ * 0.65);
        for (let y = 0; y < SQ; y++) {
          for (let x = 0; x < SQ; x++) {
            const i = y * SQ + x;
            if (y >= editStartY) {
              sqPixels[i * 4] = 0; sqPixels[i * 4 + 1] = 0; sqPixels[i * 4 + 2] = 0; sqPixels[i * 4 + 3] = 0;
              maskPixels[i * 4 + 3] = 0;
              maskedCount++;
            } else {
              maskPixels[i * 4] = 255; maskPixels[i * 4 + 1] = 255; maskPixels[i * 4 + 2] = 255; maskPixels[i * 4 + 3] = 255;
            }
          }
        }
      }

      console.log('[design-render] OpenAI fallback — masked pixels:', maskedCount);
      const imageBuffer = await sharp(Buffer.from(sqPixels.buffer), { raw: { width: SQ, height: SQ, channels: 4 } }).png().toBuffer();
      const maskBuffer = await sharp(Buffer.from(maskPixels.buffer), { raw: { width: SQ, height: SQ, channels: 4 } }).png().toBuffer();

      const { toFile } = await import('openai');
      const imageFile = await toFile(imageBuffer, 'photo.png', { type: 'image/png' });
      const maskFile = await toFile(maskBuffer, 'mask.png', { type: 'image/png' });

      const editResponse = await openaiClient.images.edit({
        model: 'gpt-image-1',
        image: imageFile,
        mask: maskFile,
        prompt: designPrompt,
        n: 1,
        size: '1024x1024',
        quality: 'high',
      });

      const resultData = editResponse.data[0];
      if (resultData.b64_json) {
        resultBuffer = Buffer.from(resultData.b64_json, 'base64');
      } else if (resultData.url) {
        const dlRes = await fetch(resultData.url);
        resultBuffer = Buffer.from(await dlRes.arrayBuffer());
      } else {
        throw new Error('gpt-image-1 returned no image data');
      }
    }

    if (!resultBuffer) throw new Error('No AI image provider available');

    // Resize back to original aspect ratio
    const finalBuffer = await sharp(resultBuffer)
      .resize(origW, origH, { fit: 'fill' })
      .jpeg({ quality: 92 })
      .toBuffer();

    const renderDataUrl = `data:image/jpeg;base64,${finalBuffer.toString('base64')}`;

    console.log('[design-render] Final design complete:', Math.round(finalBuffer.length / 1024), 'KB');
    res.json({ renderUrl: renderDataUrl, prompt: plantDesc });
  } catch (err) {
    console.error('[design-render] Error:', err.message);
    res.status(500).json({ error: `Design render failed: ${err.message}` });
  }
});

// FILE UPLOAD ROUTES
// ═══════════════════════════════════════════════════════════════════

app.post('/api/upload', authenticate, upload.single('file'), async (req, res) => {
  try {
    const { fileType } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file received. Use multipart/form-data with field name "file".' });
    if (!fileType) return res.status(400).json({ error: 'fileType is required (photo, logo, document, etc.)' });
    const key = `${req.user.companyId}/${fileType}/${uuidv4()}-${sanitizeFilename(file.originalname)}`;
    let cdnUrl;

    if (supaStorage) {
      // Upload to Supabase Storage
      await supaStorage.upload(key, file.buffer, file.mimetype);
      cdnUrl = supaStorage.getPublicUrl(key);
    } else {
      return res.status(503).json({ error: 'No storage service configured. Set SUPABASE_SERVICE_ROLE_KEY.' });
    }

    const dbFile = await db.getOne(
      `INSERT INTO files (company_id, uploaded_by, file_type, original_name, s3_key, s3_bucket, cdn_url, mime_type, file_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.user.companyId, req.user.userId, fileType, file.originalname, key, 'supabase', cdnUrl, file.mimetype, file.size]
    );

    res.status(201).json(dbFile);
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.post('/api/upload/photos/:areaId', authenticate, upload.array('photos', 20), async (req, res) => {
  try {
    if (!supaStorage) {
      return res.status(503).json({ error: 'No storage service configured. Set SUPABASE_SERVICE_ROLE_KEY.' });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No photo files received. Accepted formats: JPEG, PNG, HEIC, WebP.' });
    }

    // Verify area exists and belongs to this company
    const area = await db.getOne(
      `SELECT pa.id FROM property_areas pa JOIN projects p ON p.id = pa.project_id WHERE pa.id = $1 AND p.company_id = $2`,
      [req.params.areaId, req.user.companyId]
    );
    if (!area) {
      return res.status(404).json({ error: `Property area ${req.params.areaId} not found` });
    }

    console.log(`[photos] Uploading ${req.files.length} photos for area ${req.params.areaId}`);

    const photos = [];
    for (const file of req.files) {
      const key = `${req.user.companyId}/photos/${uuidv4()}-${sanitizeFilename(file.originalname)}`;
      let cdnUrl;

      await supaStorage.upload(key, file.buffer, file.mimetype);
      cdnUrl = supaStorage.getPublicUrl(key);

      const dbFile = await db.getOne(
        `INSERT INTO files (company_id, uploaded_by, file_type, original_name, s3_key, s3_bucket, cdn_url, mime_type, file_size)
         VALUES ($1, $2, 'photo', $3, $4, $5, $6, $7, $8) RETURNING *`,
        [req.user.companyId, req.user.userId, file.originalname, key, 'supabase', cdnUrl, file.mimetype, file.size]
      );

      const photo = await db.getOne(
        `INSERT INTO photos (property_area_id, file_id, sort_order) VALUES ($1, $2, $3) RETURNING *`,
        [req.params.areaId, dbFile.id, photos.length]
      );
      photos.push({ ...photo, file: dbFile });
    }

    // Run AI plant detection synchronously via GPT-4o vision
    if (openaiClient && photos.length > 0) {
      try {
        const imageUrls = photos.map(p => p.file.cdn_url).filter(Boolean);
        if (imageUrls.length > 0) {
          console.log(`[plant-detection] Analyzing ${imageUrls.length} photo(s) for area ${req.params.areaId}`);
          const messages = [
            {
              role: 'system',
              content: `You are an expert landscape botanist. Analyze the photo(s) of a property and identify all visible plants. For each plant, return:
{
  "common_name": "string",
  "botanical_name": "string or null",
  "category": "tree|shrub|perennial|annual|groundcover|ornamental_grass|vine|succulent",
  "condition": "healthy|fair|poor|dead",
  "confidence": 0.0-1.0,
  "position_x": 0.0-1.0 (horizontal position in image),
  "position_y": 0.0-1.0 (vertical position in image),
  "notes": "brief description"
}
Return: { "plants": [...] }
Be thorough but realistic. Only identify plants you can see clearly.`
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Identify all existing plants visible in this property photo. Return your response as JSON.' },
                ...imageUrls.map(url => ({ type: 'image_url', image_url: { url, detail: 'low' } })),
              ],
            },
          ];

          const aiRes = await openaiClient.chat.completions.create({
            model: config.openai.model,
            messages,
            response_format: { type: 'json_object' },
            max_tokens: 2000,
            temperature: 0.2,
          });

          const detected = JSON.parse(aiRes.choices[0].message.content);
          const plantsList = detected.plants || [];

          for (const p of plantsList) {
            try {
              const name = [p.common_name, p.botanical_name].filter(Boolean).join(' — ');
              await db.getOne(
                `INSERT INTO existing_plants (property_area_id, identified_name, confidence, position_x, position_y, mark, comment)
                 VALUES ($1, $2, $3, $4, $5, 'keep', $6) RETURNING id`,
                [req.params.areaId, name || 'Unknown Plant', p.confidence || 0.5,
                 p.position_x || 0.5, p.position_y || 0.5,
                 [p.category, p.condition, p.notes].filter(Boolean).join('; ') || null]
              );
            } catch (insertErr) {
              console.log(`[plant-detection] Could not insert plant "${p.common_name}":`, insertErr.message);
            }
          }
          console.log(`[plant-detection] Detected ${plantsList.length} plants for area ${req.params.areaId}`);
        }
      } catch (aiErr) {
        console.error('[plant-detection] AI error (non-blocking):', aiErr.message);
      }
    }

    res.status(201).json(photos);
  } catch (err) {
    console.error('Photo upload error:', err);
    res.status(500).json({ error: `Photo upload failed: ${err.message}` });
  }
});

// --- Issue 3 fix: Catch bare /upload/photos without areaId ---
app.post('/api/upload/photos', authenticate, (req, res) => {
  res.status(400).json({ error: 'Area ID is required. Use POST /api/upload/photos/:areaId' });
});

// Presigned URL for direct upload
app.post('/api/upload/presign', authenticate, async (req, res) => {
  try {
    const { fileName, fileType, contentType } = req.body;
    const key = `${req.user.companyId}/${fileType}/${uuidv4()}-${fileName}`;

    if (supaStorage) {
      const signedUrl = await supaStorage.createSignedUploadUrl(key);
      res.json({ presignedUrl: signedUrl, key, cdnUrl: supaStorage.getPublicUrl(key) });
    } else {
      res.status(503).json({ error: 'No storage service configured. Set SUPABASE_SERVICE_ROLE_KEY.' });
    }
  } catch (err) {
    console.error('Presign error:', err);
    res.status(500).json({ error: 'Failed to create upload URL' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// PLANT LIBRARY ROUTES
// ═══════════════════════════════════════════════════════════════════

app.get('/api/plants', authenticate, async (req, res) => {
  try {
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
  } catch (err) {
    console.error('GET /api/plants error:', err.message);
    res.status(500).json({ error: 'Failed to load plants' });
  }
});

app.post('/api/plants', authenticate, requireAdmin, async (req, res) => {
  try {
    const p = req.body;
    if (!p.commonName) return res.status(400).json({ error: 'commonName is required' });
    const plant = await db.getOne(
      `INSERT INTO plant_library (company_id, common_name, botanical_name, category, container_size, mature_height, mature_width, sun_requirement, water_needs, bloom_color, bloom_season, foliage_color, image_url, description, poetic_description, retail_price, wholesale_price, tags, is_native)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
      [req.user.companyId, p.commonName, p.botanicalName, p.category, p.containerSize, p.matureHeight, p.matureWidth, p.sunRequirement, p.waterNeeds, p.bloomColor, p.bloomSeason, p.foliageColor, p.imageUrl, p.description, p.poeticDescription, p.retailPrice, p.wholesalePrice, p.tags, p.isNative]
    );
    res.status(201).json(plant);
  } catch (err) {
    console.error('[POST /api/plants] Error:', err.message);
    res.status(500).json({ error: 'Failed to create plant' });
  }
});

app.get('/api/plants/:id', authenticate, async (req, res) => {
  try {
    const plant = await db.getOne(
      'SELECT * FROM plant_library WHERE id = $1 AND (company_id = $2 OR is_global = true)',
      [req.params.id, req.user.companyId]
    );
    if (!plant) return res.status(404).json({ error: 'Plant not found' });
    res.json(plant);
  } catch (err) {
    console.error('GET /api/plants/:id error:', err.message);
    res.status(500).json({ error: 'Failed to load plant' });
  }
});

app.put('/api/plants/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const p = req.body;
    const allowed = ['common_name', 'botanical_name', 'category', 'container_size', 'mature_height', 'mature_width',
      'sun_requirement', 'water_needs', 'usda_zones', 'bloom_color', 'bloom_season', 'foliage_color',
      'image_url', 'description', 'poetic_description', 'retail_price', 'wholesale_price',
      'tags', 'is_native', 'is_available', 'sort_order', 'notes'];
    // Accept camelCase
    const camelToSnake = { commonName: 'common_name', botanicalName: 'botanical_name', containerSize: 'container_size',
      matureHeight: 'mature_height', matureWidth: 'mature_width', sunRequirement: 'sun_requirement',
      waterNeeds: 'water_needs', usdaZones: 'usda_zones', bloomColor: 'bloom_color', bloomSeason: 'bloom_season',
      foliageColor: 'foliage_color', imageUrl: 'image_url', poeticDescription: 'poetic_description',
      retailPrice: 'retail_price', wholesalePrice: 'wholesale_price', isNative: 'is_native', isAvailable: 'is_available',
      sortOrder: 'sort_order' };
    const normalized = {};
    for (const [k, v] of Object.entries(p)) {
      const col = camelToSnake[k] || k;
      if (allowed.includes(col)) normalized[col] = v;
    }
    if (Object.keys(normalized).length === 0) return res.json({ message: 'No fields to update' });
    const updates = [], values = [];
    let idx = 1;
    for (const [col, val] of Object.entries(normalized)) { updates.push(`${col} = $${idx}`); values.push(val); idx++; }
    values.push(req.params.id, req.user.companyId);
    const plant = await db.getOne(
      `UPDATE plant_library SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${idx} AND company_id = $${idx + 1} RETURNING *`,
      values
    );
    if (!plant) return res.status(404).json({ error: 'Plant not found or not owned by your company' });
    res.json(plant);
  } catch (err) {
    console.error('PUT /api/plants/:id error:', err.message);
    if (err.code === '22001') return res.status(400).json({ error: 'One or more fields exceed maximum length' });
    res.status(500).json({ error: 'Failed to update plant' });
  }
});

app.delete('/api/plants/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM plant_library WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user.companyId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Plant not found or not owned by your company' });
    res.json({ message: 'Plant deleted' });
  } catch (err) {
    console.error('DELETE /api/plants/:id error:', err.message);
    res.status(500).json({ error: 'Failed to delete plant' });
  }
});

app.post('/api/plants/import', authenticate, requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!openaiClient) return res.status(503).json({ error: 'AI service not configured' });

    const fileContent = req.file.buffer.toString('utf-8').substring(0, 15000);
    const fileName = req.file.originalname;
    const mimeType = req.file.mimetype;

    console.log(`[plants/import] Parsing "${fileName}" (${mimeType}, ${req.file.size} bytes) for company ${req.user.companyId}`);

    // Use GPT-4o to parse the nursery availability list
    const aiResponse = await openaiClient.chat.completions.create({
      model: config.openai.model,
      messages: [
        {
          role: 'system',
          content: `You are an expert at parsing nursery availability lists. These come in many formats — wholesale price sheets, availability PDFs, inventory spreadsheets. Extract structured plant data from the provided content.

For each plant found, return a JSON object with:
{
  "common_name": "string (required)",
  "botanical_name": "string or null",
  "category": "tree|shrub|perennial|annual|groundcover|ornamental_grass|vine|succulent",
  "container_size": "e.g. 1-gal, 3-gal, 5-gal, 15-gal, 30-gal",
  "wholesale_price": number or null,
  "retail_price": number or null,
  "sun_requirement": "full_sun|partial_sun|shade|full_shade" or null,
  "water_needs": "low|moderate|high" or null,
  "is_native": boolean or null,
  "notes": "any additional info"
}

Return: { "plants": [...], "warnings": ["any issues"] }
Be thorough. Real nursery lists have inconsistent formatting, abbreviations, and mixed units.`
        },
        {
          role: 'user',
          content: `Parse this nursery availability list (format: ${mimeType}, filename: ${fileName}). Extract all plant data into structured JSON.\n\nContent:\n${fileContent}`
        }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 4000,
      temperature: 0.1,
    });

    const parsed = JSON.parse(aiResponse.choices[0].message.content);
    const plantsList = parsed.plants || [];

    if (plantsList.length === 0) {
      return res.json({ message: 'No plants found in file', imported: 0, warnings: parsed.warnings || [] });
    }

    // Insert each parsed plant into the plant_library
    let imported = 0;
    const errors = [];
    for (const p of plantsList) {
      try {
        await db.getOne(
          `INSERT INTO plant_library (company_id, common_name, botanical_name, category, container_size, sun_requirement, water_needs, wholesale_price, retail_price, is_native, description, is_available)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true) RETURNING id`,
          [
            req.user.companyId,
            p.common_name,
            p.botanical_name || null,
            p.category || null,
            p.container_size || null,
            p.sun_requirement || null,
            p.water_needs || null,
            p.wholesale_price || null,
            p.retail_price || null,
            p.is_native || false,
            p.notes || null,
          ]
        );
        imported++;
      } catch (insertErr) {
        errors.push(`${p.common_name}: ${insertErr.message}`);
      }
    }

    console.log(`[plants/import] Imported ${imported}/${plantsList.length} plants for company ${req.user.companyId}`);

    await logActivity(req.user.companyId, req.user.userId, 'plant_library', null, 'import', `Imported ${imported} plants from ${fileName}`);

    res.json({
      message: `Successfully imported ${imported} plants`,
      imported,
      total: plantsList.length,
      warnings: [...(parsed.warnings || []), ...errors],
    });
  } catch (err) {
    console.error('[plants/import] Error:', err.message);
    res.status(500).json({ error: `Import failed: ${err.message}` });
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

      // Run AI design generation SYNCHRONOUSLY for MVP
      let designPlants = [];
      let designNarrative = '';
      const photoUrls = photos.map(p => p.cdn_url).filter(Boolean);
      if (openaiClient) {
        try {
          const plantNames = plants.slice(0, 50).map(p => `${p.common_name} (${p.botanical_name || ''}, ${p.category || ''}, ${p.container_size || ''}, $${p.unit_cost || 0})`).join('\n');
          const getPlantName = (p) => {
            const name = p.identified_name || p.common_name || p.botanical_name || '';
            // Skip corrupted names from old bug
            if (['marked for removal', 'keep', 'remove', ''].includes(name.toLowerCase().trim())) {
              return p.common_name || p.botanical_name || p.comment || 'Unknown plant';
            }
            return name;
          };
          const keepPlants = existingPlants.filter(p => p.mark === 'keep').map(getPlantName).join(', ');
          const removePlants = existingPlants.filter(p => p.mark === 'remove').map(getPlantName).join(', ');
          console.log('[design-gen] Existing plants:', existingPlants.length, '| Keep:', keepPlants || '(none)', '| Remove:', removePlants || '(none)');

          // ── PROMPT ENHANCER: Enrich the client's raw plant requests ──
          let enhancedRequests = project.special_requests || '';
          if (enhancedRequests.trim()) {
            try {
              console.log('[design-gen] Enhancing client request:', enhancedRequests.substring(0, 100));
              const sunExposureLabel = (project.sun_exposure || 'full_sun').replace(/_/g, ' ');
              const styleLabel = (project.design_style || 'naturalistic').replace(/_/g, ' ');
              const zone = company.usda_zone || '9a';

              const enhanceRes = await openaiClient.chat.completions.create({
                model: config.openai.model,
                temperature: 0.4,
                max_tokens: 800,
                messages: [
                  {
                    role: 'system',
                    content: `You are an expert landscape designer's internal prompt translator. Your job is to take a homeowner's casual plant/design request and translate it into precise, professional landscape specifications that another AI will use to generate a full design.

Rules:
- Expand vague requests into specific botanical names, cultivar names, container sizes, and quantities
- Add professional spacing, mature height/width, and placement guidance
- Add complementary companion plants that pair well with what the client asked for
- Factor in the site conditions: USDA Zone ${zone}, ${sunExposureLabel} exposure, ${styleLabel} style
- If the client names a plant that won't thrive in these conditions, suggest the closest viable alternative and explain why
- Add seasonal interest notes (bloom time, fall color, evergreen vs deciduous)
- Keep the client's original intent — don't override their preferences, enhance them
- Output ONLY the enhanced specification text, no preamble or explanation
- Be concise but thorough — 3-6 sentences max`
                  },
                  {
                    role: 'user',
                    content: `Client's raw request: "${enhancedRequests}"

Existing plants being kept: ${keepPlants || 'none'}
Plants being removed: ${removePlants || 'none'}`
                  }
                ]
              });

              const enhanced = enhanceRes.choices[0]?.message?.content?.trim();
              if (enhanced) {
                enhancedRequests = enhanced;
                console.log('[design-gen] Enhanced request:', enhanced.substring(0, 200));
              }
            } catch (enhanceErr) {
              console.warn('[design-gen] Prompt enhancement failed (using raw request):', enhanceErr.message);
              // Fall through — use the original raw request
            }
          }

          // Build user message — include photo if available for context
          const userContent = [];
          if (photoUrls.length > 0) {
            userContent.push(...photoUrls.slice(0, 2).map(url => ({ type: 'image_url', image_url: { url, detail: 'low' } })));
          }

          const zipCode = project.address ? project.address.match(/\d{5}/)?.[0] : null;
          const locationStr = zipCode
            ? `${company.city || 'Houston'}, ${company.state || 'TX'} ${zipCode} (USDA Zone ${company.usda_zone || '9a'})`
            : `${company.city || 'Houston'}, ${company.state || 'TX'} (USDA Zone ${company.usda_zone || '9a'})`;

          // Build sun-specific guidance
          const sunGuide = {
            full_sun: 'This bed gets 6+ hours of direct sunlight. Choose heat-tolerant, sun-loving plants. Avoid shade plants — they will scorch and die.',
            partial_shade: 'This bed gets 3-6 hours of filtered or morning sun. Choose versatile plants that handle dappled light. Avoid full-sun-only varieties.',
            full_shade: 'This bed gets less than 3 hours of direct sun. Choose shade-tolerant plants only. Ferns, Cast Iron Plant, Aspidistra, Holly Fern, Caladium for color.',
          };

          // Build style-specific guidance
          const styleGuide = {
            formal: 'FORMAL/SYMMETRICAL style — mirror plant placement left-to-right, use clipped hedges (Boxwood, Dwarf Yaupon, Ligustrum), geometric spacing, clean lines. Monochromatic or limited color palette.',
            naturalistic: 'NATURALISTIC/COTTAGE style — flowing curves, mixed textures, layered heights that look organic. Use ornamental grasses, perennials, and flowering shrubs in drifts. Relaxed but intentional.',
            modern: 'MODERN/MINIMALIST style — clean architectural lines, limited plant palette (3-4 species max), bold single-species masses, structural plants like Agave, ornamental grasses, and clipped specimens. Negative space is part of the design.',
            tropical: 'TROPICAL style — lush, dense, layered foliage with bold leaf textures. Palms, Bird of Paradise, Plumbago, Crotons, Elephant Ears, Banana. Year-round green density is the goal.',
            xeriscape: 'XERISCAPE/DROUGHT-TOLERANT style — native and adapted plants that need minimal irrigation once established. Yucca, Agave, Salvia, Lantana, Gulf Muhly, Mexican Bush Sage, Texas Sage. Rock mulch and decomposed granite accents.',
          };

          const sunExposure = project.sun_exposure || 'full_sun';
          const designStyle = project.design_style || 'naturalistic';

          let userPrompt = `Design a complete ${designStyle} landscape renovation for this property. Return your response as JSON.

LOCATION: ${locationStr}

SUN CONDITIONS: ${sunExposure.replace(/_/g, ' ').toUpperCase()}
${sunGuide[sunExposure] || sunGuide.full_sun}

DESIGN STYLE: ${designStyle.toUpperCase()}
${styleGuide[designStyle] || styleGuide.naturalistic}
`;
          // Lighting and hardscape features
          if (project.include_lighting || project.lighting_requested) {
            userPrompt += `\nADDITIONAL FEATURE — LANDSCAPE LIGHTING: Include lighting notes. Suggest up-lights on specimen trees, path lights along walkways, and accent lights on focal plants.\n`;
          }
          if (project.include_hardscape || project.hardscape_changes) {
            userPrompt += `\nADDITIONAL FEATURE — HARDSCAPE: ${project.hardscape_notes || 'Client wants hardscape improvements. Consider stone borders, flagstone stepping stones, or decorative boulders.'}\n`;
          }

          if (keepPlants) {
            userPrompt += `\nEXISTING PLANTS STAYING (already installed — work your new design around these, note them but do NOT count in quantity/cost):\n${keepPlants}\n`;
          }
          if (removePlants) {
            userPrompt += `\n⛔ PLANTS BEING RIPPED OUT (these will be physically removed from the property — DO NOT include them or any variety of the same species ANYWHERE in your design):\n${removePlants}\nDesign BETTER REPLACEMENT plants for the gaps left by these removals.\n`;
          }
          if (enhancedRequests.trim()) {
            userPrompt += `\nCLIENT DESIGN SPECIFICATIONS (enhanced from client input): ${enhancedRequests}\n`;
          }
          userPrompt += `\nAVAILABLE NURSERY INVENTORY:\n${plantNames || '(No inventory loaded — suggest the best plants you know work in this exact zone and microclimate based on your 50 years of local experience)'}`;

          console.log('[design-gen] Prompt preview:', userPrompt.substring(0, 300));

          userContent.push({ type: 'text', text: userPrompt });

          const aiResponse = await openaiClient.chat.completions.create({
            model: config.openai.model,
            messages: [{
              role: 'system',
              content: `You are FILO — a master landscape architect with 50 years of hands-on residential design experience in the Gulf Coast region. You have personally installed thousands of beds in this exact zip code and microclimate. You know which plants thrive, which ones die in August heat, and which combinations create the "wow factor" that wins neighborhood awards.

YOUR DESIGN PHILOSOPHY:
- Design in 3 professional layers like every high-end install:
  • BACK ROW (foundation layer against structure): Tall evergreen shrubs 5-8ft mature (3-5 gal). Ligustrum japonicum, Podocarpus macrophyllus, Wax Leaf Privet, Pittosporum tobira, Viburnum odoratissimum
  • MIDDLE ROW (color & texture pop): Medium shrubs 3-5ft mature (1-3 gal). Loropetalum chinense, Knockout Roses, Indian Hawthorn, Drift Roses, Azalea indica, Camellia sasanqua, Abelia
  • FRONT ROW (border & groundcover): Low plants under 2ft (1 gal / 4" pots). Asian Jasmine, Dwarf Mondo Grass, Liriope, Society Garlic, Gulf Muhly, Dwarf Mexican Petunia
- ALWAYS use odd-number groupings (3, 5, 7) — never plant a single specimen unless it's a focal tree
- Repeat 2-3 key varieties for rhythm and a cohesive, professional look
- Space plants at 75% of mature width for full coverage within 18 months
- Include steel edging (typically 40-80 LF) and 3-4" hardwood mulch over weed barrier
- Consider mature size, bloom season stagger, and year-round structure
- Use real wholesale nursery pricing for your area ($8-15 for 1-gal, $22-38 for 3-gal, $35-55 for 5-gal, $120-180 for 15-gal trees)

CRITICAL RULES:
- If the client said to REMOVE a plant, it is being physically ripped out. Do NOT include it or any variety of that same species anywhere in your design.
- If the client said to KEEP a plant, it stays. Note it as "(existing - keeping)" in the design but DO NOT count it in quantities or cost.
- Your design must ONLY contain NEW plants being installed (plus notes about what's staying).

Return ONLY valid JSON with this exact structure:
{
  "design_narrative": "2-3 sentence professional description of the design concept, color palette, seasonal interest, and how it transforms the property",
  "layers": {
    "back": [{ "common_name": "string", "botanical_name": "string", "container_size": "string", "quantity": number, "unit_cost": number, "spacing_inches": number, "notes": "string" }],
    "middle": [{ "common_name": "string", "botanical_name": "string", "container_size": "string", "quantity": number, "unit_cost": number, "spacing_inches": number, "notes": "string" }],
    "front": [{ "common_name": "string", "botanical_name": "string", "container_size": "string", "quantity": number, "unit_cost": number, "spacing_inches": number, "notes": "string" }]
  },
  "services": {
    "mulch_cy": number,
    "soil_amendment_cy": number,
    "edging_lf": number,
    "bed_prep_sqft": number
  },
  "total_plants": number
}`
            }, {
              role: 'user',
              content: userContent,
            }],
            temperature: 0.7,
            response_format: { type: 'json_object' },
            max_tokens: 4000,
          });

          const rawContent = aiResponse.choices[0].message.content;
          console.log('[design-gen] Raw AI response:', rawContent);
          const parsed = JSON.parse(rawContent);
          designNarrative = parsed.design_narrative || '';
          console.log('[design-gen] Parsed keys:', Object.keys(parsed));
          console.log('[design-gen] Has layers:', !!parsed.layers, 'Layer keys:', Object.keys(parsed.layers || {}));

          // Flatten layers into designPlants array with layer info
          const layers = parsed.layers || {};
          for (const [layer, layerPlants] of Object.entries(layers)) {
            console.log(`[design-gen] Layer "${layer}": ${(layerPlants || []).length} plants`);
            for (const dp of (layerPlants || [])) {
              designPlants.push({ ...dp, layer });
            }
          }
          // Fallback if old format returned
          if (designPlants.length === 0 && (parsed.plants || parsed.design)) {
            designPlants = parsed.plants || parsed.design || [];
            console.log('[design-gen] Used fallback, found:', designPlants.length, 'plants');
          }
          console.log('[design-gen] Total designPlants:', designPlants.length);

          // Save design plants + narrative in design_data JSONB (design_plants table requires plant_library FK)
          await db.query(
            `UPDATE designs SET
              generation_status = 'completed',
              generation_completed_at = NOW(),
              design_data = $2,
              design_notes = $3
            WHERE id = $1`,
            [design.id, JSON.stringify({ plants: designPlants, services: parsed.services, narrative: designNarrative }), designNarrative]
          );
        } catch (aiErr) {
          console.error('AI design generation failed:', aiErr.message);
          // Retry without images if image download timed out
          if (aiErr.message && (aiErr.message.includes('Timeout while downloading') || aiErr.message.includes('Could not process image'))) {
            console.log('[design-gen] Retrying without images...');
            try {
              const textOnlyContent = userContent.filter(c => c.type === 'text');
              const retryResponse = await openaiClient.chat.completions.create({
                model: config.openai.model,
                messages: [{
                  role: 'system',
                  content: `You are FILO — a master landscape architect with 50 years of hands-on residential design experience in the Gulf Coast region. You know which plants thrive in this exact microclimate. Design in 3 professional layers (back foundation, middle color/texture, front border/groundcover). Use odd-number groupings (3, 5, 7). Use real wholesale pricing. CRITICAL: If the client said to REMOVE a plant, do NOT include it or any variety of that species anywhere in your design. Return ONLY valid JSON with: design_narrative, layers (back/middle/front arrays each with common_name, botanical_name, container_size, quantity, unit_cost, spacing_inches, notes), services (mulch_cy, soil_amendment_cy, edging_lf, bed_prep_sqft), total_plants.`
                }, {
                  role: 'user',
                  content: textOnlyContent,
                }],
                temperature: 0.7,
                response_format: { type: 'json_object' },
                max_tokens: 4000,
              });
              const retryContent = retryResponse.choices[0].message.content;
              console.log('[design-gen] Retry response length:', retryContent.length);
              const retryParsed = JSON.parse(retryContent);
              designNarrative = retryParsed.design_narrative || '';
              const retryLayers = retryParsed.layers || {};
              for (const [layer, layerPlants] of Object.entries(retryLayers)) {
                for (const dp of (layerPlants || [])) {
                  designPlants.push({ ...dp, layer });
                }
              }
              if (designPlants.length === 0 && (retryParsed.plants || retryParsed.design)) {
                designPlants = retryParsed.plants || retryParsed.design || [];
              }
              console.log('[design-gen] Retry success, total plants:', designPlants.length);
              await db.query(
                `UPDATE designs SET generation_status = 'completed', generation_completed_at = NOW(),
                  design_data = $2, design_notes = $3 WHERE id = $1`,
                [design.id, JSON.stringify({ plants: designPlants, services: retryParsed.services, narrative: designNarrative }), designNarrative]
              );
            } catch (retryErr) {
              console.error('AI design retry also failed:', retryErr.message);
              await db.query("UPDATE designs SET generation_status = 'failed' WHERE id = $1", [design.id]);
            }
          } else {
            await db.query("UPDATE designs SET generation_status = 'failed' WHERE id = $1", [design.id]);
          }
        }
      } else {
        await db.query("UPDATE designs SET generation_status = 'failed' WHERE id = $1", [design.id]);
      }

      const finalStatus = designPlants.length > 0 ? 'completed' : 'failed';
      designs.push({ ...design, generation_status: finalStatus, plants: designPlants, narrative: designNarrative, photoUrls });
    }

    await db.query('UPDATE projects SET status = $1 WHERE id = $2', ['design_review', project.id]);
    console.log('[design-gen] Sending response with', designs[0]?.plants?.length || 0, 'plants');
    res.json({ designs, design: designs[0], plants: designs[0]?.plants || [], narrative: designs[0]?.narrative || '', message: 'Design generation complete' });
  } catch (err) {
    console.error('Design generation error:', err);
    res.status(500).json({ error: 'Failed to start design generation' });
  }
});

app.get('/api/designs/:id', authenticate, async (req, res) => {
  try {
    // Verify ownership via project
    const design = await db.getOne(
      `SELECT d.* FROM designs d JOIN projects p ON p.id = d.project_id
       WHERE d.id = $1 AND p.company_id = $2`,
      [req.params.id, req.user.companyId]
    );
    if (!design) return res.status(404).json({ error: 'Design not found' });

    const plants = await db.getMany(
      `SELECT dp.*, pl.common_name, pl.botanical_name, pl.image_url, pl.retail_price, pl.category
       FROM design_plants dp JOIN plant_library pl ON pl.id = dp.plant_library_id
       WHERE dp.design_id = $1 ORDER BY dp.z_index`,
      [design.id]
    );

    res.json({ ...design, plants });
  } catch (err) {
    console.error('GET /api/designs/:id error:', err.message);
    res.status(500).json({ error: 'Failed to load design' });
  }
});

// ─── Chat Commands (design adjustments) ──────────────────────────

app.post('/api/designs/:designId/chat', authenticate, async (req, res) => {
  try {
    const { message } = req.body;
    const design = await db.getOne(
      `SELECT d.* FROM designs d JOIN projects p ON p.id = d.project_id
       WHERE d.id = $1 AND p.company_id = $2`,
      [req.params.designId, req.user.companyId]
    );
    if (!design) return res.status(404).json({ error: 'Design not found' });

    // Save user message
    await db.query(
      'INSERT INTO chat_messages (project_id, design_id, user_id, role, content) VALUES ($1, $2, $3, $4, $5)',
      [design.project_id, design.id, req.user.userId, 'user', message]
    );

    // Send to AI for interpretation
    const designData = design.design_data ? (typeof design.design_data === 'string' ? JSON.parse(design.design_data) : design.design_data) : {};
    const availablePlants = await db.getMany('SELECT * FROM plant_library WHERE company_id = $1 OR company_id IS NULL ORDER BY common_name LIMIT 100', [req.user.companyId]);
    const aiResponse = await callManusAI('design_chat', {
      command: message,
      currentDesign: designData.plants || [],
      designId: design.id,
      availablePlants,
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
  try {
    const { positionX, positionY } = req.body;
    if (positionX === undefined || positionY === undefined) {
      return res.status(400).json({ error: 'positionX and positionY are required' });
    }
    // Verify ownership
    const owned = await db.getOne(
      `SELECT dp.id FROM design_plants dp
       JOIN designs d ON d.id = dp.design_id
       JOIN projects p ON p.id = d.project_id
       WHERE dp.id = $1 AND p.company_id = $2`,
      [req.params.id, req.user.companyId]
    );
    if (!owned) return res.status(404).json({ error: 'Design plant not found' });
    const plant = await db.getOne(
      'UPDATE design_plants SET position_x = $1, position_y = $2 WHERE id = $3 RETURNING *',
      [positionX, positionY, req.params.id]
    );
    res.json(plant);
  } catch (err) {
    console.error('PUT /api/design-plants/:id/position error:', err.message);
    res.status(500).json({ error: 'Failed to update plant position' });
  }
});

app.post('/api/designs/:designId/plants', authenticate, async (req, res) => {
  try {
    // Verify design ownership via project
    const owned = await db.getOne(
      `SELECT d.id FROM designs d JOIN projects p ON p.id = d.project_id WHERE d.id = $1 AND p.company_id = $2`,
      [req.params.designId, req.user.companyId]
    );
    if (!owned) return res.status(404).json({ error: 'Design not found' });
    const { plantLibraryId, quantity, positionX, positionY, containerSize } = req.body;
    const plant = await db.getOne(
      `INSERT INTO design_plants (design_id, plant_library_id, quantity, position_x, position_y, container_size)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.params.designId, plantLibraryId, quantity, positionX, positionY, containerSize]
    );
    res.status(201).json(plant);
  } catch (err) {
    console.error('[designs/:id/plants] Error:', err.message);
    res.status(500).json({ error: 'Failed to add plant' });
  }
});

app.delete('/api/design-plants/:id', authenticate, async (req, res) => {
  try {
    // Verify ownership before deleting
    const owned = await db.getOne(
      `SELECT dp.id FROM design_plants dp
       JOIN designs d ON d.id = dp.design_id
       JOIN projects p ON p.id = d.project_id
       WHERE dp.id = $1 AND p.company_id = $2`,
      [req.params.id, req.user.companyId]
    );
    if (!owned) return res.status(404).json({ error: 'Design plant not found' });
    await db.query('DELETE FROM design_plants WHERE id = $1', [req.params.id]);
    res.json({ message: 'Plant removed' });
  } catch (err) {
    console.error('DELETE /api/design-plants/:id error:', err.message);
    res.status(500).json({ error: 'Failed to remove plant' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ESTIMATE ROUTES
// ═══════════════════════════════════════════════════════════════════

app.post('/api/projects/:projectId/estimates/generate', authenticate, async (req, res) => {
  try {
    const project = await db.getOne('SELECT * FROM projects WHERE id = $1 AND company_id = $2', [req.params.projectId, req.user.companyId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const company = await db.getOne('SELECT * FROM companies WHERE id = $1', [req.user.companyId]);
    if (!company) return res.status(404).json({ error: 'Company not found' });

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
        // Try design_plants table first (populated when user manually edits plants)
        const designPlants = await client.query(
          `SELECT dp.*, pl.common_name as lib_name, pl.retail_price, pl.container_size as lib_container
           FROM design_plants dp LEFT JOIN plant_library pl ON pl.id = dp.plant_library_id WHERE dp.design_id = $1`,
          [design.id]
        );

        let plantRows = designPlants.rows;

        // Fallback: read from design_data JSONB (where AI-generated plants are stored)
        if (plantRows.length === 0) {
          const designRow = await client.query('SELECT design_data FROM designs WHERE id = $1', [design.id]);
          if (designRow.rows[0]?.design_data) {
            const dd = typeof designRow.rows[0].design_data === 'string'
              ? JSON.parse(designRow.rows[0].design_data)
              : designRow.rows[0].design_data;
            plantRows = (dd.plants || []).map(p => ({
              common_name: p.common_name || p.name,
              plant_name: p.plant_name || p.common_name || p.name,
              container_size: p.container_size || '3-gal',
              unit_cost: p.unit_cost || p.price || 25,
              quantity: p.quantity || 1,
              botanical_name: p.botanical_name || '',
              layer: p.layer || '',
            }));
            console.log(`[estimate-gen] Read ${plantRows.length} plants from design_data JSONB for design ${design.id}`);
          }
        }

        for (const dp of plantRows) {
          const plantName = dp.lib_name || dp.common_name || dp.plant_name || 'Plant';
          const containerSize = dp.container_size || dp.lib_container || '3-gal';
          const basePrice = parseFloat(dp.price_override || dp.unit_cost || dp.retail_price) || 25;
          const markup = parseFloat(company.material_markup_pct) || 0;
          const price = basePrice * (1 + markup / 100);
          const qty = parseFloat(dp.quantity) || 1;
          const total = price * qty;
          await client.query(
            `INSERT INTO estimate_line_items (estimate_id, category, plant_library_id, design_plant_id, description, quantity, unit, unit_price, total_price, sort_order)
             VALUES ($1, 'plant_material', $2, $3, $4, $5, $6, $7, $8, $9)`,
            [estimateId, dp.plant_library_id || null, dp.id || null, `${plantName} (${containerSize})`, qty, 'ea', price, total, sortOrder++]
          );
          subtotal += total;
        }
      }

      // Add service line items (with safe defaults for unconfigured companies)
      // parseFloat() required: pg returns DECIMAL columns as strings, causing subtotal += to string-concat
      const services = [
        { cat: 'labor', desc: 'Installation Labor', price: parseFloat(company.labor_lump_default) || 1200 },
        { cat: 'soil_amendment', desc: 'Soil Amendments', price: (parseFloat(company.soil_amendment_per_cy) || 95) * 3 },
        { cat: 'mulch', desc: 'Hardwood Mulch', price: (parseFloat(company.mulch_per_cy) || 85) * 4 },
        { cat: 'edging', desc: 'Steel Edging', price: (parseFloat(company.edging_per_lf) || 8) * 60 },
        { cat: 'delivery', desc: 'Delivery', price: parseFloat(company.delivery_fee) || 150 },
      ];

      // Add removal if applicable
      const removals = await client.query(
        `SELECT COUNT(*) FROM existing_plants ep
         JOIN property_areas pa ON pa.id = ep.property_area_id
         WHERE pa.project_id = $1 AND ep.mark = 'remove'`, [project.id]
      );
      if (parseInt(removals.rows[0].count) > 0) {
        services.push({ cat: 'removal_disposal', desc: 'Plant Removal & Disposal (lump sum)', price: parseFloat(company.removal_base_fee) || 350 });
      }

      for (const svc of services) {
        await client.query(
          `INSERT INTO estimate_line_items (estimate_id, category, description, quantity, unit, unit_price, total_price, sort_order)
           VALUES ($1, $2, $3, 1, 'ea', $4, $4, $5)`,
          [estimateId, svc.cat, svc.desc, svc.price, sortOrder++]
        );
        subtotal += svc.price;
      }

      const taxAmount = company.tax_enabled ? Math.round(subtotal * (parseFloat(company.tax_rate) || 0.0825) * 100) / 100 : 0;
      const total = Math.round((subtotal + taxAmount) * 100) / 100;

      await client.query(
        'UPDATE estimates SET subtotal = $1, tax_amount = $2, total = $3 WHERE id = $4',
        [subtotal, taxAmount, total, estimateId]
      );
      await client.query('UPDATE projects SET estimated_total = $1 WHERE id = $2', [total, project.id]);

      // Fetch line items to return with the estimate
      const lineItems = await client.query('SELECT * FROM estimate_line_items WHERE estimate_id = $1 ORDER BY sort_order', [estimateId]);
      return { ...est.rows[0], subtotal, tax_amount: taxAmount, total, line_items: lineItems.rows };
    });

    res.status(201).json({ estimate });
  } catch (err) {
    console.error('Estimate generation error:', err);
    res.status(500).json({ error: 'Failed to generate estimate' });
  }
});

// --- Issue 3 fix: Catch bare /estimates/generate without projectId ---
app.post('/api/estimates/generate', authenticate, (req, res) => {
  res.status(400).json({ error: 'Project ID is required. Use POST /api/projects/:projectId/estimates/generate' });
});

app.get('/api/estimates/:id', authenticate, async (req, res) => {
  try {
    const estimate = await db.getOne('SELECT * FROM estimates WHERE id = $1 AND company_id = $2', [req.params.id, req.user.companyId]);
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

    const lineItems = await db.getMany('SELECT * FROM estimate_line_items WHERE estimate_id = $1 ORDER BY sort_order', [estimate.id]);
    res.json({ ...estimate, line_items: lineItems });
  } catch (err) {
    console.error('GET /api/estimates/:id error:', err.message);
    res.status(500).json({ error: 'Failed to load estimate' });
  }
});

app.put('/api/estimates/:id', authenticate, async (req, res) => {
  try {
    const estimate = await db.getOne('SELECT id FROM estimates WHERE id = $1 AND company_id = $2', [req.params.id, req.user.companyId]);
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    const allowed = ['notes', 'terms', 'warranty', 'valid_until', 'tax_rate', 'tax_enabled', 'labor_method', 'material_markup'];
    const updates = [], values = [];
    let idx = 1;
    for (const key of allowed) {
      if (req.body[key] !== undefined) { updates.push(`${key} = $${idx}`); values.push(req.body[key]); idx++; }
    }
    if (updates.length === 0) return res.json({ message: 'No fields to update' });
    values.push(req.params.id, req.user.companyId);
    const updated = await db.getOne(`UPDATE estimates SET ${updates.join(', ')} WHERE id = $${idx} AND company_id = $${idx + 1} RETURNING *`, values);
    const lineItems = await db.getMany('SELECT * FROM estimate_line_items WHERE estimate_id = $1 ORDER BY sort_order', [req.params.id]);
    res.json({ ...updated, line_items: lineItems });
  } catch (err) {
    console.error('PUT /api/estimates/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update estimate' });
  }
});

app.post('/api/estimates/:id/line-items', authenticate, async (req, res) => {
  try {
    const estimate = await db.getOne('SELECT * FROM estimates WHERE id = $1 AND company_id = $2', [req.params.id, req.user.companyId]);
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    const { category, description, quantity = 1, unit = 'ea', unitPrice, notes } = req.body;
    if (!category || unitPrice === undefined) return res.status(400).json({ error: 'category and unitPrice are required' });
    const VALID_CATS = ['plant_material', 'labor', 'soil_amendment', 'mulch', 'edging', 'irrigation', 'lighting',
      'hardscape', 'delivery', 'removal_disposal', 'warranty', 'tax', 'other'];
    if (!VALID_CATS.includes(category)) return res.status(400).json({ error: `Invalid category. Must be one of: ${VALID_CATS.join(', ')}` });
    const price = parseFloat(unitPrice);
    const qty = parseFloat(quantity);
    if (isNaN(price) || price < 0) return res.status(400).json({ error: 'unitPrice must be a non-negative number' });
    const totalPrice = Math.round(price * qty * 100) / 100;
    const maxSort = await db.getOne('SELECT COALESCE(MAX(sort_order), -1) as max FROM estimate_line_items WHERE estimate_id = $1', [req.params.id]);
    const item = await db.getOne(
      `INSERT INTO estimate_line_items (estimate_id, category, description, quantity, unit, unit_price, total_price, sort_order, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [req.params.id, category, description || category, qty, unit, price, totalPrice, (maxSort?.max ?? -1) + 1, notes || null]
    );
    // Recalculate totals
    const items = await db.getMany('SELECT total_price FROM estimate_line_items WHERE estimate_id = $1', [req.params.id]);
    const subtotal = Math.round(items.reduce((s, i) => s + parseFloat(i.total_price || 0), 0) * 100) / 100;
    const taxAmount = estimate.tax_enabled ? Math.round(subtotal * parseFloat(estimate.tax_rate || 0) * 100) / 100 : 0;
    await db.query('UPDATE estimates SET subtotal = $1, tax_amount = $2, total = $3 WHERE id = $4',
      [subtotal, taxAmount, Math.round((subtotal + taxAmount) * 100) / 100, req.params.id]);
    res.status(201).json(item);
  } catch (err) {
    console.error('POST /api/estimates/:id/line-items error:', err.message);
    res.status(500).json({ error: 'Failed to add line item' });
  }
});

app.put('/api/estimates/:id/line-items/:lineItemId', authenticate, async (req, res) => {
  try {
    // Verify estimate ownership
    const estimate = await db.getOne('SELECT * FROM estimates WHERE id = $1 AND company_id = $2', [req.params.id, req.user.companyId]);
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });

    const { unitPrice, quantity, description } = req.body;
    // Fetch existing item to fill in missing values
    const existing = await db.getOne('SELECT * FROM estimate_line_items WHERE id = $1 AND estimate_id = $2', [req.params.lineItemId, req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Line item not found' });
    const price = unitPrice !== undefined ? parseFloat(unitPrice) : parseFloat(existing.unit_price);
    const qty = quantity !== undefined ? parseFloat(quantity) : parseFloat(existing.quantity);
    if (isNaN(price) || isNaN(qty) || price < 0 || qty < 0) {
      return res.status(400).json({ error: 'unitPrice and quantity must be non-negative numbers' });
    }
    const totalPrice = Math.round(price * qty * 100) / 100;

    const item = await db.getOne(
      'UPDATE estimate_line_items SET unit_price = $1, quantity = $2, description = $3, total_price = $4 WHERE id = $5 AND estimate_id = $6 RETURNING *',
      [price, qty, description, totalPrice, req.params.lineItemId, req.params.id]
    );
    if (!item) return res.status(404).json({ error: 'Line item not found' });

    // Recalculate estimate totals
    const items = await db.getMany('SELECT total_price FROM estimate_line_items WHERE estimate_id = $1', [req.params.id]);
    const subtotal = items.reduce((sum, i) => sum + parseFloat(i.total_price || 0), 0);
    const taxAmount = estimate.tax_enabled ? Math.round(subtotal * parseFloat(estimate.tax_rate || 0) * 100) / 100 : 0;

    await db.query('UPDATE estimates SET subtotal = $1, tax_amount = $2, total = $3 WHERE id = $4',
      [subtotal, taxAmount, Math.round((subtotal + taxAmount) * 100) / 100, req.params.id]);

    res.json(item);
  } catch (err) {
    console.error('[estimates/line-items PUT] Error:', err.message);
    res.status(500).json({ error: 'Failed to update line item' });
  }
});

app.put('/api/estimates/:id/approve', authenticate, async (req, res) => {
  try {
    const estimate = await db.getOne(
      `UPDATE estimates SET status = 'approved', approved_by = $1, approved_at = NOW() WHERE id = $2 AND company_id = $3 RETURNING *`,
      [req.user.userId, req.params.id, req.user.companyId]
    );
    if (!estimate) return res.status(404).json({ error: 'Estimate not found' });
    await db.query('UPDATE projects SET status = $1 WHERE id = $2', ['estimate_approved', estimate.project_id]);
    await logActivity(req.user.companyId, req.user.userId, 'estimate', estimate.id, 'approve', 'Estimate approved');
    res.json(estimate);
  } catch (err) {
    console.error('PUT /api/estimates/:id/approve error:', err.message);
    res.status(500).json({ error: 'Failed to approve estimate' });
  }
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
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const company = await db.getOne('SELECT * FROM companies WHERE id = $1', [req.user.companyId]);
    if (!company) return res.status(404).json({ error: 'Company not found' });
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
      address: `${project.address || project.client_name || ''}`,
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

    res.status(201).json(submittal);
  } catch (err) {
    console.error('Submittal generation error:', err);
    res.status(500).json({ error: 'Failed to generate submittal' });
  }
});

app.get('/api/submittals/:id', authenticate, async (req, res) => {
  try {
    const submittal = await db.getOne('SELECT * FROM submittals WHERE id = $1 AND company_id = $2', [req.params.id, req.user.companyId]);
    if (!submittal) return res.status(404).json({ error: 'Submittal not found' });

    const plantProfiles = await db.getMany('SELECT * FROM submittal_plant_profiles WHERE submittal_id = $1 ORDER BY sort_order', [submittal.id]);
    res.json({ ...submittal, plantProfiles });
  } catch (err) {
    console.error('GET /api/submittals/:id error:', err.message);
    res.status(500).json({ error: 'Failed to load submittal' });
  }
});

app.put('/api/submittals/:id', authenticate, async (req, res) => {
  try {
    const submittal = await db.getOne('SELECT id FROM submittals WHERE id = $1 AND company_id = $2', [req.params.id, req.user.companyId]);
    if (!submittal) return res.status(404).json({ error: 'Submittal not found' });
    const allowed = ['scope_narrative', 'closing_statement', 'warranty_text', 'notes', 'status'];
    const updates = [], values = [];
    let idx = 1;
    for (const key of allowed) {
      if (req.body[key] !== undefined) { updates.push(`${key} = $${idx}`); values.push(req.body[key]); idx++; }
    }
    if (updates.length === 0) return res.json({ message: 'No fields to update' });
    values.push(req.params.id);
    const updated = await db.getOne(`UPDATE submittals SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`, values);
    const plantProfiles = await db.getMany('SELECT * FROM submittal_plant_profiles WHERE submittal_id = $1 ORDER BY sort_order', [req.params.id]);
    res.json({ ...updated, plantProfiles });
  } catch (err) {
    console.error('PUT /api/submittals/:id error:', err.message);
    res.status(500).json({ error: 'Failed to update submittal' });
  }
});

app.get('/api/projects/:projectId/submittals', authenticate, async (req, res) => {
  try {
    const project = await db.getOne('SELECT id FROM projects WHERE id = $1 AND company_id = $2', [req.params.projectId, req.user.companyId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const submittals = await db.getMany('SELECT * FROM submittals WHERE project_id = $1 ORDER BY created_at DESC', [req.params.projectId]);
    res.json(submittals);
  } catch (err) {
    console.error('GET /api/projects/:projectId/submittals error:', err.message);
    res.status(500).json({ error: 'Failed to load submittals' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// REVISION ROUTES
// ═══════════════════════════════════════════════════════════════════

app.get('/api/projects/:projectId/revisions', authenticate, async (req, res) => {
  try {
    // Verify project belongs to this company before returning revisions (IDOR fix)
    const project = await db.getOne('SELECT id FROM projects WHERE id = $1 AND company_id = $2', [req.params.projectId, req.user.companyId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const revisions = await db.getMany(
      `SELECT r.*, u.first_name, u.last_name FROM revisions r
       JOIN users u ON u.id = r.user_id
       WHERE r.project_id = $1 ORDER BY r.created_at DESC`,
      [req.params.projectId]
    );
    res.json(revisions);
  } catch (err) {
    console.error('GET /api/projects/:projectId/revisions error:', err.message);
    res.status(500).json({ error: 'Failed to load revisions' });
  }
});

app.post('/api/projects/:projectId/revisions/:revisionId/revert', authenticate, async (req, res) => {
  try {
    // Verify project ownership
    const project = await db.getOne('SELECT id FROM projects WHERE id = $1 AND company_id = $2', [req.params.projectId, req.user.companyId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const revision = await db.getOne('SELECT * FROM revisions WHERE id = $1 AND project_id = $2', [req.params.revisionId, req.params.projectId]);
    if (!revision) return res.status(404).json({ error: 'Revision not found' });
    if (!revision.previous_state) return res.status(400).json({ error: 'Cannot revert — no previous state saved' });

    if (revision.design_id) {
      await db.query('UPDATE designs SET design_data = $1 WHERE id = $2', [revision.previous_state, revision.design_id]);
    }

    await logActivity(req.user.companyId, req.user.userId, 'revision', revision.id, 'revert', `Reverted to version ${revision.version}`);
    res.json({ message: `Reverted to version ${revision.version}` });
  } catch (err) {
    console.error('[revision revert] Error:', err.message);
    res.status(500).json({ error: 'Revert failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// USERS / TEAM ROUTES
// ═══════════════════════════════════════════════════════════════════

app.get('/api/team', authenticate, async (req, res) => {
  try {
    const users = await db.getMany(
      'SELECT id, email, first_name, last_name, role, is_active, last_login_at, created_at FROM users WHERE company_id = $1 ORDER BY created_at',
      [req.user.companyId]
    );
    res.json(users);
  } catch (err) {
    console.error('GET /api/team error:', err.message);
    res.status(500).json({ error: 'Failed to load team' });
  }
});

app.put('/api/team/:userId', authenticate, requireAdmin, async (req, res) => {
  try {
    const { role, isActive } = req.body;
    const user = await db.getOne(
      'UPDATE users SET role = COALESCE($1, role), is_active = COALESCE($2, is_active) WHERE id = $3 AND company_id = $4 RETURNING id, email, role, is_active',
      [role, isActive, req.params.userId, req.user.companyId]
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error('PUT /api/team/:userId error:', err.message);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

app.delete('/api/team/:userId', authenticate, requireAdmin, async (req, res) => {
  try {
    if (req.params.userId === req.user.userId) return res.status(400).json({ error: 'Cannot deactivate yourself' });
    await db.query('UPDATE users SET is_active = false WHERE id = $1 AND company_id = $2', [req.params.userId, req.user.companyId]);
    res.json({ message: 'User deactivated' });
  } catch (err) {
    console.error('DELETE /api/team/:userId error:', err.message);
    res.status(500).json({ error: 'Failed to deactivate user' });
  }
});

// ─── Per-project export (used by wizard step 8 CRM push) ─────────
app.get('/api/projects/:projectId/export', authenticate, async (req, res) => {
  try {
    const project = await db.getOne('SELECT * FROM v_active_projects WHERE id = $1 AND company_id = $2', [req.params.projectId, req.user.companyId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const areas = await db.getMany('SELECT * FROM property_areas WHERE project_id = $1', [project.id]);
    const design = await db.getOne('SELECT * FROM designs WHERE project_id = $1 AND is_current = true ORDER BY created_at DESC LIMIT 1', [project.id]);
    const estimate = await db.getOne('SELECT * FROM estimates WHERE project_id = $1 AND is_current = true ORDER BY created_at DESC LIMIT 1', [project.id]);
    const lineItems = estimate ? await db.getMany('SELECT * FROM estimate_line_items WHERE estimate_id = $1 ORDER BY sort_order', [estimate.id]) : [];
    const submittal = await db.getOne('SELECT * FROM submittals WHERE project_id = $1 AND is_current = true ORDER BY created_at DESC LIMIT 1', [project.id]);

    res.json({
      project,
      areas,
      design: design ? { ...design, plants: design.design_data?.plants || [] } : null,
      estimate: estimate ? { ...estimate, line_items: lineItems } : null,
      submittal,
      exportedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('GET /api/projects/:projectId/export error:', err.message);
    res.status(500).json({ error: 'Export failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// DATA EXPORT ROUTES
// ═══════════════════════════════════════════════════════════════════

app.get('/api/export/projects', authenticate, async (req, res) => {
  try {
    const projects = await db.getMany('SELECT * FROM projects WHERE company_id = $1', [req.user.companyId]);
    res.json(projects);
  } catch (err) {
    console.error('GET /api/export/projects error:', err.message);
    res.status(500).json({ error: 'Export failed' });
  }
});

app.get('/api/export/plants/csv', authenticate, async (req, res) => {
  try {
    const plants = await db.getMany(
      'SELECT common_name, botanical_name, category, container_size, retail_price, sun_requirement, water_needs FROM plant_library WHERE company_id = $1 OR is_global = true',
      [req.user.companyId]
    );

    // Escape CSV values safely
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = 'Common Name,Botanical Name,Category,Size,Price,Sun,Water\n';
    const rows = plants.map(p =>
      `${esc(p.common_name)},${esc(p.botanical_name)},${esc(p.category)},${esc(p.container_size)},${p.retail_price ?? ''},${esc(p.sun_requirement)},${esc(p.water_needs)}`
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=plant_library.csv');
    res.send(header + rows);
  } catch (err) {
    console.error('GET /api/export/plants/csv error:', err.message);
    res.status(500).json({ error: 'Export failed' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// AI INTEGRATION (Direct OpenAI API via filo-ai-pipeline.js)
// ═══════════════════════════════════════════════════════════════════

const callAI = createAIHandler(db);
const openaiClient = config.openai.apiKey ? new OpenAI({ apiKey: config.openai.apiKey }) : null;
const googleAI = process.env.GOOGLE_AI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GOOGLE_AI_API_KEY }) : null;

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
  try {
    const job = await db.getOne('SELECT * FROM ai_jobs WHERE id = $1 AND company_id = $2', [req.params.id, req.user.companyId]);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/projects/:projectId/ai-jobs', authenticate, async (req, res) => {
  try {
    // Verify project ownership before returning jobs
    const project = await db.getOne('SELECT id FROM projects WHERE id = $1 AND company_id = $2', [req.params.projectId, req.user.companyId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const jobs = await db.getMany(
      'SELECT * FROM ai_jobs WHERE project_id = $1 ORDER BY created_at DESC',
      [req.params.projectId]
    );
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// STRIPE WEBHOOK
// ═══════════════════════════════════════════════════════════════════

async function handleStripeWebhook(req, res) {
  if (!stripe) return res.status(503).json({ error: 'Stripe not configured' });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], config.stripe.webhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Log webhook (non-fatal — don't crash if log insert fails)
  try {
    await db.query(
      'INSERT INTO webhook_events (source, event_type, event_id, payload) VALUES ($1, $2, $3, $4)',
      ['stripe', event.type, event.id, event.data]
    );
  } catch (logErr) {
    console.error('[webhook] Failed to log event (non-fatal):', logErr.message);
  }

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
  // Fire-and-forget — never crashes calling route
  try {
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
  } catch (err) {
    console.error('[triggerCrmSync] Failed (non-fatal):', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// AI PROXY ENDPOINTS (frontend calls these instead of OpenAI directly)
// Keeps the API key server-side only — no VITE_OPENAI_API_KEY needed
// ═══════════════════════════════════════════════════════════════════

const aiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI requests, please wait a moment' },
});

app.get('/api/ai/health', authenticate, (req, res) => {
  res.json({
    configured: !!openaiClient,
    model: openaiClient ? config.openai.model : null,
    status: openaiClient ? 'ready' : 'not_configured',
  });
});

app.post('/api/ai/detect-plants', authenticate, aiRateLimit, async (req, res) => {
  try {
    if (!openaiClient) return res.status(503).json({ error: 'AI service not configured' });
    const { imageUrl, location, usdaZone } = req.body;
    if (!imageUrl) return res.status(400).json({ error: 'imageUrl is required' });

    const locationContext = location
      ? `This property is in ${location.city}, ${location.state} (USDA Zone ${usdaZone || 'unknown'}).`
      : '';

    const response = await openaiClient.chat.completions.create({
      model: config.openai.model,
      messages: [
        {
          role: 'system',
          content: `You are an expert horticulturist and landscape analyst. You identify plants in residential landscape photographs with high accuracy.

Given a photograph of a residential landscape:
1. Identify every visible plant, shrub, tree, and ground cover
2. For each plant, provide:
   - common_name, botanical_name, confidence (0-1), position_x (0-100), position_y (0-100),
     bounding_box: { x, y, width, height } as percentages,
     category: tree|shrub|perennial|annual|groundcover|ornamental_grass|vine|succulent,
     health_assessment: healthy|stressed|declining|dead,
     approximate_size: container-equivalent (e.g. "3-gallon")

Return ONLY valid JSON: { "plants": [...] }`,
        },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: imageUrl, detail: 'high' } },
            { type: 'text', text: `Identify all plants in this residential landscape photo. ${locationContext} Return the JSON analysis.` },
          ],
        },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 4000,
      temperature: 0.2,
    });

    const result = JSON.parse(response.choices[0].message.content);
    res.json({ success: true, plants: result.plants || [] });
  } catch (err) {
    console.error('[AI Proxy] detect-plants error:', err);
    res.status(500).json({ success: false, error: err.message, plants: [] });
  }
});

app.post('/api/ai/generate-design', authenticate, aiRateLimit, async (req, res) => {
  try {
    if (!openaiClient) return res.status(503).json({ error: 'AI service not configured' });
    const {
      photoBase64, sunExposure, designStyle, specialRequests,
      availablePlants, existingPlantsKeep, existingPlantsRemove,
      location, lighting, hardscape,
    } = req.body;

    const loc = location || {};
    const userContent = [];

    if (photoBase64) {
      userContent.push({ type: 'image_url', image_url: { url: photoBase64, detail: 'high' } });
    }

    userContent.push({
      type: 'text',
      text: `Design a landscape for this property.

SITE CONDITIONS:
- Location: ${loc.city || 'Houston'}, ${loc.state || 'TX'} (USDA Zone ${loc.zone || '9a'})
- Sun exposure: ${sunExposure || 'full_sun'}
- Design style: ${designStyle || 'naturalistic'}

CLIENT REQUESTS:
${specialRequests || 'No special requests.'}
${lighting ? '- Lighting requested' : ''}
${hardscape ? '- Hardscape changes noted' : ''}

EXISTING PLANTS TO KEEP:
${(existingPlantsKeep || []).length > 0 ? existingPlantsKeep.map(p => `- ${p.name || p.identified_name} at (${p.position_x}, ${p.position_y})`).join('\n') : 'None'}

PLANTS TO REMOVE:
${(existingPlantsRemove || []).length > 0 ? existingPlantsRemove.map(p => `- ${p.name || p.identified_name} at (${p.position_x}, ${p.position_y})`).join('\n') : 'None'}

AVAILABLE PLANT INVENTORY (select ONLY from these):
${JSON.stringify((availablePlants || []).slice(0, 50), null, 0)}

Create a complete plant placement plan. Return JSON with: design_rationale, plant_placements[], services_recommended, design_summary.`,
    });

    const response = await openaiClient.chat.completions.create({
      model: config.openai.model,
      messages: [
        {
          role: 'system',
          content: `You are a professional landscape architect creating plant placement plans for residential properties. Follow layering, spacing, repetition, color theory, and architecture principles. Return ONLY valid JSON with: design_rationale, plant_placements (array with plant_library_id, common_name, quantity, container_size, position_x, position_y, z_index, layer, grouping_notes), services_recommended (soil_amendment_cy, mulch_cy, edging_lf, irrigation_needed, lighting_zones), design_summary.`,
        },
        { role: 'user', content: userContent },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 4000,
      temperature: 0.4,
    });

    const data = JSON.parse(response.choices[0].message.content);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[AI Proxy] generate-design error:', err);
    res.status(500).json({ success: false, data: null, error: err.message });
  }
});

app.post('/api/ai/chat-command', authenticate, aiRateLimit, async (req, res) => {
  try {
    if (!openaiClient) return res.status(503).json({ error: 'AI service not configured' });
    const { message, currentPlants, availablePlants } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const response = await openaiClient.chat.completions.create({
      model: config.openai.model,
      messages: [
        {
          role: 'system',
          content: `You are a landscape design assistant interpreting user modification commands. Available actions: swap_plant, add_plant, remove_plant, move_plant, resize_bed, adjust_quantity. Return JSON: { message, actions: [{ type, oldPlantId, newPlantId, plantId, quantity, x, y, reason }], warnings: [] }`,
        },
        {
          role: 'user',
          content: `User command: "${message}"

Current design plants:
${JSON.stringify(currentPlants || [], null, 2)}

Available plants for substitution/addition:
${JSON.stringify(availablePlants || [], null, 2)}

Interpret the command and return the action JSON.`,
        },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 2000,
      temperature: 0.3,
    });

    const result = JSON.parse(response.choices[0].message.content);
    res.json({
      success: true,
      message: result.message || 'Design updated.',
      actions: result.actions || [],
      warnings: result.warnings || [],
    });
  } catch (err) {
    console.error('[AI Proxy] chat-command error:', err);
    res.status(500).json({
      success: false,
      message: 'I had trouble processing that command.',
      actions: [],
      warnings: [],
      error: err.message,
    });
  }
});

app.post('/api/ai/narrative', authenticate, aiRateLimit, async (req, res) => {
  try {
    if (!openaiClient) return res.status(503).json({ error: 'AI service not configured' });
    const {
      companyName, clientName, address, designStyle,
      sunExposure, plants, lighting, hardscape, specialRequests,
    } = req.body;

    const response = await openaiClient.chat.completions.create({
      model: config.openai.model,
      messages: [
        {
          role: 'system',
          content: `You are a professional landscape design proposal writer. Write formal, third-person scope of work narratives. 2-3 paragraphs, 150-250 words. Do NOT mention pricing, quantities, container sizes, or any software. Return JSON: { "narrative": "...", "closing": "..." }`,
        },
        {
          role: 'user',
          content: `Write a scope of work narrative:

Company: ${companyName || "King's Garden Landscaping"}
Client: ${clientName}
Property: ${address}
Design Style: ${designStyle || 'naturalistic'}
Sun Exposure: ${sunExposure || 'full sun'}
Plant Selections: ${(plants || []).join(', ') || 'various species'}
${lighting ? 'Landscape Lighting: Included' : ''}
${hardscape ? `Hardscape Notes: ${hardscape}` : ''}
${specialRequests ? `Special Requests: ${specialRequests}` : ''}

Write the narrative and closing statement as JSON.`,
        },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 1500,
      temperature: 0.6,
    });

    const result = JSON.parse(response.choices[0].message.content);
    res.json({
      success: true,
      text: result.narrative || result.text || '',
      closing: result.closing || '',
    });
  } catch (err) {
    console.error('[AI Proxy] narrative error:', err);
    res.status(500).json({ success: false, text: '', closing: '', error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// BILLING (Stripe) ROUTES
// ═══════════════════════════════════════════════════════════════════

app.get('/api/billing/status', authenticate, async (req, res) => {
  try {
    const sub = await db.getOne(
      'SELECT * FROM subscriptions WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1',
      [req.user.companyId]
    );
    res.json({ subscription: sub || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/billing/subscribe', authenticate, requireAdmin, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured' });
  try {
    const { paymentMethodId } = req.body;
    if (!paymentMethodId) return res.status(400).json({ error: 'paymentMethodId is required' });

    const company = await db.getOne('SELECT * FROM companies WHERE id = $1', [req.user.companyId]);
    const adminUser = await db.getOne('SELECT email FROM users WHERE id = $1', [req.user.userId]);
    let customerId = company.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: adminUser?.email || company.email,
        name: company.name,
        payment_method: paymentMethodId,
        invoice_settings: { default_payment_method: paymentMethodId },
        metadata: { company_id: company.id },
      });
      customerId = customer.id;
      await db.query('UPDATE companies SET stripe_customer_id = $1 WHERE id = $2', [customerId, company.id]);
    } else {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    }

    const priceId = config.stripe.basePriceId;
    if (!priceId) return res.status(503).json({ error: 'Stripe price not configured' });

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
    });

    await db.query(
      `INSERT INTO subscriptions (company_id, stripe_subscription_id, stripe_customer_id, status, plan_name, current_period_start, current_period_end)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6), to_timestamp($7))
       ON CONFLICT (company_id) DO UPDATE SET
         stripe_subscription_id = EXCLUDED.stripe_subscription_id,
         stripe_customer_id = EXCLUDED.stripe_customer_id,
         status = EXCLUDED.status,
         current_period_start = EXCLUDED.current_period_start,
         current_period_end = EXCLUDED.current_period_end`,
      [company.id, subscription.id, customerId, subscription.status, 'base',
       subscription.current_period_start, subscription.current_period_end]
    );

    res.json({ subscriptionId: subscription.id, status: subscription.status, clientSecret: subscription.latest_invoice?.payment_intent?.client_secret });
  } catch (err) {
    console.error('[billing/subscribe] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/billing/portal', authenticate, requireAdmin, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured' });
  try {
    const { returnUrl } = req.body;
    const company = await db.getOne('SELECT stripe_customer_id FROM companies WHERE id = $1', [req.user.companyId]);
    if (!company?.stripe_customer_id) return res.status(400).json({ error: 'No billing account found. Subscribe first.' });

    const session = await stripe.billingPortal.sessions.create({
      customer: company.stripe_customer_id,
      return_url: returnUrl || process.env.APP_URL || 'https://app.myfilocrm.com',
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[billing/portal] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/billing/cancel', authenticate, requireAdmin, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured' });
  try {
    const { immediate = false } = req.body;
    const sub = await db.getOne(
      "SELECT * FROM subscriptions WHERE company_id = $1 AND status NOT IN ('canceled', 'incomplete_expired') ORDER BY created_at DESC LIMIT 1",
      [req.user.companyId]
    );
    if (!sub?.stripe_subscription_id) return res.status(400).json({ error: 'No active subscription found' });

    let updated;
    if (immediate) {
      updated = await stripe.subscriptions.cancel(sub.stripe_subscription_id);
    } else {
      updated = await stripe.subscriptions.update(sub.stripe_subscription_id, { cancel_at_period_end: true });
    }

    await db.query(
      'UPDATE subscriptions SET status = $1, cancel_at_period_end = $2 WHERE id = $3',
      [updated.status, updated.cancel_at_period_end, sub.id]
    );

    res.json({ status: updated.status, cancelAtPeriodEnd: updated.cancel_at_period_end });
  } catch (err) {
    console.error('[billing/cancel] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/billing/invoices', authenticate, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured' });
  try {
    const company = await db.getOne('SELECT stripe_customer_id FROM companies WHERE id = $1', [req.user.companyId]);
    if (!company?.stripe_customer_id) return res.json({ invoices: [] });

    const invoices = await stripe.invoices.list({ customer: company.stripe_customer_id, limit: 24 });
    res.json({ invoices: invoices.data });
  } catch (err) {
    console.error('[billing/invoices] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// CRM ROUTES (stubs — full integration pending)
// ═══════════════════════════════════════════════════════════════════

app.get('/api/crm/status', authenticate, async (req, res) => {
  try {
    const integration = await db.getOne(
      'SELECT * FROM crm_integrations WHERE company_id = $1 LIMIT 1',
      [req.user.companyId]
    );
    res.json({ connected: !!integration, integration: integration || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/crm/providers', authenticate, (req, res) => {
  res.json({ providers: ['jobber', 'housecall_pro', 'service_titan', 'aspire'] });
});

app.post('/api/crm/connect', authenticate, requireAdmin, async (req, res) => {
  res.status(501).json({ error: 'CRM OAuth connect not yet implemented. Contact support.' });
});

app.post('/api/crm/disconnect', authenticate, requireAdmin, async (req, res) => {
  try {
    await db.query('DELETE FROM crm_integrations WHERE company_id = $1', [req.user.companyId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/crm/sync/full/:projectId', authenticate, async (req, res) => {
  res.status(501).json({ error: 'CRM full sync not yet implemented.' });
});

app.get('/api/crm/sync-log', authenticate, async (req, res) => {
  try {
    const log = await db.getMany(
      'SELECT * FROM crm_sync_log WHERE company_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user.companyId]
    );
    res.json({ log });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// PDF ROUTES (stubs — filo-pdf-engine.js not yet mounted)
// ═══════════════════════════════════════════════════════════════════

app.post('/api/estimates/:id/pdf', authenticate, async (req, res) => {
  res.status(501).json({ error: 'PDF generation not yet implemented. Export via /projects/:id/export instead.' });
});

app.post('/api/estimates/:id/pdf/all', authenticate, async (req, res) => {
  res.status(501).json({ error: 'PDF generation not yet implemented. Export via /projects/:id/export instead.' });
});

app.post('/api/submittals/:id/pdf', authenticate, async (req, res) => {
  res.status(501).json({ error: 'PDF generation not yet implemented. Export via /projects/:id/export instead.' });
});

app.post('/api/submittals/:id/pdf-and-push', authenticate, async (req, res) => {
  res.status(501).json({ error: 'PDF generation and CRM push not yet implemented.' });
});

// ─── File Download ───────────────────────────────────────────────

app.get('/api/files/:fileId/download', authenticate, async (req, res) => {
  try {
    const file = await db.getOne(
      'SELECT * FROM files WHERE id = $1 AND company_id = $2',
      [req.params.fileId, req.user.companyId]
    );
    if (!file) return res.status(404).json({ error: 'File not found' });
    res.json({ url: file.cdn_url, name: file.original_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health Check ────────────────────────────────────────────────

app.get('/api/health', async (req, res) => {
  const health = { status: 'healthy', timestamp: new Date().toISOString(), version: '1.0.0', services: {} };
  try {
    const dbCheck = Promise.race([
      db.query('SELECT 1').then(() => 'connected'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    health.services.database = await dbCheck;
  } catch (err) {
    health.services.database = `unavailable: ${err.message}`;
  }
  health.services.openai = openaiClient ? 'configured' : 'not configured';
  health.services.stripe = stripe ? 'configured' : 'not configured';
  health.services.storage = supaStorage ? 'supabase' : 'not configured';
  res.json(health);
});

app.get('/api/ping', (req, res) => res.json({ pong: true }));

// ─── 404 ─────────────────────────────────────────────────────────

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ─── Error Handler ───────────────────────────────────────────────

app.use((err, req, res, next) => {
  // Body parser errors (check by status + type or code)
  if (err.status === 413 || err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  if (err.status === 400 && (err.type === 'entity.parse.failed' || err.type === 'charset.unsupported' || err.body !== undefined || err.message?.includes('JSON'))) {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  // Multer errors
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large. Maximum is 25MB.' });
  // Default
  console.error('Unhandled error:', err.status, err.type, err.message);
  const statusCode = (err.status && typeof err.status === 'number' && err.status >= 400 && err.status < 500) ? err.status : 500;
  res.status(statusCode).json({ error: statusCode < 500 ? err.message : 'Internal server error' });
});

// ─── Startup Environment Checks ──────────────────────────────────

const REQUIRED_ENV = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'DATABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'OPENAI_API_KEY'];
const MISSING_ENV = REQUIRED_ENV.filter(k => !process.env[k]);
if (MISSING_ENV.length > 0) {
  console.warn(`⚠️  Missing environment variables: ${MISSING_ENV.join(', ')}`);
  if (config.nodeEnv === 'production') {
    console.error('FATAL: Required environment variables missing in production. Set them in Railway dashboard.');
    process.exit(1);
  }
}
if (!config.jwtSecret || !config.jwtRefreshSecret) {
  console.error('FATAL: JWT_SECRET and JWT_REFRESH_SECRET must be set. Server cannot start safely.');
  process.exit(1);
}

const OPTIONAL_ENV = [
  ['STRIPE_SECRET_KEY', 'Stripe secret key — billing/subscription endpoints will be disabled'],
  ['STRIPE_WEBHOOK_SECRET', 'Stripe webhook secret — webhook verification will be disabled'],
  ['STRIPE_BASE_PRICE_ID', 'Stripe base subscription price — billing endpoints will error without it'],
  ['STRIPE_USER_PRICE_ID', 'Stripe per-user price — billing endpoints will error without it'],
  ['GPT_MODEL', 'OpenAI model override — defaults to gpt-4o'],
];
for (const [key, note] of OPTIONAL_ENV) {
  if (!process.env[key]) console.warn(`ℹ️  Optional env not set: ${key} — ${note}`);
}

// ─── Global Unhandled Rejection Safety Net ───────────────────────
// Prevents async route errors from crashing the process in Node 18+
process.on('unhandledRejection', (reason, promise) => {
  console.error('[UnhandledRejection] Promise:', promise);
  console.error('[UnhandledRejection] Reason:', reason);
  // Do NOT crash — Express error handler should have caught this
});

// ─── Start Server ────────────────────────────────────────────────

app.listen(config.port, async () => {
  console.log(`🌿 FILO API server running on port ${config.port}`);
  console.log(`   Environment: ${config.nodeEnv}`);
  console.log(`   Storage: ${supaStorage ? 'Supabase Storage' : '⚠️  NONE — set SUPABASE_SERVICE_ROLE_KEY'}`);

  // Ensure Supabase Storage bucket exists on startup
  if (supaStorage) {
    await supaStorage.ensureBucket();
  }
});

export default app;
