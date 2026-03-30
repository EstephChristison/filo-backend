// ═══════════════════════════════════════════════════════════════════
// FILO — CRM Integration Framework
// Universal adapter pattern with specific implementations for:
// Jobber, ServiceTitan, LMN, Aspire, SingleOps, Housecall Pro,
// Arborgold, Service Autopilot, Yardbook
// ONE-WAY SYNC ONLY: FILO → CRM (never writes destructively)
// ═══════════════════════════════════════════════════════════════════

// ─── Base CRM Adapter (Abstract) ─────────────────────────────────

class BaseCRMAdapter {
  constructor(integration, db) {
    this.integration = integration;
    this.db = db;
    this.provider = integration.provider;
    this.config = integration.config || {};
    this.baseUrl = integration.base_url;
  }

  // ─── Auth helpers ────────────────────────────────────────────

  get headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.integration.oauth_access_token || this.integration.api_key}`,
    };
  }

  async refreshTokenIfNeeded() {
    if (!this.integration.oauth_refresh_token) return;
    if (this.integration.oauth_token_expires && new Date(this.integration.oauth_token_expires) > new Date()) return;

    try {
      const newTokens = await this.refreshOAuthToken();
      await this.db.query(
        `UPDATE crm_integrations SET oauth_access_token = $1, oauth_refresh_token = $2, oauth_token_expires = $3 WHERE id = $4`,
        [newTokens.accessToken, newTokens.refreshToken || this.integration.oauth_refresh_token, newTokens.expiresAt, this.integration.id]
      );
      this.integration.oauth_access_token = newTokens.accessToken;
    } catch (err) {
      console.error(`[CRM:${this.provider}] Token refresh failed:`, err);
      throw new Error('CRM authentication expired. Please reconnect.');
    }
  }

  async refreshOAuthToken() {
    throw new Error('refreshOAuthToken() must be implemented by subclass');
  }

  // ─── HTTP helpers ────────────────────────────────────────────

  async request(method, path, body = null) {
    await this.refreshTokenIfNeeded();

    const url = `${this.baseUrl}${path}`;
    const options = { method, headers: this.headers };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(url, options);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`CRM API error ${response.status}: ${errorBody}`);
    }

    const contentType = response.headers.get('content-type');
    return contentType?.includes('json') ? response.json() : response.text();
  }

  async get(path) { return this.request('GET', path); }
  async post(path, body) { return this.request('POST', path, body); }
  async put(path, body) { return this.request('PUT', path, body); }
  async patch(path, body) { return this.request('PATCH', path, body); }

  // ─── Abstract methods (implement per CRM) ────────────────────

  async pushClient(client) { throw new Error('pushClient() not implemented'); }
  async pushProject(project, client) { throw new Error('pushProject() not implemented'); }
  async pushEstimate(estimate, project, client) { throw new Error('pushEstimate() not implemented'); }
  async pushDocument(fileUrl, fileName, clientExternalId) { throw new Error('pushDocument() not implemented'); }
  async testConnection() { throw new Error('testConnection() not implemented'); }

  // ─── Sync logging ────────────────────────────────────────────

  async logSync(entityType, entityId, action, status, requestPayload, responsePayload, error = null) {
    await this.db.query(
      `INSERT INTO crm_sync_log (crm_integration_id, company_id, entity_type, entity_id, action, status, request_payload, response_payload, error_message, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [this.integration.id, this.integration.company_id, entityType, entityId, action, status, requestPayload, responsePayload, error, status === 'synced' ? new Date() : null]
    );

    if (status === 'synced') {
      await this.db.query('UPDATE crm_integrations SET last_sync_at = NOW(), last_sync_status = $1 WHERE id = $2', ['success', this.integration.id]);
    } else if (status === 'failed') {
      await this.db.query('UPDATE crm_integrations SET last_sync_status = $1, last_error = $2 WHERE id = $3', ['failed', error, this.integration.id]);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// JOBBER ADAPTER
// ═══════════════════════════════════════════════════════════════════

class JobberAdapter extends BaseCRMAdapter {
  constructor(integration, db) {
    super(integration, db);
    this.baseUrl = 'https://api.getjobber.com/api';
    this.graphqlUrl = 'https://api.getjobber.com/api/graphql';
  }

  get headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.integration.oauth_access_token}`,
      'X-JOBBER-GRAPHQL-VERSION': '2024-12-18',
    };
  }

  async graphql(query, variables = {}) {
    await this.refreshTokenIfNeeded();
    const response = await fetch(this.graphqlUrl, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ query, variables }),
    });
    const data = await response.json();
    if (data.errors) throw new Error(`Jobber GraphQL: ${data.errors[0].message}`);
    return data.data;
  }

  async refreshOAuthToken() {
    const response = await fetch('https://api.getjobber.com/api/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: this.integration.oauth_refresh_token,
        client_id: this.integration.oauth_client_id,
      }),
    });
    const data = await response.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + data.expires_in * 1000),
    };
  }

  async testConnection() {
    const data = await this.graphql('{ account { name } }');
    return { connected: true, accountName: data.account.name };
  }

  async pushClient(client) {
    try {
      const mutation = `
        mutation CreateClient($input: ClientCreateInput!) {
          clientCreate(input: $input) {
            client { id name }
            userErrors { message path }
          }
        }
      `;
      const input = {
        firstName: client.first_name || client.display_name,
        lastName: client.last_name || '',
        companyName: client.display_name,
        emails: client.email ? [{ description: 'MAIN', primary: true, address: client.email }] : [],
        phones: client.phone ? [{ description: 'MAIN', primary: true, number: client.phone }] : [],
        billingAddress: client.address_line1 ? {
          street1: client.address_line1, street2: client.address_line2,
          city: client.city, province: client.state, postalCode: client.zip,
        } : undefined,
      };

      const data = await this.graphql(mutation, { input });
      const externalId = data.clientCreate.client.id;

      await this.db.query('UPDATE clients SET crm_external_id = $1, crm_synced_at = NOW() WHERE id = $2', [externalId, client.id]);
      await this.logSync('client', client.id, 'create', 'synced', input, data);

      return { externalId };
    } catch (err) {
      await this.logSync('client', client.id, 'create', 'failed', null, null, err.message);
      throw err;
    }
  }

  async pushProject(project, client) {
    try {
      // Jobber uses "Requests" or "Jobs" — we'll create a Job
      const mutation = `
        mutation CreateJob($input: JobCreateInput!) {
          jobCreate(input: $input) {
            job { id title }
            userErrors { message path }
          }
        }
      `;
      const input = {
        clientId: client.crm_external_id,
        title: `${project.project_number} — ${client.display_name}`,
        instructions: `Design Style: ${project.design_style || 'Naturalistic'}\nSun: ${project.sun_exposure || 'Full sun'}\n${project.special_requests || ''}`,
      };

      const data = await this.graphql(mutation, { input });
      const externalId = data.jobCreate.job.id;

      await this.db.query('UPDATE projects SET crm_external_id = $1, crm_sync_status = $2, crm_synced_at = NOW() WHERE id = $3', [externalId, 'synced', project.id]);
      await this.logSync('project', project.id, 'create', 'synced', input, data);

      return { externalId };
    } catch (err) {
      await this.logSync('project', project.id, 'create', 'failed', null, null, err.message);
      throw err;
    }
  }

  async pushEstimate(estimate, project, client) {
    try {
      // Jobber Quotes
      const lineItems = await this.db.getMany('SELECT * FROM estimate_line_items WHERE estimate_id = $1 ORDER BY sort_order', [estimate.id]);
      const mutation = `
        mutation CreateQuote($input: QuoteCreateInput!) {
          quoteCreate(input: $input) {
            quote { id quoteNumber }
            userErrors { message path }
          }
        }
      `;
      const input = {
        clientId: client.crm_external_id,
        jobId: project.crm_external_id,
        title: `Landscape Design — ${project.project_number}`,
        lineItems: lineItems.map(li => ({
          name: li.description,
          description: li.notes || '',
          quantity: parseFloat(li.quantity),
          unitPrice: parseFloat(li.unit_price),
        })),
      };

      const data = await this.graphql(mutation, { input });
      await this.logSync('estimate', estimate.id, 'create', 'synced', input, data);

      return { externalId: data.quoteCreate?.quote?.id };
    } catch (err) {
      await this.logSync('estimate', estimate.id, 'create', 'failed', null, null, err.message);
      throw err;
    }
  }

  async pushDocument(fileUrl, fileName, clientExternalId) {
    // Jobber note attachment
    try {
      const mutation = `
        mutation CreateNote($input: NoteCreateInput!) {
          noteCreate(input: $input) {
            note { id }
            userErrors { message path }
          }
        }
      `;
      const data = await this.graphql(mutation, {
        input: { clientId: clientExternalId, message: `FILO Document: ${fileName}\n${fileUrl}` }
      });
      return data;
    } catch (err) {
      console.error(`[Jobber] Document push failed: ${err.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// SERVICETITAN ADAPTER
// ═══════════════════════════════════════════════════════════════════

class ServiceTitanAdapter extends BaseCRMAdapter {
  constructor(integration, db) {
    super(integration, db);
    this.baseUrl = 'https://api.servicetitan.io';
    this.tenantId = this.config.tenantId;
  }

  get headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.integration.oauth_access_token}`,
      'ST-App-Key': this.integration.api_key,
    };
  }

  async testConnection() {
    const data = await this.get(`/settings/v2/tenant/${this.tenantId}/business-units`);
    return { connected: true, businessUnits: data.data?.length || 0 };
  }

  async pushClient(client) {
    try {
      const payload = {
        name: client.display_name,
        type: 'Residential',
        address: { street: client.address_line1, city: client.city, state: client.state, zip: client.zip, country: 'US' },
        contacts: [{
          type: 'Email', value: client.email,
        }],
      };

      const data = await this.post(`/crm/v2/tenant/${this.tenantId}/customers`, payload);
      await this.db.query('UPDATE clients SET crm_external_id = $1, crm_synced_at = NOW() WHERE id = $2', [String(data.id), client.id]);
      await this.logSync('client', client.id, 'create', 'synced', payload, data);
      return { externalId: String(data.id) };
    } catch (err) {
      await this.logSync('client', client.id, 'create', 'failed', null, null, err.message);
      throw err;
    }
  }

  async pushProject(project, client) {
    try {
      const payload = {
        customerId: parseInt(client.crm_external_id),
        typeId: this.config.jobTypeId,
        summary: `${project.project_number} — Landscape Design`,
      };
      const data = await this.post(`/jpm/v2/tenant/${this.tenantId}/jobs`, payload);
      await this.db.query('UPDATE projects SET crm_external_id = $1, crm_sync_status = $2, crm_synced_at = NOW() WHERE id = $3', [String(data.id), 'synced', project.id]);
      await this.logSync('project', project.id, 'create', 'synced', payload, data);
      return { externalId: String(data.id) };
    } catch (err) {
      await this.logSync('project', project.id, 'create', 'failed', null, null, err.message);
      throw err;
    }
  }

  async pushEstimate(estimate, project, client) {
    try {
      const lineItems = await this.db.getMany('SELECT * FROM estimate_line_items WHERE estimate_id = $1 ORDER BY sort_order', [estimate.id]);
      const payload = {
        jobId: parseInt(project.crm_external_id),
        items: lineItems.map(li => ({
          description: li.description,
          quantity: parseFloat(li.quantity),
          unitRate: parseFloat(li.unit_price),
        })),
      };
      const data = await this.post(`/jpm/v2/tenant/${this.tenantId}/estimates`, payload);
      await this.logSync('estimate', estimate.id, 'create', 'synced', payload, data);
      return { externalId: String(data.id) };
    } catch (err) {
      await this.logSync('estimate', estimate.id, 'create', 'failed', null, null, err.message);
      throw err;
    }
  }

  async pushDocument(fileUrl, fileName, clientExternalId) { /* ServiceTitan document upload */ }
}

// ═══════════════════════════════════════════════════════════════════
// GENERIC REST ADAPTER (LMN, Aspire, SingleOps, etc.)
// ═══════════════════════════════════════════════════════════════════

class GenericRESTAdapter extends BaseCRMAdapter {
  constructor(integration, db) {
    super(integration, db);
    this.baseUrl = integration.base_url;
    this.endpoints = integration.config?.endpoints || {};
  }

  async testConnection() {
    try {
      await this.get(this.endpoints.test || '/api/v1/me');
      return { connected: true };
    } catch {
      return { connected: false };
    }
  }

  async pushClient(client) {
    const endpoint = this.endpoints.createClient || '/api/v1/clients';
    const payload = this.mapClientPayload(client);
    try {
      const data = await this.post(endpoint, payload);
      const externalId = data.id || data.clientId || data.data?.id;
      await this.db.query('UPDATE clients SET crm_external_id = $1, crm_synced_at = NOW() WHERE id = $2', [String(externalId), client.id]);
      await this.logSync('client', client.id, 'create', 'synced', payload, data);
      return { externalId: String(externalId) };
    } catch (err) {
      await this.logSync('client', client.id, 'create', 'failed', payload, null, err.message);
      throw err;
    }
  }

  async pushProject(project, client) {
    const endpoint = this.endpoints.createJob || '/api/v1/jobs';
    const payload = this.mapProjectPayload(project, client);
    try {
      const data = await this.post(endpoint, payload);
      const externalId = data.id || data.jobId || data.data?.id;
      await this.db.query('UPDATE projects SET crm_external_id = $1, crm_sync_status = $2, crm_synced_at = NOW() WHERE id = $3', [String(externalId), 'synced', project.id]);
      await this.logSync('project', project.id, 'create', 'synced', payload, data);
      return { externalId: String(externalId) };
    } catch (err) {
      await this.logSync('project', project.id, 'create', 'failed', payload, null, err.message);
      throw err;
    }
  }

  async pushEstimate(estimate, project, client) {
    const endpoint = this.endpoints.createEstimate || '/api/v1/estimates';
    const lineItems = await this.db.getMany('SELECT * FROM estimate_line_items WHERE estimate_id = $1 ORDER BY sort_order', [estimate.id]);
    const payload = this.mapEstimatePayload(estimate, lineItems, project, client);
    try {
      const data = await this.post(endpoint, payload);
      await this.logSync('estimate', estimate.id, 'create', 'synced', payload, data);
      return { externalId: data.id || data.estimateId };
    } catch (err) {
      await this.logSync('estimate', estimate.id, 'create', 'failed', payload, null, err.message);
      throw err;
    }
  }

  async pushDocument(fileUrl, fileName, clientExternalId) {
    const endpoint = this.endpoints.uploadDocument || '/api/v1/documents';
    try {
      await this.post(endpoint, { clientId: clientExternalId, name: fileName, url: fileUrl });
    } catch (err) {
      console.error(`[${this.provider}] Document push failed: ${err.message}`);
    }
  }

  // ─── Payload mappers (override per CRM for field naming) ─────

  mapClientPayload(client) {
    return {
      name: client.display_name,
      firstName: client.first_name, lastName: client.last_name,
      email: client.email, phone: client.phone,
      address: client.address_line1, city: client.city, state: client.state, zip: client.zip,
    };
  }

  mapProjectPayload(project, client) {
    return {
      clientId: client.crm_external_id, title: `${project.project_number} - Landscape Design`,
      description: project.special_requests || '', address: project.property_address,
    };
  }

  mapEstimatePayload(estimate, lineItems, project, client) {
    return {
      clientId: client.crm_external_id, jobId: project.crm_external_id,
      total: parseFloat(estimate.total),
      lineItems: lineItems.map(li => ({
        description: li.description, quantity: parseFloat(li.quantity),
        unitPrice: parseFloat(li.unit_price), total: parseFloat(li.total_price),
      })),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════
// CRM-SPECIFIC ADAPTERS (extend GenericREST with custom mappings)
// ═══════════════════════════════════════════════════════════════════

class LMNAdapter extends GenericRESTAdapter {
  constructor(i, db) { super(i, db); this.baseUrl = i.base_url || 'https://api.golmn.com/v2'; }
  mapClientPayload(c) { return { companyName: c.display_name, contactFirstName: c.first_name, contactLastName: c.last_name, contactEmail: c.email, contactPhone: c.phone, street: c.address_line1, city: c.city, stateProv: c.state, postalZip: c.zip }; }
}

class AspireAdapter extends GenericRESTAdapter {
  constructor(i, db) { super(i, db); this.baseUrl = i.base_url || 'https://cloud-api.youraspire.com/v1'; }
  mapClientPayload(c) { return { Name: c.display_name, Email: c.email, Phone: c.phone, Address1: c.address_line1, City: c.city, State: c.state, Zip: c.zip, CustomerType: 'Residential' }; }
}

class SingleOpsAdapter extends GenericRESTAdapter {
  constructor(i, db) { super(i, db); this.baseUrl = i.base_url || 'https://api.singleops.com/api/v3'; }
}

class HousecallProAdapter extends GenericRESTAdapter {
  constructor(i, db) { super(i, db); this.baseUrl = i.base_url || 'https://api.housecallpro.com/v1'; }
  get headers() { return { ...super.headers, 'Authorization': `Token ${this.integration.api_key}` }; }
  mapClientPayload(c) { return { first_name: c.first_name || c.display_name, last_name: c.last_name || '', email: c.email, mobile_number: c.phone, company: c.display_name, addresses: [{ street: c.address_line1, city: c.city, state: c.state, zip: c.zip }] }; }
}

class ArborgoldAdapter extends GenericRESTAdapter {
  constructor(i, db) { super(i, db); this.baseUrl = i.base_url || 'https://api.arborgold.com/api/v1'; }
}

class ServiceAutopilotAdapter extends GenericRESTAdapter {
  constructor(i, db) { super(i, db); this.baseUrl = i.base_url || 'https://api.serviceautopilot.com/api/v1'; }
}

class YardbookAdapter extends GenericRESTAdapter {
  constructor(i, db) { super(i, db); this.baseUrl = i.base_url || 'https://app.yardbook.com/api/v1'; }
}

// ═══════════════════════════════════════════════════════════════════
// CRM MANAGER (Factory + Orchestrator)
// ═══════════════════════════════════════════════════════════════════

const ADAPTER_MAP = {
  jobber: JobberAdapter,
  servicetitan: ServiceTitanAdapter,
  lmn: LMNAdapter,
  aspire: AspireAdapter,
  singleops: SingleOpsAdapter,
  housecall_pro: HousecallProAdapter,
  arborgold: ArborgoldAdapter,
  service_autopilot: ServiceAutopilotAdapter,
  yardbook: YardbookAdapter,
};

export default class CRMManager {
  constructor(db) {
    this.db = db;
  }

  getAdapter(integration) {
    const AdapterClass = ADAPTER_MAP[integration.provider] || GenericRESTAdapter;
    return new AdapterClass(integration, this.db);
  }

  async getActiveIntegration(companyId) {
    return this.db.getOne(
      'SELECT * FROM crm_integrations WHERE company_id = $1 AND is_active = true LIMIT 1',
      [companyId]
    );
  }

  // ─── Sync Operations ──────────────────────────────────────────

  async syncClient(companyId, clientId) {
    const integration = await this.getActiveIntegration(companyId);
    if (!integration) return { skipped: true, reason: 'No active CRM integration' };

    const client = await this.db.getOne('SELECT * FROM clients WHERE id = $1', [clientId]);
    const adapter = this.getAdapter(integration);

    return adapter.pushClient(client);
  }

  async syncProject(companyId, projectId) {
    const integration = await this.getActiveIntegration(companyId);
    if (!integration) return { skipped: true };

    const project = await this.db.getOne('SELECT * FROM projects WHERE id = $1', [projectId]);
    const client = await this.db.getOne('SELECT * FROM clients WHERE id = $1', [project.client_id]);
    const adapter = this.getAdapter(integration);

    // Ensure client is synced first
    if (!client.crm_external_id) {
      await adapter.pushClient(client);
      // Reload client to get external ID
      const updatedClient = await this.db.getOne('SELECT * FROM clients WHERE id = $1', [client.id]);
      Object.assign(client, updatedClient);
    }

    return adapter.pushProject(project, client);
  }

  async syncEstimate(companyId, estimateId) {
    const integration = await this.getActiveIntegration(companyId);
    if (!integration) return { skipped: true };

    const estimate = await this.db.getOne('SELECT * FROM estimates WHERE id = $1', [estimateId]);
    const project = await this.db.getOne('SELECT * FROM projects WHERE id = $1', [estimate.project_id]);
    const client = await this.db.getOne('SELECT * FROM clients WHERE id = $1', [project.client_id]);
    const adapter = this.getAdapter(integration);

    // Ensure project is synced first
    if (!project.crm_external_id) {
      await this.syncProject(companyId, project.id);
      const updatedProject = await this.db.getOne('SELECT * FROM projects WHERE id = $1', [project.id]);
      Object.assign(project, updatedProject);
    }

    return adapter.pushEstimate(estimate, project, client);
  }

  async syncDocument(companyId, fileUrl, fileName, clientId) {
    const integration = await this.getActiveIntegration(companyId);
    if (!integration) return { skipped: true };

    const client = await this.db.getOne('SELECT * FROM clients WHERE id = $1', [clientId]);
    if (!client.crm_external_id) return { skipped: true, reason: 'Client not synced to CRM' };

    const adapter = this.getAdapter(integration);
    return adapter.pushDocument(fileUrl, fileName, client.crm_external_id);
  }

  // ─── Full project sync (called at Step 10) ────────────────────

  async syncFullProject(companyId, projectId) {
    const results = { client: null, project: null, estimate: null, submittal: null, documents: [] };

    try {
      const project = await this.db.getOne('SELECT * FROM projects WHERE id = $1', [projectId]);
      const client = await this.db.getOne('SELECT * FROM clients WHERE id = $1', [project.client_id]);

      // 1. Sync client
      results.client = await this.syncClient(companyId, client.id);

      // 2. Sync project
      results.project = await this.syncProject(companyId, projectId);

      // 3. Sync estimate
      const estimate = await this.db.getOne('SELECT * FROM estimates WHERE project_id = $1 AND is_current = true', [projectId]);
      if (estimate) {
        results.estimate = await this.syncEstimate(companyId, estimate.id);
      }

      // 4. Sync submittal PDF
      const submittal = await this.db.getOne(
        'SELECT s.*, f.cdn_url FROM submittals s LEFT JOIN files f ON f.id = s.pdf_file_id WHERE s.project_id = $1 AND s.is_current = true',
        [projectId]
      );
      if (submittal?.cdn_url) {
        results.submittal = await this.syncDocument(companyId, submittal.cdn_url, 'Submittal.pdf', client.id);
      }

      // 5. Sync before/after images
      const photos = await this.db.getMany(
        `SELECT f.cdn_url, f.original_name FROM photos p JOIN files f ON f.id = p.file_id
         JOIN property_areas pa ON pa.id = p.property_area_id WHERE pa.project_id = $1`,
        [projectId]
      );
      for (const photo of photos) {
        const docResult = await this.syncDocument(companyId, photo.cdn_url, photo.original_name, client.id);
        results.documents.push(docResult);
      }

      // Update project sync status
      await this.db.query(
        "UPDATE projects SET crm_sync_status = 'synced', crm_synced_at = NOW() WHERE id = $1",
        [projectId]
      );

      return { success: true, results };
    } catch (err) {
      await this.db.query(
        "UPDATE projects SET crm_sync_status = 'failed' WHERE id = $1",
        [projectId]
      );
      return { success: false, error: err.message, results };
    }
  }

  // ─── Connection management ─────────────────────────────────────

  async testConnection(companyId) {
    const integration = await this.getActiveIntegration(companyId);
    if (!integration) return { connected: false, reason: 'No CRM configured' };

    const adapter = this.getAdapter(integration);
    return adapter.testConnection();
  }

  async connect(companyId, provider, credentials) {
    // Deactivate existing
    await this.db.query('UPDATE crm_integrations SET is_active = false WHERE company_id = $1', [companyId]);

    const integration = await this.db.getOne(
      `INSERT INTO crm_integrations (company_id, provider, api_key, api_secret, oauth_access_token, oauth_refresh_token, oauth_client_id, base_url, config, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)
       ON CONFLICT (company_id, provider) DO UPDATE SET
         api_key = EXCLUDED.api_key, oauth_access_token = EXCLUDED.oauth_access_token,
         oauth_refresh_token = EXCLUDED.oauth_refresh_token, is_active = true
       RETURNING *`,
      [companyId, provider, credentials.apiKey, credentials.apiSecret, credentials.accessToken, credentials.refreshToken, credentials.clientId, credentials.baseUrl, credentials.config || {}]
    );

    // Test connection
    const adapter = this.getAdapter(integration);
    const test = await adapter.testConnection();

    return { integration, connectionTest: test };
  }

  async disconnect(companyId) {
    await this.db.query('UPDATE crm_integrations SET is_active = false WHERE company_id = $1', [companyId]);
    return { disconnected: true };
  }
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES (mount on main app)
// ═══════════════════════════════════════════════════════════════════

export function mountCRMRoutes(app, crmManager, authenticate, requireAdmin) {

  // Test CRM connection
  app.get('/api/crm/status', authenticate, async (req, res) => {
    const result = await crmManager.testConnection(req.user.companyId);
    res.json(result);
  });

  // Connect CRM
  app.post('/api/crm/connect', authenticate, requireAdmin, async (req, res) => {
    try {
      const { provider, credentials } = req.body;
      const result = await crmManager.connect(req.user.companyId, provider, credentials);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Disconnect CRM
  app.post('/api/crm/disconnect', authenticate, requireAdmin, async (req, res) => {
    const result = await crmManager.disconnect(req.user.companyId);
    res.json(result);
  });

  // Sync specific entity
  app.post('/api/crm/sync/client/:clientId', authenticate, async (req, res) => {
    const result = await crmManager.syncClient(req.user.companyId, req.params.clientId);
    res.json(result);
  });

  app.post('/api/crm/sync/project/:projectId', authenticate, async (req, res) => {
    const result = await crmManager.syncProject(req.user.companyId, req.params.projectId);
    res.json(result);
  });

  app.post('/api/crm/sync/estimate/:estimateId', authenticate, async (req, res) => {
    const result = await crmManager.syncEstimate(req.user.companyId, req.params.estimateId);
    res.json(result);
  });

  // Full project sync (Step 10)
  app.post('/api/crm/sync/full/:projectId', authenticate, async (req, res) => {
    const result = await crmManager.syncFullProject(req.user.companyId, req.params.projectId);
    res.json(result);
  });

  // Get sync log
  app.get('/api/crm/sync-log', authenticate, async (req, res) => {
    const logs = await crmManager.db.getMany(
      `SELECT * FROM crm_sync_log WHERE company_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.companyId]
    );
    res.json(logs);
  });

  // Available CRM providers
  app.get('/api/crm/providers', authenticate, (req, res) => {
    res.json([
      { id: 'jobber', name: 'Jobber', authType: 'oauth', popular: true },
      { id: 'servicetitan', name: 'ServiceTitan', authType: 'oauth', popular: true },
      { id: 'lmn', name: 'LMN', authType: 'api_key', popular: true },
      { id: 'aspire', name: 'Aspire', authType: 'api_key', popular: true },
      { id: 'singleops', name: 'SingleOps', authType: 'api_key', popular: false },
      { id: 'housecall_pro', name: 'Housecall Pro', authType: 'api_key', popular: true },
      { id: 'arborgold', name: 'Arborgold', authType: 'api_key', popular: false },
      { id: 'service_autopilot', name: 'Service Autopilot', authType: 'api_key', popular: false },
      { id: 'yardbook', name: 'Yardbook', authType: 'api_key', popular: false },
    ]);
  });
}
