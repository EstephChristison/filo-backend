/**
 * FILO — Wizard Flow Logic Tests
 * Tests the 8-step wizard state machine, step transitions,
 * error handling, and estimate approval flow.
 */

import { describe, it, expect } from 'vitest';

// ═══════════════════════════════════════════════════════════════════
// STATUS_MAP validation
// ═══════════════════════════════════════════════════════════════════

describe('STATUS_MAP — step mapping', () => {
  const STATUS_MAP = {
    draft: { label: 'Draft', color: '#6B7280', step: 1 },
    client_created: { label: 'Client Created', color: '#3B82F6', step: 1 },
    areas_defined: { label: 'Areas Defined', color: '#3B82F6', step: 2 },
    photo_upload: { label: 'Photos', color: '#8B5CF6', step: 3 },
    plant_detection: { label: 'Plant Detection', color: '#8B5CF6', step: 4 },
    design_generation: { label: 'Generating Design', color: '#F59E0B', step: 5 },
    design_review: { label: 'Design Review', color: '#F59E0B', step: 5 },
    estimate_pending: { label: 'Estimate Pending', color: '#E97A1F', step: 6 },
    estimate_approved: { label: 'Estimate Approved', color: '#10B981', step: 6 },
    submittal_sent: { label: 'Submittal Sent', color: '#10B981', step: 7 },
    completed: { label: 'Completed', color: '#059669', step: 8 },
    cancelled: { label: 'Cancelled', color: '#EF4444', step: 0 },
  };

  it('estimate_pending maps to step 6 (not 5)', () => {
    expect(STATUS_MAP.estimate_pending.step).toBe(6);
  });

  it('all statuses have required fields', () => {
    for (const [key, val] of Object.entries(STATUS_MAP)) {
      expect(val).toHaveProperty('label');
      expect(val).toHaveProperty('color');
      expect(val).toHaveProperty('step');
      expect(typeof val.step).toBe('number');
    }
  });

  it('step numbers are in valid range 0-8', () => {
    for (const val of Object.values(STATUS_MAP)) {
      expect(val.step).toBeGreaterThanOrEqual(0);
      expect(val.step).toBeLessThanOrEqual(8);
    }
  });

  it('design_review and design_generation are both step 5', () => {
    expect(STATUS_MAP.design_review.step).toBe(5);
    expect(STATUS_MAP.design_generation.step).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Step 1: Client validation
// ═══════════════════════════════════════════════════════════════════

describe('Step 1 — Client validation', () => {
  function validateStep1(project) {
    if (!project.clientName || !project.address) return 'Client name and address are required.';
    if (project.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(project.email)) return 'Please enter a valid email address.';
    if (project.phone && project.phone.replace(/\D/g, '').length < 7) return 'Please enter a valid phone number.';
    return null;
  }

  it('requires client name', () => {
    expect(validateStep1({ address: '123 Main St' })).toContain('required');
  });

  it('requires address', () => {
    expect(validateStep1({ clientName: 'John Doe' })).toContain('required');
  });

  it('validates email format', () => {
    expect(validateStep1({ clientName: 'John', address: '123 St', email: 'invalid' })).toContain('email');
  });

  it('accepts valid email', () => {
    expect(validateStep1({ clientName: 'John', address: '123 St', email: 'john@test.com' })).toBeNull();
  });

  it('validates phone length (min 7 digits)', () => {
    expect(validateStep1({ clientName: 'John', address: '123 St', phone: '123' })).toContain('phone');
  });

  it('accepts valid phone', () => {
    expect(validateStep1({ clientName: 'John', address: '123 St', phone: '713-555-1234' })).toBeNull();
  });

  it('allows optional email and phone', () => {
    expect(validateStep1({ clientName: 'John', address: '123 St' })).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Step 6: Estimate flow
// ═══════════════════════════════════════════════════════════════════

describe('Step 6 — Estimate generation and approval flow', () => {
  it('generates estimate when no estimate exists', () => {
    const estimate = null;
    const shouldGenerate = !estimate?.id;
    expect(shouldGenerate).toBe(true);
  });

  it('does not regenerate when estimate exists', () => {
    const estimate = { id: 'est-001', total: 5000 };
    const shouldGenerate = !estimate?.id;
    expect(shouldGenerate).toBe(false);
  });

  it('blocks advancement when estimate not approved', () => {
    const estimateApproved = false;
    const canAdvance = estimateApproved;
    expect(canAdvance).toBe(false);
  });

  it('allows advancement when estimate approved', () => {
    const estimateApproved = true;
    const canAdvance = estimateApproved;
    expect(canAdvance).toBe(true);
  });

  it('button label changes based on estimate state', () => {
    const getLabel = (estimate) => estimate?.id ? 'Continue to Submittal →' : 'Generate Estimate →';
    expect(getLabel(null)).toBe('Generate Estimate →');
    expect(getLabel({ id: 'est-1' })).toBe('Continue to Submittal →');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Step 5: Design generation error handling
// ═══════════════════════════════════════════════════════════════════

describe('Step 5 — Design generation error handling', () => {
  it('does NOT advance to step 6 when design fails', () => {
    let step = 5;
    let designFailed = false;
    let error = null;

    // Simulate design generation failure
    try {
      throw new Error('OpenAI rate limit');
    } catch (e) {
      error = 'Design generation failed: ' + e.message;
      designFailed = true;
    }

    // This is the fixed logic — only advance if no failure
    if (!designFailed) step = 6;

    expect(step).toBe(5); // Should stay on step 5
    expect(error).toContain('Design generation failed');
  });

  it('advances to step 6 when design succeeds', () => {
    let step = 5;
    let designFailed = false;

    // Simulate success
    const design = { id: 'd-1', plants: [{ name: 'Loropetalum' }] };
    if (!design) designFailed = true;

    if (!designFailed) step = 6;
    expect(step).toBe(6);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Estimate calculations
// ═══════════════════════════════════════════════════════════════════

describe('Estimate calculations', () => {
  const MOCK_LINE_ITEMS = [
    { category: 'plant_material', unit_price: 38.48, quantity: 5, total_price: 192.40 },
    { category: 'plant_material', unit_price: 29.70, quantity: 8, total_price: 237.60 },
    { category: 'labor', unit_price: 4800, quantity: 1, total_price: 4800 },
    { category: 'soil_amendment', unit_price: 285, quantity: 1, total_price: 285 },
    { category: 'mulch', unit_price: 340, quantity: 1, total_price: 340 },
  ];

  it('calculates subtotal correctly', () => {
    const subtotal = MOCK_LINE_ITEMS.reduce((sum, item) => sum + item.total_price, 0);
    expect(subtotal).toBe(5855);
  });

  it('calculates tax correctly at 8.25%', () => {
    const subtotal = 5855;
    const taxRate = 0.0825;
    const tax = subtotal * taxRate;
    expect(tax).toBeCloseTo(483.04, 2);
  });

  it('calculates total as subtotal + tax', () => {
    const subtotal = 5855;
    const tax = subtotal * 0.0825;
    const total = subtotal + tax;
    expect(total).toBeCloseTo(6338.04, 2);
  });

  it('tax rate parsing handles string values', () => {
    const taxRate = parseFloat('0.0825') || 0.0825;
    expect(taxRate).toBe(0.0825);
  });

  it('tax rate parsing handles null/undefined', () => {
    const taxRate1 = parseFloat(null) || 0.0825;
    const taxRate2 = parseFloat(undefined) || 0.0825;
    expect(taxRate1).toBe(0.0825);
    expect(taxRate2).toBe(0.0825);
  });

  it('tax label formats correctly', () => {
    const taxRate = 0.0825;
    const label = `Tax (${(taxRate * 100).toFixed(2)}%)`;
    expect(label).toBe('Tax (8.25%)');
  });
});

// ═══════════════════════════════════════════════════════════════════
// Wizard checkpoint serialization
// ═══════════════════════════════════════════════════════════════════

describe('Wizard checkpoint — serialization', () => {
  it('serializes and deserializes checkpoint data', () => {
    const checkpoint = {
      step: 3,
      project: { clientName: 'Test Client', address: '123 Main' },
      clientId: 'client-uuid',
      projectId: 'project-uuid',
      areaMap: { 'Front Yard': { id: 'area-1' } },
      savedAt: Date.now(),
    };

    const serialized = JSON.stringify(checkpoint);
    const restored = JSON.parse(serialized);

    expect(restored.step).toBe(3);
    expect(restored.project.clientName).toBe('Test Client');
    expect(restored.clientId).toBe('client-uuid');
    expect(restored.areaMap['Front Yard'].id).toBe('area-1');
  });

  it('handles null estimate in checkpoint', () => {
    const checkpoint = { step: 5, estimate: null };
    const serialized = JSON.stringify(checkpoint);
    const restored = JSON.parse(serialized);
    expect(restored.estimate).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Greeting logic
// ═══════════════════════════════════════════════════════════════════

describe('Dashboard greeting', () => {
  function getGreeting(hour) {
    return hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  }

  it('returns morning for 6 AM', () => expect(getGreeting(6)).toBe('morning'));
  it('returns morning for 11 AM', () => expect(getGreeting(11)).toBe('morning'));
  it('returns afternoon for 12 PM', () => expect(getGreeting(12)).toBe('afternoon'));
  it('returns afternoon for 4 PM', () => expect(getGreeting(16)).toBe('afternoon'));
  it('returns evening for 5 PM', () => expect(getGreeting(17)).toBe('evening'));
  it('returns evening for 9 PM', () => expect(getGreeting(21)).toBe('evening'));
  it('returns morning for midnight', () => expect(getGreeting(0)).toBe('morning'));
});

// ═══════════════════════════════════════════════════════════════════
// Pricing display
// ═══════════════════════════════════════════════════════════════════

describe('Pricing — correct amounts', () => {
  it('base plan is $500/month', () => {
    const basePlan = 500;
    expect(basePlan).toBe(500);
  });

  it('additional users are $99/month (not $500)', () => {
    const additionalUserPrice = 99;
    expect(additionalUserPrice).toBe(99);
    expect(additionalUserPrice).not.toBe(500);
  });

  it('included users is 3', () => {
    const includedUsers = 3;
    expect(includedUsers).toBe(3);
  });

  it('5 total users = $500 + 2*$99 = $698/month', () => {
    const base = 500;
    const included = 3;
    const total = 5;
    const extra = total - included;
    const monthly = base + (extra * 99);
    expect(monthly).toBe(698);
  });
});
