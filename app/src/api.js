// ═══════════════════════════════════════════════════════════════════
// FILO — API Service Layer
// Handles all backend communication, JWT tokens, auth state
// ═══════════════════════════════════════════════════════════════════

const API_BASE = import.meta.env.VITE_API_URL || 'https://filo-api-production.up.railway.app/api';

// ─── Token Management ────────────────────────────────────────────

function getToken() {
  return localStorage.getItem('filo_token');
}

function getRefreshToken() {
  return localStorage.getItem('filo_refresh_token');
}

function setTokens(token, refreshToken) {
  localStorage.setItem('filo_token', token);
  if (refreshToken) localStorage.setItem('filo_refresh_token', refreshToken);
}

function clearTokens() {
  localStorage.removeItem('filo_token');
  localStorage.removeItem('filo_refresh_token');
  localStorage.removeItem('filo_user');
  // Clear wizard PII data on logout
  localStorage.removeItem('filo_wizard_checkpoint');
  localStorage.removeItem('filo_removal_preview');
  localStorage.removeItem('filo_bed_edge_preview');
}

function getStoredUser() {
  try {
    const raw = localStorage.getItem('filo_user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function setStoredUser(user) {
  localStorage.setItem('filo_user', JSON.stringify(user));
}

// ─── Core Fetch Helper ───────────────────────────────────────────

async function apiFetch(path, options = {}) {
  const url = `${API_BASE}${path}`;

  // Pro-actively refresh token if it's about to expire (within 60s)
  // This prevents FormData/stream body from being consumed on a 401 retry
  let token = getToken();
  if (token) {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      if (payload.exp && (payload.exp * 1000 - Date.now()) < 60000) {
        const refreshed = await refreshAccessToken();
        if (refreshed) {
          token = getToken();
        }
      }
    } catch { /* ignore decode errors */ }
  }

  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // If sending FormData (file upload), remove Content-Type so browser sets boundary
  const isFormData = options.body instanceof FormData;
  if (isFormData) {
    delete headers['Content-Type'];
  }

  let response;
  try {
    // 3 minute timeout for AI image endpoints (Gemini can be slow)
    const controller = new AbortController();
    const timeoutMs = path.includes('removal-preview') || path.includes('bed-edge-preview') || path.includes('design-render') || path.includes('generate-design') || path.includes('design-adjust') || path.includes('design-hardscape') || path.includes('design-night-mode') || path.includes('plants/import') || path.includes('clients/import') || path.includes('/pdf') || path.includes('submittals/generate') ? 180000 : 30000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
      body: isFormData ? options.body : (options.body ? JSON.stringify(options.body) : undefined),
    });
    clearTimeout(timeoutId);
  } catch (networkErr) {
    if (networkErr.name === 'AbortError') {
      throw new Error('Request timed out. The server is still processing — try again in a moment.');
    }
    throw new Error(`Network error: Could not reach server. Check your connection. (${networkErr.message})`);
  }

  // Handle 401 — try to refresh token once (only for non-FormData, since streams can't be re-sent)
  if (response.status === 401 && getRefreshToken() && !isFormData) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      // Retry the original request with new token
      headers['Authorization'] = `Bearer ${getToken()}`;
      const retryController = new AbortController();
      const retryTimeoutMs = path.includes('removal-preview') || path.includes('bed-edge-preview') || path.includes('design-render') || path.includes('generate-design') || path.includes('design-adjust') || path.includes('design-hardscape') || path.includes('design-night-mode') || path.includes('plants/import') || path.includes('clients/import') || path.includes('/pdf') || path.includes('submittals/generate') ? 180000 : 30000;
      const retryTimeout = setTimeout(() => retryController.abort(), retryTimeoutMs);
      response = await fetch(url, {
        ...options,
        headers,
        signal: retryController.signal,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      clearTimeout(retryTimeout);
    } else {
      clearTokens();
      window.location.href = '/';
      throw new Error('Session expired. Please log in again.');
    }
  } else if (response.status === 401) {
    clearTokens();
    window.location.href = '/';
    throw new Error('Session expired. Please log in again.');
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    // Subscription locked — fire global event so App can show lockout screen
    if (error.code === 'SUBSCRIPTION_LOCKED') {
      window.dispatchEvent(new CustomEvent('filo:subscription-locked'));
    }
    throw new Error(error.error || error.message || `Request failed: ${response.status}`);
  }

  if (response.status === 204 || response.headers.get('content-length') === '0') return {};
  return response.json();
}

// Mutex: prevent concurrent refresh attempts from racing and invalidating each other
let refreshPromise = null;

