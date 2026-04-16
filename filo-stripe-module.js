// ═══════════════════════════════════════════════════════════════════
// FILO — Stripe Subscription Management Module
// Handles: $500/mo base plan (3 users), $99/mo per additional user,
// subscription lifecycle, webhooks, lockout enforcement
// ═══════════════════════════════════════════════════════════════════

import Stripe from 'stripe';
import express from 'express';

// ─── Configuration ───────────────────────────────────────────────

const PLAN_CONFIG = {
  BASE_MONTHLY_PRICE: 500_00,        // $500 in cents
  ADDITIONAL_USER_PRICE: 99_00,      // $99 in cents
  INCLUDED_USERS: 3,
  TRIAL_DAYS: 1,
  CURRENCY: 'usd',
  PRODUCT_NAME: 'FILO Professional',
  BASE_PRICE_LOOKUP: 'filo_professional_monthly',
  USER_PRICE_LOOKUP: 'filo_additional_user_monthly',
};

export default class StripeManager {
  constructor(db, config) {
    this.stripe = new Stripe(config.secretKey);
    this.db = db;
    this.webhookSecret = config.webhookSecret;
  }

  // ═══════════════════════════════════════════════════════════════
  // PRODUCT & PRICE SETUP (run once during deployment)
  // ═══════════════════════════════════════════════════════════════

  async initializeProducts() {
    // Create or retrieve FILO product
    let product;
    const existing = await this.stripe.products.list({ limit: 1 });
    const filoProduct = existing.data.find(p => p.metadata?.filo_product === 'true');

    if (filoProduct) {
      product = filoProduct;
    } else {
      product = await this.stripe.products.create({
        name: PLAN_CONFIG.PRODUCT_NAME,
        description: 'AI-Powered Landscape Design Platform — Professional Plan',
        metadata: { filo_product: 'true' },
      });
    }

    // Find or create base subscription price
    const existingBasePrices = await this.stripe.prices.list({ product: product.id, lookup_keys: [PLAN_CONFIG.BASE_PRICE_LOOKUP], limit: 1 });
    const basePrice = existingBasePrices.data[0] || await this.stripe.prices.create({
      product: product.id,
      unit_amount: PLAN_CONFIG.BASE_MONTHLY_PRICE,
      currency: PLAN_CONFIG.CURRENCY,
      recurring: { interval: 'month' },
      lookup_key: PLAN_CONFIG.BASE_PRICE_LOOKUP,
      metadata: { type: 'base_plan', included_users: String(PLAN_CONFIG.INCLUDED_USERS) },
    });

    // Find or create per-user price
    const existingUserPrices = await this.stripe.prices.list({ product: product.id, lookup_keys: [PLAN_CONFIG.USER_PRICE_LOOKUP], limit: 1 });
    const userPrice = existingUserPrices.data[0] || await this.stripe.prices.create({
      product: product.id,
      unit_amount: PLAN_CONFIG.ADDITIONAL_USER_PRICE,
      currency: PLAN_CONFIG.CURRENCY,
      recurring: { interval: 'month' },
      lookup_key: PLAN_CONFIG.USER_PRICE_LOOKUP,
      metadata: { type: 'additional_user' },
    });

    return { product, basePrice, userPrice };
  }

  // ═══════════════════════════════════════════════════════════════
  // CUSTOMER MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  async createCustomer(companyId, email, companyName) {
    const customer = await this.stripe.customers.create({
      email,
      name: companyName,
      metadata: { filo_company_id: companyId },
    });

    await this.db.query(
      'UPDATE companies SET stripe_customer_id = $1 WHERE id = $2',
      [customer.id, companyId]
    );

