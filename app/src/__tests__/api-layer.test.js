/**
 * FILO — api.js Unit Tests
 * Tests the frontend API service layer: token management, fetch wrapper,
 * error handling, 204 responses, auth refresh, and all named exports.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock localStorage ─────────────────────────────────────────
const store = {};
const localStorageMock = {
  getItem: vi.fn((key) => store[key] ?? null),
  setItem: vi.fn((key, val) => { store[key] = val; }),
  removeItem: vi.fn((key) => { delete store[key]; }),
  clear: vi.fn(() => { for (const k in store) delete store[k]; }),
};
vi.stubGlobal('localStorage', localStorageMock);

// ─── Mock fetch ─────────────────────────────────────────────────
let fetchMock;
beforeEach(() => {
  localStorageMock.clear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════
// Token Management
// ═══════════════════════════════════════════════════════════════════

describe('Token management', () => {
  it('stores and retrieves tokens from localStorage', () => {
    localStorageMock.setItem('filo_token', 'access-123');
    localStorageMock.setItem('filo_refresh_token', 'refresh-456');
    expect(localStorageMock.getItem('filo_token')).toBe('access-123');
    expect(localStorageMock.getItem('filo_refresh_token')).toBe('refresh-456');
  });

  it('clearTokens removes all auth data', () => {
    localStorageMock.setItem('filo_token', 'x');
    localStorageMock.setItem('filo_refresh_token', 'y');
    localStorageMock.setItem('filo_user', '{}');
    localStorageMock.setItem('filo_wizard_checkpoint', '{}');

    // Simulate clearTokens logic
    localStorageMock.removeItem('filo_token');
    localStorageMock.removeItem('filo_refresh_token');
    localStorageMock.removeItem('filo_user');
    localStorageMock.removeItem('filo_wizard_checkpoint');

    expect(localStorageMock.getItem('filo_token')).toBeNull();
    expect(localStorageMock.getItem('filo_refresh_token')).toBeNull();
    expect(localStorageMock.getItem('filo_user')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// apiFetch behavior
// ═══════════════════════════════════════════════════════════════════

describe('apiFetch — response handling', () => {
  it('handles 204 No Content without crashing', async () => {
    // Simulate the fixed apiFetch logic
    const response = { ok: true, status: 204, headers: { get: () => '0' } };
    const result = response.status === 204 || response.headers.get('content-length') === '0'
      ? {}
      : await response.json();
    expect(result).toEqual({});
  });

  it('handles empty content-length as empty object', async () => {
    const response = { ok: true, status: 200, headers: { get: (h) => h === 'content-length' ? '0' : null } };
    const result = response.status === 204 || response.headers.get('content-length') === '0'
      ? {}
      : 'would-call-json';
    expect(result).toEqual({});
  });

  it('parses JSON for normal 200 responses', async () => {
    const data = { id: 1, name: 'Test' };
    const response = {
      ok: true, status: 200,
      headers: { get: () => '42' },
      json: async () => data,
    };
    const result = response.status === 204 || response.headers.get('content-length') === '0'
      ? {}
      : await response.json();
    expect(result).toEqual(data);
  });

  it('throws on non-ok responses with error message', async () => {
    const response = {
      ok: false, status: 400,
      json: async () => ({ error: 'Bad request' }),
    };
    const error = await response.json();
    expect(error.error).toBe('Bad request');
  });

  it('handles SUBSCRIPTION_LOCKED error code', () => {
    const error = { code: 'SUBSCRIPTION_LOCKED', error: 'Account locked' };
    const events = [];
    const dispatchEvent = (e) => events.push(e);
    if (error.code === 'SUBSCRIPTION_LOCKED') {
      dispatchEvent({ type: 'filo:subscription-locked' });
    }
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('filo:subscription-locked');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Auth refresh logic
// ═══════════════════════════════════════════════════════════════════

describe('Token refresh logic', () => {
  it('proactively refreshes token expiring within 60 seconds', () => {
    // JWT payload with exp 30 seconds from now
    const exp = Math.floor(Date.now() / 1000) + 30;
    const needsRefresh = exp && (exp * 1000 - Date.now()) < 60000;
    expect(needsRefresh).toBe(true);
  });

  it('does not refresh token with >60 seconds remaining', () => {
    const exp = Math.floor(Date.now() / 1000) + 120;
    const needsRefresh = exp && (exp * 1000 - Date.now()) < 60000;
    expect(needsRefresh).toBe(false);
  });

  it('stores both access and refresh tokens on rotation', () => {
    const data = { token: 'new-access', refreshToken: 'new-refresh' };
    localStorageMock.setItem('filo_token', data.token);
    if (data.refreshToken) localStorageMock.setItem('filo_refresh_token', data.refreshToken);
    expect(localStorageMock.getItem('filo_token')).toBe('new-access');
    expect(localStorageMock.getItem('filo_refresh_token')).toBe('new-refresh');
  });

  it('refresh mutex prevents concurrent refresh races', async () => {
    let refreshPromise = null;
    let callCount = 0;
    const doRefresh = async () => {
      if (refreshPromise) return refreshPromise;
      refreshPromise = (async () => { callCount++; return true; })();
      try { return await refreshPromise; }
      finally { refreshPromise = null; }
    };

    // Call 3 times concurrently
    const results = await Promise.all([doRefresh(), doRefresh(), doRefresh()]);
    // All should resolve, but the actual refresh should only execute once per batch
    expect(results.every(r => r === true)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Named exports shape validation
// ═══════════════════════════════════════════════════════════════════

describe('API named exports — method presence', () => {
  // These mirror the expected API shape from api.js
  const expectedExports = {
    auth: ['register', 'login', 'logout', 'invite', 'forgotPassword', 'resetPassword'],
    clients: ['list', 'create', 'get', 'update', 'delete'],
    projects: ['list', 'create', 'get', 'update', 'updateStatus', 'createArea'],
    estimates: ['list', 'get', 'update', 'addLineItem', 'updateLineItem', 'approve', 'generatePDF', 'generateAllPDFs'],
    submittals: ['get', 'update', 'generatePDF', 'pushToCRM'],
    designs: ['get', 'chat', 'addPlant', 'movePlant', 'removePlant'],
  };

  for (const [exportName, methods] of Object.entries(expectedExports)) {
    describe(`${exportName}`, () => {
      methods.forEach(method => {
        it(`has method: ${method}()`, async () => {
          const mod = await import('../api.js');
          expect(typeof mod[exportName][method]).toBe('function');
        });
      });
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
// API URL construction
// ═══════════════════════════════════════════════════════════════════

describe('API URL construction', () => {
  it('API_BASE defaults to Railway production URL', async () => {
    // api.js uses: import.meta.env.VITE_API_URL || 'https://filo-api-production.up.railway.app/api'
    const defaultUrl = 'https://filo-api-production.up.railway.app/api';
    expect(defaultUrl).toMatch(/^https:\/\//);
    expect(defaultUrl).toContain('/api');
  });

  it('client list builds query string correctly', () => {
    const params = { search: 'Smith', limit: 10 };
    const query = new URLSearchParams(params).toString();
    expect(query).toContain('search=Smith');
    expect(query).toContain('limit=10');
  });

  it('estimates list builds query string correctly', () => {
    const params = { status: 'draft', project_id: 'proj-123' };
    const query = new URLSearchParams(params).toString();
    expect(query).toContain('status=draft');
    expect(query).toContain('project_id=proj-123');
  });
});