async function refreshAccessToken() {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const refreshToken = getRefreshToken();
      if (!refreshToken) return false;

      const response = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!response.ok) return false;

      const data = await response.json();
      // Store both tokens — if backend rotates refresh token, we must save the new one
      setTokens(data.token, data.refreshToken);
      return true;
    } catch {
      return false;
    }
  })();

  try {
    return await refreshPromise;
  } finally {
    refreshPromise = null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════

export const auth = {
  async register({ companyName, email, password, firstName, lastName, phone }) {
    const data = await apiFetch('/auth/register', {
      method: 'POST',
      body: { companyName, email, password, firstName, lastName, phone },
    });
    setTokens(data.token, data.refreshToken);
    setStoredUser(data.user);
    return data;
  },

  async login(email, password) {
    const data = await apiFetch('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    setTokens(data.token, data.refreshToken);
    setStoredUser(data.user);
    return data;
  },

  async logout() {
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } catch {
      // Logout even if API call fails
    }
    clearTokens();
  },

  getUser() {
    return getStoredUser();
  },

  isLoggedIn() {
    return !!getToken() && !!getStoredUser();
  },

  async invite({ email, firstName, lastName, role }) {
    return apiFetch('/auth/invite', {
      method: 'POST',
      body: { email, firstName, lastName, role },
    });
  },

  async acceptInvite(inviteToken, password) {
    const data = await apiFetch('/auth/accept-invite', {
      method: 'POST',
      body: { inviteToken, password },
    });
    setTokens(data.token, data.refreshToken);
    setStoredUser(data.user);
    return data;
  },

  async forgotPassword(email) {
    return apiFetch('/auth/forgot-password', {
      method: 'POST',
      body: { email },
    });
  },

  async resetPassword(token, password) {
    return apiFetch('/auth/reset-password', {
      method: 'POST',
      body: { token, password },
    });
  },

  async forgotEmail({ firstName, lastName, phone }) {
    return apiFetch('/auth/forgot-email', {
      method: 'POST',
      body: { firstName, lastName, phone },
    });
  },
};

// ═══════════════════════════════════════════════════════════════════
// COMPANY
// ═══════════════════════════════════════════════════════════════════

export const company = {
  async get() {
    return apiFetch('/company');
  },

  async update(fields) {
    return apiFetch('/company', { method: 'PUT', body: fields });
  },

  async completeOnboarding() {
    return apiFetch('/company/onboarding', { method: 'PUT' });
  },
};

// ═══════════════════════════════════════════════════════════════════
// CLIENTS
// ═══════════════════════════════════════════════════════════════════

export const clients = {
  async list(params = {}) {
    const query = new URLSearchParams(params).toString();
    return apiFetch(`/clients${query ? `?${query}` : ''}`);
  },

  async create(client) {
    return apiFetch('/clients', { method: 'POST', body: client });
  },

  async get(id) {
    return apiFetch(`/clients/${id}`);
  },

  async update(id, fields) {
    return apiFetch(`/clients/${id}`, { method: 'PUT', body: fields });
  },

  async delete(id) {
    return apiFetch(`/clients/${id}`, { method: 'DELETE' });
  },

  async import(file) {
    const formData = new FormData();
    formData.append('file', file);
    return apiFetch('/clients/import', { method: 'POST', body: formData });
  },
};

// ═══════════════════════════════════════════════════════════════════
// PROJECTS
// ═══════════════════════════════════════════════════════════════════

export const projects = {
  async list(params = {}) {
    const query = new URLSearchParams(params).toString();
    return apiFetch(`/projects${query ? `?${query}` : ''}`);
  },

  async create(project) {
    return apiFetch('/projects', { method: 'POST', body: project });
  },

  async get(id) {
    return apiFetch(`/projects/${id}`);
  },

  async update(id, fields) {
    return apiFetch(`/projects/${id}`, { method: 'PUT', body: fields });
  },

  async updateStatus(id, status) {
    return apiFetch(`/projects/${id}/status`, { method: 'PUT', body: { status } });
  },

  // Areas
  async getAreas(projectId) {
    return apiFetch(`/projects/${projectId}/areas`);
  },

  async createArea(projectId, area) {
    return apiFetch(`/projects/${projectId}/areas`, { method: 'POST', body: area });
  },

  // AI Design Generation
  async generateDesign(projectId, options = {}) {
    return apiFetch(`/projects/${projectId}/designs/generate`, { method: 'POST', body: options });
  },

  // Estimates
  async generateEstimate(projectId) {
    return apiFetch(`/projects/${projectId}/estimates/generate`, { method: 'POST' });
  },

  // Submittals
  async generateSubmittal(projectId) {
    return apiFetch(`/projects/${projectId}/submittals/generate`, { method: 'POST' });
  },

  async listSubmittals(projectId) {
    return apiFetch(`/projects/${projectId}/submittals`);
  },

  // Revisions
  async getRevisions(projectId) {
    return apiFetch(`/projects/${projectId}/revisions`);
  },

  // Export all project files
  async exportAll(projectId) {
    return apiFetch(`/projects/${projectId}/export`);
  },
};

// ═══════════════════════════════════════════════════════════════════
// PLANTS
// ═══════════════════════════════════════════════════════════════════

export const plants = {
  async list(params = {}) {
    const query = new URLSearchParams(params).toString();
    return apiFetch(`/plants${query ? `?${query}` : ''}`);
  },

  async get(id) {
    return apiFetch(`/plants/${id}`);
  },

  async create(plant) {
    return apiFetch('/plants', { method: 'POST', body: plant });
  },

  async update(id, fields) {
    return apiFetch(`/plants/${id}`, { method: 'PUT', body: fields });
  },

  async import(file) {
    const formData = new FormData();
    formData.append('file', file);
    return apiFetch('/plants/import', { method: 'POST', body: formData });
  },

  async importList(file) {
    return plants.import(file);
  },

  async delete(id) {
    return apiFetch(`/plants/${id}`, { method: 'DELETE' });
  },

  async deleteAll() {
    return apiFetch('/plants/all?confirm=true', { method: 'DELETE' });
  },
};

// ═══════════════════════════════════════════════════════════════════
// EXISTING PLANTS (detected in photos)
// ═══════════════════════════════════════════════════════════════════

export const existingPlants = {
  async list(areaId) {
    return apiFetch(`/areas/${areaId}/existing-plants`);
  },

  async mark(plantId, mark, comment, rename) {
    return apiFetch(`/existing-plants/${plantId}/mark`, {
      method: 'PUT',
      body: { mark, comment, rename },
    });
  },

  async add(areaId, { name, mark, position_x, position_y, comment }) {
    return apiFetch(`/areas/${areaId}/existing-plants`, {
      method: 'POST',
      body: { name, mark, position_x, position_y, comment },
    });
  },

  async remove(plantId) {
    return apiFetch(`/existing-plants/${plantId}`, { method: 'DELETE' });
  },
};

// ═══════════════════════════════════════════════════════════════════
// REMOVAL PREVIEW
// ═══════════════════════════════════════════════════════════════════

export const removalPreview = {
  async generate(photoUrl, removalAreas, projectContext, maskDataUrl) {
    return apiFetch('/removal-preview', {
      method: 'POST',
      body: { photoUrl, removalAreas, projectContext, maskDataUrl },
    });
  },
};

// ═══════════════════════════════════════════════════════════════════
// BED EDGE PREVIEW
// ═══════════════════════════════════════════════════════════════════

export const bedEdgePreview = {
  async generate(photoUrl, maskDataUrl, edgeStyle, adjustmentFeet) {
    return apiFetch('/bed-edge-preview', {
      method: 'POST',
      body: { photoUrl, maskDataUrl, edgeStyle, adjustmentFeet },
    });
  },
};

// ═══════════════════════════════════════════════════════════════════
// DESIGN RENDER (Final installed look)
// ═══════════════════════════════════════════════════════════════════

export const designRender = {
  async generate(photoUrl, designPlants, keptPlants, removedPlants, designStyle, narrative, maskDataUrl, plantPins) {
    return apiFetch('/design-render', {
      method: 'POST',
      body: { photoUrl, designPlants, keptPlants, removedPlants, designStyle, narrative, maskDataUrl, plantPins },
    });
  },
};

// ═══════════════════════════════════════════════════════════════════
// DESIGN ADJUST (pin-based localized edits)
// ═══════════════════════════════════════════════════════════════════

export const designAdjust = {
  async apply(renderDataUrl, pinX, pinY, radius, prompt) {
    return apiFetch('/design-adjust', {
      method: 'POST',
      body: { renderDataUrl, pinX, pinY, radius, prompt },
    });
  },
};

// ═══════════════════════════════════════════════════════════════════
// NIGHT MODE (Gemini — nighttime render with landscape lighting)
// ═══════════════════════════════════════════════════════════════════

export const nightMode = {
  async generate(renderDataUrl) {
    return apiFetch('/design-night-mode', {
      method: 'POST',
      body: { renderDataUrl },
    });
  },
};

// ═══════════════════════════════════════════════════════════════════
// HARDSCAPE (Gemini — draw + apply hardscape changes)
// ═══════════════════════════════════════════════════════════════════

export const hardscape = {
  async apply(renderDataUrl, maskDataUrl, prompt) {
    return apiFetch('/design-hardscape', {
      method: 'POST',
      body: { renderDataUrl, maskDataUrl, prompt },
    });
  },
};

// ═══════════════════════════════════════════════════════════════════
// SAVED PROMPTS (user-created reusable design prompts)
// ═══════════════════════════════════════════════════════════════════

export const savedPrompts = {
  async list() {
    return apiFetch('/saved-prompts');
  },
  async create(name, prompt) {
    return apiFetch('/saved-prompts', { method: 'POST', body: { name, prompt } });
  },
  async remove(id) {
    return apiFetch(`/saved-prompts/${id}`, { method: 'DELETE' });
  },
};

// ═══════════════════════════════════════════════════════════════════
// DESIGNS
// ═══════════════════════════════════════════════════════════════════

export const designs = {
  async get(id) {
    return apiFetch(`/designs/${id}`);
  },

  async chat(designId, message) {
    return apiFetch(`/designs/${designId}/chat`, {
      method: 'POST',
      body: { message },
    });
  },

  async addPlant(designId, plant) {
    return apiFetch(`/designs/${designId}/plants`, { method: 'POST', body: plant });
  },

  async movePlant(plantId, positionX, positionY) {
    return apiFetch(`/design-plants/${plantId}/position`, {
      method: 'PUT',
      body: { positionX, positionY },
    });
  },

  async removePlant(plantId) {
    return apiFetch(`/design-plants/${plantId}`, { method: 'DELETE' });
  },
};

// ═══════════════════════════════════════════════════════════════════
// ESTIMATES
// ═══════════════════════════════════════════════════════════════════

export const estimates = {
  async list(params = {}) {
    const query = new URLSearchParams(params).toString();
    return apiFetch(`/estimates${query ? `?${query}` : ''}`);
  },

  async get(id) {
    return apiFetch(`/estimates/${id}`);
  },

  async update(id, fields) {
    return apiFetch(`/estimates/${id}`, { method: 'PUT', body: fields });
  },

  async addLineItem(estimateId, item) {
    return apiFetch(`/estimates/${estimateId}/line-items`, {
      method: 'POST',
      body: item,
    });
  },

  async updateLineItem(estimateId, lineItemId, fields) {
    return apiFetch(`/estimates/${estimateId}/line-items/${lineItemId}`, {
      method: 'PUT',
      body: fields,
    });
  },

  async approve(id) {
    return apiFetch(`/estimates/${id}/approve`, { method: 'PUT' });
  },

  async generatePDF(id, type = 'customer') {
    return apiFetch(`/estimates/${id}/pdf`, { method: 'POST', body: { type } });
  },

  async generateAllPDFs(id) {
    return apiFetch(`/estimates/${id}/pdf/all`, { method: 'POST' });
  },
};

// ═══════════════════════════════════════════════════════════════════
// SUBMITTALS
// ═══════════════════════════════════════════════════════════════════

export const submittals = {
  async get(id) {
    return apiFetch(`/submittals/${id}`);
  },

  async update(id, fields) {
    return apiFetch(`/submittals/${id}`, { method: 'PUT', body: fields });
  },

  async generatePDF(id, { designRenderUrl } = {}) {
    return apiFetch(`/submittals/${id}/pdf`, {
      method: 'POST',
      body: { designRenderUrl },
    });
  },

  async pushToCRM(id) {
    return apiFetch(`/submittals/${id}/pdf-and-push`, { method: 'POST' });
  },
};

// ═══════════════════════════════════════════════════════════════════
// FILE UPLOADS
// ═══════════════════════════════════════════════════════════════════

export const files = {
  async upload(file, fileType) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('fileType', fileType);
    return apiFetch('/upload', { method: 'POST', body: formData });
  },

  async uploadPhotos(areaId, photos) {
    const formData = new FormData();
    for (const photo of photos) {
      formData.append('photos', photo);
    }
    return apiFetch(`/upload/photos/${areaId}`, { method: 'POST', body: formData });
  },

  async getPresignedUrl(fileName, fileType, contentType) {
    return apiFetch('/upload/presign', {
      method: 'POST',
      body: { fileName, fileType, contentType },
    });
  },

  async download(fileId) {
    return apiFetch(`/files/${fileId}/download`);
  },
};