    return customer;
  }

  async getOrCreateCustomer(companyId) {
    const company = await this.db.getOne('SELECT * FROM companies WHERE id = $1', [companyId]);

    if (company.stripe_customer_id) {
      try {
        return await this.stripe.customers.retrieve(company.stripe_customer_id);
      } catch (e) {
        // Customer was deleted in Stripe, recreate
      }
    }

    return this.createCustomer(companyId, company.email, company.name);
  }

  async updateCustomerPaymentMethod(companyId, paymentMethodId) {
    const customer = await this.getOrCreateCustomer(companyId);

    await this.stripe.paymentMethods.attach(paymentMethodId, { customer: customer.id });
    await this.stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    return { success: true };
  }

  // ═══════════════════════════════════════════════════════════════
  // SUBSCRIPTION LIFECYCLE
  // ═══════════════════════════════════════════════════════════════

  async createSubscription(companyId, paymentMethodId) {
    const customer = await this.getOrCreateCustomer(companyId);

    // Attach payment method
    if (paymentMethodId) {
      await this.stripe.paymentMethods.attach(paymentMethodId, { customer: customer.id });
      await this.stripe.customers.update(customer.id, {
        invoice_settings: { default_payment_method: paymentMethodId },
      });
    }

    // Get prices by lookup key
    const basePrices = await this.stripe.prices.list({ lookup_keys: [PLAN_CONFIG.BASE_PRICE_LOOKUP], limit: 1 });
    if (!basePrices.data.length) throw new Error('Base price not found. Run initializeProducts() first.');

    // Count current additional users
    const userCount = await this.db.getOne(
      'SELECT COUNT(*) FROM users WHERE company_id = $1 AND is_active = true',
      [companyId]
    );
    const additionalUsers = Math.max(0, parseInt(userCount.count) - PLAN_CONFIG.INCLUDED_USERS);

    const items = [{ price: basePrices.data[0].id, quantity: 1 }];

    if (additionalUsers > 0) {
      const userPrices = await this.stripe.prices.list({ lookup_keys: [PLAN_CONFIG.USER_PRICE_LOOKUP], limit: 1 });
      if (userPrices.data.length) {
        items.push({ price: userPrices.data[0].id, quantity: additionalUsers });
      }
    }

    const subscription = await this.stripe.subscriptions.create({
      customer: customer.id,
      items,
      trial_period_days: PLAN_CONFIG.TRIAL_DAYS,
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent'],
      metadata: { filo_company_id: companyId },
    });

    // Store in database
    await this.db.query(
      `INSERT INTO subscriptions (company_id, stripe_subscription_id, status, base_amount, additional_user_amount, included_users, additional_users, trial_end, current_period_start, current_period_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8), to_timestamp($9), to_timestamp($10))
       ON CONFLICT (stripe_subscription_id) DO UPDATE SET
         status = EXCLUDED.status, current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end`,
      [companyId, subscription.id, this.mapStatus(subscription.status),
        PLAN_CONFIG.BASE_MONTHLY_PRICE / 100, PLAN_CONFIG.ADDITIONAL_USER_PRICE / 100,
        PLAN_CONFIG.INCLUDED_USERS, additionalUsers,
        subscription.trial_end, subscription.current_period_start, subscription.current_period_end]
    );

    await this.db.query(
      'UPDATE companies SET stripe_subscription_id = $1 WHERE id = $2',
      [subscription.id, companyId]
    );

    return {
      subscriptionId: subscription.id,
      status: subscription.status,
      clientSecret: subscription.latest_invoice?.payment_intent?.client_secret,
      trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
    };
  }

  async addUser(companyId) {
    const company = await this.db.getOne('SELECT stripe_subscription_id FROM companies WHERE id = $1', [companyId]);
    if (!company.stripe_subscription_id) throw new Error('No active subscription');

    const subscription = await this.stripe.subscriptions.retrieve(company.stripe_subscription_id);
    const userItem = subscription.items.data.find(i => i.price.lookup_key === PLAN_CONFIG.USER_PRICE_LOOKUP);

    if (userItem) {
      // Increment quantity
      await this.stripe.subscriptionItems.update(userItem.id, {
        quantity: userItem.quantity + 1,
        proration_behavior: 'create_prorations',
      });
    } else {
      // Add user line item
      const userPrices = await this.stripe.prices.list({ lookup_keys: [PLAN_CONFIG.USER_PRICE_LOOKUP], limit: 1 });
      await this.stripe.subscriptionItems.create({
        subscription: subscription.id,
        price: userPrices.data[0].id,
        quantity: 1,
        proration_behavior: 'create_prorations',
      });
    }

    await this.db.query(
      'UPDATE subscriptions SET additional_users = additional_users + 1 WHERE company_id = $1',
      [companyId]
    );

    return { success: true, message: 'User added. Prorated charge applied.' };
  }

  async removeUser(companyId) {
    const company = await this.db.getOne('SELECT stripe_subscription_id FROM companies WHERE id = $1', [companyId]);
    if (!company.stripe_subscription_id) throw new Error('No active subscription');

    const subscription = await this.stripe.subscriptions.retrieve(company.stripe_subscription_id);
    const userItem = subscription.items.data.find(i => i.price.lookup_key === PLAN_CONFIG.USER_PRICE_LOOKUP);

    if (userItem && userItem.quantity > 1) {
      await this.stripe.subscriptionItems.update(userItem.id, {
        quantity: userItem.quantity - 1,
        proration_behavior: 'create_prorations',
      });
    } else if (userItem && userItem.quantity === 1) {
      await this.stripe.subscriptionItems.del(userItem.id, { proration_behavior: 'create_prorations' });
    }

    await this.db.query(
      'UPDATE subscriptions SET additional_users = GREATEST(0, additional_users - 1) WHERE company_id = $1',
      [companyId]
    );

    return { success: true, message: 'User removed. Prorated credit applied.' };
  }

  async cancelSubscription(companyId, cancelImmediately = false) {
    const company = await this.db.getOne('SELECT stripe_subscription_id FROM companies WHERE id = $1', [companyId]);
    if (!company.stripe_subscription_id) throw new Error('No active subscription');

    let subscription;
    if (cancelImmediately) {
      subscription = await this.stripe.subscriptions.cancel(company.stripe_subscription_id);
    } else {
      subscription = await this.stripe.subscriptions.update(company.stripe_subscription_id, {
        cancel_at_period_end: true,
      });
    }

    await this.db.query(
      `UPDATE subscriptions SET cancel_at_period_end = $1, canceled_at = $2
       WHERE company_id = $3`,
      [!cancelImmediately, new Date(), companyId]
    );

    return {
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancel_at_period_end,
      currentPeriodEnd: new Date(subscription.current_period_end * 1000),
    };
  }

  async reactivateSubscription(companyId) {
    const company = await this.db.getOne('SELECT stripe_subscription_id FROM companies WHERE id = $1', [companyId]);
    if (!company.stripe_subscription_id) throw new Error('No subscription to reactivate');

    const subscription = await this.stripe.subscriptions.update(company.stripe_subscription_id, {
      cancel_at_period_end: false,
    });

    await this.db.query(
      `UPDATE subscriptions SET cancel_at_period_end = false, canceled_at = NULL, status = $1
       WHERE company_id = $2`, [subscription.status === 'active' ? 'active' : subscription.status, companyId]
    );

    return { status: 'active', message: 'Subscription reactivated' };
  }

  async pauseSubscription(companyId) {
    const company = await this.db.getOne('SELECT stripe_subscription_id FROM companies WHERE id = $1', [companyId]);
    if (!company?.stripe_subscription_id) throw new Error('No active subscription');
    const subscription = await this.stripe.subscriptions.update(company.stripe_subscription_id, {
      pause_collection: { behavior: 'mark_uncollectible' },
    });

    await this.db.query("UPDATE subscriptions SET status = 'paused' WHERE company_id = $1", [companyId]);
    return { status: 'paused' };
  }

  async resumeSubscription(companyId) {
    const company = await this.db.getOne('SELECT stripe_subscription_id FROM companies WHERE id = $1', [companyId]);
    if (!company?.stripe_subscription_id) throw new Error('No active subscription');
    const subscription = await this.stripe.subscriptions.update(company.stripe_subscription_id, {
      pause_collection: null,
    });

    await this.db.query("UPDATE subscriptions SET status = 'active' WHERE company_id = $1", [companyId]);
    return { status: 'active' };
  }

  // ═══════════════════════════════════════════════════════════════
  // BILLING PORTAL & INVOICES
  // ═══════════════════════════════════════════════════════════════

  async createBillingPortalSession(companyId, returnUrl) {
    const customer = await this.getOrCreateCustomer(companyId);
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customer.id,
      return_url: returnUrl,
    });
    return { url: session.url };
  }

  async createCheckoutSession(companyId, successUrl, cancelUrl) {
    const customer = await this.getOrCreateCustomer(companyId);
    const basePrices = await this.stripe.prices.list({ lookup_keys: [PLAN_CONFIG.BASE_PRICE_LOOKUP], limit: 1 });

    const session = await this.stripe.checkout.sessions.create({
      customer: customer.id,
      mode: 'subscription',
      line_items: [{ price: basePrices.data[0].id, quantity: 1 }],
      subscription_data: { trial_period_days: PLAN_CONFIG.TRIAL_DAYS, metadata: { filo_company_id: companyId } },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    return { sessionId: session.id, url: session.url };
  }

  async getInvoices(companyId, limit = 12) {
    const customer = await this.getOrCreateCustomer(companyId);
    const invoices = await this.stripe.invoices.list({ customer: customer.id, limit });

    return invoices.data.map(inv => ({
      id: inv.id,
      number: inv.number,
      date: new Date(inv.created * 1000),
      dueDate: inv.due_date ? new Date(inv.due_date * 1000) : null,
      amount: inv.amount_due / 100,
      amountPaid: inv.amount_paid / 100,
      status: inv.status,
      pdfUrl: inv.invoice_pdf,
      hostedUrl: inv.hosted_invoice_url,
    }));
  }

  async getUpcomingInvoice(companyId) {
    const customer = await this.getOrCreateCustomer(companyId);
    try {
      const invoice = await this.stripe.invoices.retrieveUpcoming({ customer: customer.id });
      return {
        amount: invoice.amount_due / 100,
        date: new Date(invoice.next_payment_attempt * 1000),
        lines: invoice.lines.data.map(l => ({
          description: l.description,
          amount: l.amount / 100,
          quantity: l.quantity,
        })),
      };
    } catch (e) {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SUBSCRIPTION STATUS & LOCKOUT
  // ═══════════════════════════════════════════════════════════════

  async getSubscriptionStatus(companyId) {
    const sub = await this.db.getOne(
      `SELECT s.*, c.name as company_name, c.stripe_customer_id
       FROM subscriptions s JOIN companies c ON c.id = s.company_id
       WHERE s.company_id = $1 ORDER BY s.created_at DESC LIMIT 1`,
      [companyId]
    );

    if (!sub) return { status: 'none', isLocked: true, canAccess: false };

    const isLocked = ['canceled', 'locked'].includes(sub.status);
    const isPastDue = sub.status === 'past_due';
    const isTrialing = sub.status === 'trialing';
    const trialExpired = isTrialing && sub.trial_end && new Date(sub.trial_end) < new Date();

    return {
      status: trialExpired ? 'trial_expired' : sub.status,
      isLocked: isLocked || trialExpired,
      canAccess: !isLocked && !trialExpired,
      isPastDue,
      isTrialing: isTrialing && !trialExpired,
      currentPeriodEnd: sub.current_period_end,
      trialEnd: sub.trial_end,
      cancelAtPeriodEnd: sub.cancel_at_period_end,
      baseAmount: sub.base_amount,
      additionalUsers: sub.additional_users,
      monthlyTotal: parseFloat(sub.base_amount) + (sub.additional_users * parseFloat(sub.additional_user_amount)),
    };
  }

  async enforceSubscriptionLockout(companyId) {
    const status = await this.getSubscriptionStatus(companyId);

    if (status.isLocked) {
      // Lock all users
      await this.db.query(
        `UPDATE subscriptions SET status = 'locked' WHERE company_id = $1 AND status NOT IN ('canceled')`,
        [companyId]
      );
      return { locked: true, reason: status.status, message: 'Your subscription has expired. Please update your payment to continue using FILO.' };
    }

    if (status.isPastDue) {
      return { locked: false, warning: true, message: 'Your payment is past due. Please update your payment method to avoid service interruption.' };
    }

    return { locked: false };
  }

  // ═══════════════════════════════════════════════════════════════
  // WEBHOOK HANDLER
  // ═══════════════════════════════════════════════════════════════

  async handleWebhook(rawBody, signature) {
    const event = this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);

    // Log event
    await this.db.query(
      `INSERT INTO webhook_events (source, event_type, event_id, payload)
       VALUES ('stripe', $1, $2, $3) ON CONFLICT (source, event_id) DO NOTHING`,
      [event.type, event.id, JSON.stringify(event.data)]
    );

    const handlers = {
      'customer.subscription.created': (data) => this.handleSubscriptionChange(data.object),
      'customer.subscription.updated': (data) => this.handleSubscriptionChange(data.object),
      'customer.subscription.deleted': (data) => this.handleSubscriptionDeleted(data.object),
      'customer.subscription.paused': (data) => this.handleSubscriptionPaused(data.object),
      'customer.subscription.resumed': (data) => this.handleSubscriptionResumed(data.object),
      'customer.subscription.trial_will_end': (data) => this.handleTrialEnding(data.object),
      'invoice.paid': (data) => this.handleInvoicePaid(data.object),
      'invoice.payment_failed': (data) => this.handlePaymentFailed(data.object),
      'invoice.payment_action_required': (data) => this.handlePaymentActionRequired(data.object),
    };

    const handler = handlers[event.type];
    if (handler) {
      await handler(event.data);
      await this.db.query(
        'UPDATE webhook_events SET processed = true, processed_at = NOW() WHERE event_id = $1 AND source = $2',
        [event.id, 'stripe']
      );
    }

    return { received: true };
  }

  async handleSubscriptionChange(sub) {
    const companyId = sub.metadata?.filo_company_id ||
      (await this.db.getOne('SELECT id FROM companies WHERE stripe_customer_id = $1', [sub.customer]))?.id;

    if (!companyId) return;

    const userItem = sub.items?.data?.find(i => i.price?.lookup_key === PLAN_CONFIG.USER_PRICE_LOOKUP);

    await this.db.query(
      `INSERT INTO subscriptions (status, stripe_subscription_id, current_period_start, current_period_end, cancel_at_period_end, additional_users, trial_end, company_id)
       VALUES ($1, $2, to_timestamp($3), to_timestamp($4), $5, $6, $7, $8)
       ON CONFLICT (company_id) DO UPDATE SET
        status = EXCLUDED.status, stripe_subscription_id = EXCLUDED.stripe_subscription_id,
        current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end,
        cancel_at_period_end = EXCLUDED.cancel_at_period_end, additional_users = EXCLUDED.additional_users,
        trial_end = EXCLUDED.trial_end`,
      [
        this.mapStatus(sub.status), sub.id,
        sub.current_period_start, sub.current_period_end,
        sub.cancel_at_period_end, userItem?.quantity || 0,
        sub.trial_end ? new Date(sub.trial_end * 1000) : null,
        companyId,
      ]
    );
  }

  async handleSubscriptionDeleted(sub) {
    const companyId = sub.metadata?.filo_company_id ||
      (await this.db.getOne('SELECT id FROM companies WHERE stripe_customer_id = $1', [sub.customer]))?.id;

    if (!companyId) return;

    await this.db.query(
      `UPDATE subscriptions SET status = 'canceled', canceled_at = NOW() WHERE company_id = $1`,
      [companyId]
    );

    // Full lockout — log for admin visibility
    await this.db.query(
      `INSERT INTO activity_log (company_id, entity_type, entity_id, action, description)
       VALUES ($1, 'subscription', $2, 'canceled', 'Subscription canceled — account locked')`,
      [companyId, sub.id]
    );
  }

  async handleSubscriptionPaused(sub) {
    const companyId = sub.metadata?.filo_company_id ||
      (await this.db.getOne('SELECT id FROM companies WHERE stripe_customer_id = $1', [sub.customer]))?.id;
    if (companyId) {
      await this.db.query("UPDATE subscriptions SET status = 'paused' WHERE company_id = $1", [companyId]);
    }
  }

  async handleSubscriptionResumed(sub) {
    const companyId = sub.metadata?.filo_company_id ||
      (await this.db.getOne('SELECT id FROM companies WHERE stripe_customer_id = $1', [sub.customer]))?.id;
    if (companyId) {
      await this.db.query("UPDATE subscriptions SET status = 'active' WHERE company_id = $1", [companyId]);
    }
  }

  async handleTrialEnding(sub) {
    // Trial ends in 3 days — send notification email
    const companyId = sub.metadata?.filo_company_id ||
      (await this.db.getOne('SELECT id FROM companies WHERE stripe_customer_id = $1', [sub.customer]))?.id;

    if (companyId) {
      const company = await this.db.getOne('SELECT name, email FROM companies WHERE id = $1', [companyId]);
      // Log in-app notification — no email sent. User sees this in dashboard alerts.
      await this.db.query(
        `INSERT INTO activity_log (company_id, entity_type, action, description)
         VALUES ($1, 'subscription', 'trial_ending', $2)`,
        [companyId, `Trial ending soon for ${company.name}. Add a payment method to continue.`]
      );
    }
  }

  async handleInvoicePaid(invoice) {
    const companyId = (await this.db.getOne(
      'SELECT id FROM companies WHERE stripe_customer_id = $1', [invoice.customer]
    ))?.id;

    if (companyId) {
      // Ensure subscription is active and not locked
      await this.db.query(
        `UPDATE subscriptions SET status = 'active' WHERE company_id = $1 AND status IN ('past_due', 'locked')`,
        [companyId]
      );
    }
  }

  async handlePaymentFailed(invoice) {
    const companyId = (await this.db.getOne(
      'SELECT id FROM companies WHERE stripe_customer_id = $1', [invoice.customer]
    ))?.id;

    if (companyId) {
      await this.db.query("UPDATE subscriptions SET status = 'past_due' WHERE company_id = $1", [companyId]);
      // Log in-app notification — user sees payment failure alert on dashboard
      await this.db.query(
        `INSERT INTO activity_log (company_id, entity_type, action, description)
         VALUES ($1, 'subscription', 'payment_failed', 'Payment failed. Update your payment method to avoid losing access.')`,
        [companyId]
      );
    }
  }

  async handlePaymentActionRequired(invoice) {
    const companyId = (await this.db.getOne(
      'SELECT id FROM companies WHERE stripe_customer_id = $1', [invoice.customer]
    ))?.id;

    if (companyId) {
      // Log in-app notification — user sees alert to complete payment authentication
      await this.db.query(
        `INSERT INTO activity_log (company_id, entity_type, action, description, metadata)
         VALUES ($1, 'subscription', 'payment_action_required', 'Your bank requires additional authentication. Complete payment in Stripe.', $2)`,
        [companyId, JSON.stringify({ hosted_invoice_url: invoice.hosted_invoice_url })]
      );
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────

  mapStatus(stripeStatus) {
    const map = {
      active: 'active', trialing: 'trialing', past_due: 'past_due',
      canceled: 'canceled', incomplete: 'past_due', incomplete_expired: 'locked',
      unpaid: 'locked', paused: 'paused',
    };
    return map[stripeStatus] || 'locked'; // Fail safe — unknown status should restrict access, not grant it
  }
}

// ═══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES (mount on main app)
// ═══════════════════════════════════════════════════════════════════

export function mountStripeRoutes(app, stripeManager, authenticate, requireAdmin) {

  // Get subscription status
  app.get('/api/billing/status', authenticate, async (req, res) => {
    try {
      const status = await stripeManager.getSubscriptionStatus(req.user.companyId);
      res.json(status);
    } catch (err) { res.status(500).json({ error: 'Failed to load billing status' }); }
  });

  // Create subscription (with payment method)
  app.post('/api/billing/subscribe', authenticate, requireAdmin, async (req, res) => {
    try {
      const { paymentMethodId } = req.body;
      const result = await stripeManager.createSubscription(req.user.companyId, paymentMethodId);
      res.json(result);
    } catch (err) {
      console.error('[billing] error:', err.message); res.status(400).json({ error: 'Billing request failed' });
    }
  });

  // Create Checkout Session (redirect to Stripe)
  app.post('/api/billing/checkout', authenticate, requireAdmin, async (req, res) => {
    try {
      const { successUrl, cancelUrl } = req.body;
      const session = await stripeManager.createCheckoutSession(req.user.companyId, successUrl, cancelUrl);
      res.json(session);
    } catch (err) { console.error('[billing] error:', err.message); res.status(400).json({ error: 'Billing request failed' }); }
  });

  // Billing portal (manage payment methods, invoices)
  app.post('/api/billing/portal', authenticate, requireAdmin, async (req, res) => {
    try {
      const { returnUrl } = req.body;
      const session = await stripeManager.createBillingPortalSession(req.user.companyId, returnUrl);
      res.json(session);
    } catch (err) { console.error('[billing] error:', err.message); res.status(500).json({ error: 'Billing operation failed' }); }
  });

  // Update payment method
  app.put('/api/billing/payment-method', authenticate, requireAdmin, async (req, res) => {
    try {
      const { paymentMethodId } = req.body;
      await stripeManager.updateCustomerPaymentMethod(req.user.companyId, paymentMethodId);
      res.json({ success: true });
    } catch (err) { console.error('[billing] error:', err.message); res.status(400).json({ error: 'Billing request failed' }); }
  });

  // Cancel subscription
  app.post('/api/billing/cancel', authenticate, requireAdmin, async (req, res) => {
    try {
      const { immediate } = req.body;
      const result = await stripeManager.cancelSubscription(req.user.companyId, immediate);
      res.json(result);
    } catch (err) { console.error('[billing] error:', err.message); res.status(500).json({ error: 'Billing operation failed' }); }
  });

  // Reactivate subscription
  app.post('/api/billing/reactivate', authenticate, requireAdmin, async (req, res) => {
    try {
      const result = await stripeManager.reactivateSubscription(req.user.companyId);
      res.json(result);
    } catch (err) { console.error('[billing] error:', err.message); res.status(500).json({ error: 'Billing operation failed' }); }
  });

  // Pause subscription (admin/FILO staff only in practice)
  app.post('/api/billing/pause', authenticate, requireAdmin, async (req, res) => {
    try {
      const result = await stripeManager.pauseSubscription(req.user.companyId);
      res.json(result);
    } catch (err) { console.error('[billing] error:', err.message); res.status(500).json({ error: 'Billing operation failed' }); }
  });

  // Resume subscription
  app.post('/api/billing/resume', authenticate, requireAdmin, async (req, res) => {
    try {
      const result = await stripeManager.resumeSubscription(req.user.companyId);
      res.json(result);
    } catch (err) { console.error('[billing] error:', err.message); res.status(500).json({ error: 'Billing operation failed' }); }
  });

  // Get invoices
  app.get('/api/billing/invoices', authenticate, async (req, res) => {
    try {
      const invoices = await stripeManager.getInvoices(req.user.companyId);
      res.json(invoices);
    } catch (err) { res.status(500).json({ error: 'Failed to load invoices' }); }
  });

  // Get upcoming invoice
  app.get('/api/billing/upcoming', authenticate, async (req, res) => {
    try {
      const invoice = await stripeManager.getUpcomingInvoice(req.user.companyId);
      res.json(invoice);
    } catch (err) { res.status(500).json({ error: 'Failed to load upcoming invoice' }); }
  });

  // Add user (triggers Stripe proration)
  app.post('/api/billing/add-user', authenticate, requireAdmin, async (req, res) => {
    try {
      const result = await stripeManager.addUser(req.user.companyId);
      res.json(result);
    } catch (err) {
      console.error('[billing] error:', err.message); res.status(400).json({ error: 'Billing request failed' });
    }
  });

  // Remove user (triggers Stripe proration)
  app.post('/api/billing/remove-user', authenticate, requireAdmin, async (req, res) => {
    try {
      const result = await stripeManager.removeUser(req.user.companyId);
      res.json(result);
    } catch (err) {
      console.error('[billing] error:', err.message); res.status(400).json({ error: 'Billing request failed' });
    }
  });

  // Stripe webhook
  app.post('/api/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
      const result = await stripeManager.handleWebhook(req.body, req.headers['stripe-signature']);
      res.json(result);
    } catch (err) {
      console.error('Stripe webhook error:', err);
      console.error('[billing] error:', err.message); res.status(400).json({ error: 'Billing request failed' });
    }
  });
}