// ═══════════════════════════════════════════════════════════════════
// CRM
// ═══════════════════════════════════════════════════════════════════

export const crm = {
  async status() {
    return apiFetch('/crm/status');
  },

  async connect(provider, credentials) {
    return apiFetch('/crm/connect', { method: 'POST', body: { provider, credentials } });
  },

  async disconnect() {
    return apiFetch('/crm/disconnect', { method: 'POST' });
  },

  async syncProject(projectId) {
    return apiFetch(`/crm/sync/full/${projectId}`, { method: 'POST' });
  },

  async providers() {
    return apiFetch('/crm/providers');
  },

  async syncLog() {
    return apiFetch('/crm/sync-log');
  },
};

// ═══════════════════════════════════════════════════════════════════
// TEAM
// ═══════════════════════════════════════════════════════════════════

export const team = {
  async list() {
    return apiFetch('/team');
  },

  async update(userId, fields) {
    return apiFetch(`/team/${userId}`, { method: 'PUT', body: fields });
  },

  async remove(userId) {
    return apiFetch(`/team/${userId}`, { method: 'DELETE' });
  },
};

// ═══════════════════════════════════════════════════════════════════
// BILLING
// ═══════════════════════════════════════════════════════════════════

export const billing = {
  async status() {
    return apiFetch('/billing/status');
  },

  async subscribe(paymentMethodId) {
    return apiFetch('/billing/subscribe', { method: 'POST', body: { paymentMethodId } });
  },

  async checkout(successUrl, cancelUrl) {
    return apiFetch('/billing/checkout', { method: 'POST', body: { successUrl, cancelUrl } });
  },

  async portal(returnUrl) {
    return apiFetch('/billing/portal', { method: 'POST', body: { returnUrl } });
  },

  async cancel(immediate = false) {
    return apiFetch('/billing/cancel', { method: 'POST', body: { immediate } });
  },

  async reactivate() {
    return apiFetch('/billing/reactivate', { method: 'POST' });
  },

  async pause() {
    return apiFetch('/billing/pause', { method: 'POST' });
  },

  async resume() {
    return apiFetch('/billing/resume', { method: 'POST' });
  },

  async invoices() {
    return apiFetch('/billing/invoices');
  },

  async upcoming() {
    return apiFetch('/billing/upcoming');
  },

  async addUser() {
    return apiFetch('/billing/add-user', { method: 'POST' });
  },

  async removeUser() {
    return apiFetch('/billing/remove-user', { method: 'POST' });
  },

  async updatePaymentMethod(paymentMethodId) {
    return apiFetch('/billing/payment-method', { method: 'PUT', body: { paymentMethodId } });
  },
};

// ═══════════════════════════════════════════════════════════════════
// Admin (Developer Portal — super_admin users only)
// ═══════════════════════════════════════════════════════════════════

export const admin = {
  async stats() { return apiFetch('/admin/stats'); },
  async listCompanies(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`/admin/companies${qs ? '?' + qs : ''}`);
  },
  async getCompany(id) { return apiFetch(`/admin/companies/${id}`); },
  async listUsers(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`/admin/users${qs ? '?' + qs : ''}`);
  },
  async resetUserPassword(userId) {
    return apiFetch(`/admin/users/${userId}/reset-password`, { method: 'POST' });
  },
  async unlockCompany(companyId) {
    return apiFetch(`/admin/companies/${companyId}/unlock`, { method: 'POST' });
  },
  async recentActivity(limit = 100) { return apiFetch(`/admin/activity?limit=${limit}`); },
  async webhookEvents(limit = 100) { return apiFetch(`/admin/webhook-events?limit=${limit}`); },
};

// ═══════════════════════════════════════════════════════════════════
// AI (direct proxy calls)
// ═══════════════════════════════════════════════════════════════════

export const ai = {
  async detectPlants(photoUrl, areaId, location, usdaZone) {
    return apiFetch('/ai/detect-plants', {
      method: 'POST',
      body: { imageUrl: photoUrl, areaId, location, usdaZone },
    });
  },

  async generateDesign(projectId, options) {
    return apiFetch(`/projects/${projectId}/designs/generate`, {
      method: 'POST',
      body: options,
    });
  },

  async chat(designId, message) {
    return apiFetch(`/designs/${designId}/chat`, {
      method: 'POST',
      body: { message },
    });
  },

  async health() {
    return apiFetch('/ai/health');
  },
};

// ═══════════════════════════════════════════════════════════════════
// EXPORT ALL
// ═══════════════════════════════════════════════════════════════════

const api = {
  auth,
  company,
  clients,
  projects,
  plants,
  existingPlants,
  removalPreview,
  bedEdgePreview,
  designRender,
  designAdjust,
  nightMode,
  hardscape,
  savedPrompts,
  designs,
  estimates,
  submittals,
  files,
  crm,
  team,
  billing,
  ai,
};

export default api;
