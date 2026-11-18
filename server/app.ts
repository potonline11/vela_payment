import crypto from 'node:crypto';
import express from 'express';
import Stripe from 'stripe';
import type {
  CardBrand,
  PaymentIntent,
  PaymentMethod,
  SecurityPolicy,
  StripeConfigResponse,
  TransactionRecord,
  WebhookDelivery,
} from '../src/types/gateway.ts';
import {
  createCardFingerprint,
  createWebhookSignatureHeader,
  decryptPanVault,
  detectCardBrand,
  encryptPanVault,
  evaluateRisk,
  generatePromptPayEmvcoQr,
  maskPan,
  sha256Hex,
  validateExpiry,
  validateLuhn,
  verifyWebhookSignatureHeader,
} from './security.ts';
import {
  buildDashboardPayload,
  deliverWebhookHttp,
  dispatchSignedWebhook,
  loadDb,
  saveDb,
} from './store.ts';
import type { GatewayDatabase } from './store.ts';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function getStripeClient(): Stripe | null {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) return null;
  return new Stripe(secretKey);
}

function getStripePublishableKey(): string | null {
  const pk = (process.env.VITE_STRIPE_PUBLISHABLE_KEY || process.env.STRIPE_PUBLISHABLE_KEY)?.trim();
  return pk && pk.length > 0 ? pk : null;
}

function mapStripeCardBrand(brand?: string | null): CardBrand {
  switch (brand?.toLowerCase()) {
    case 'visa':
      return 'visa';
    case 'mastercard':
      return 'mastercard';
    case 'jcb':
      return 'jcb';
    case 'amex':
      return 'amex';
    default:
      return 'unknown';
  }
}

function getStripeConfigSummary(): StripeConfigResponse {
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim() ?? '';
  const publishableKey = getStripePublishableKey();
  const configured = Boolean(secretKey && publishableKey);
  const isLive = secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_');
  const mode: StripeConfigResponse['mode'] = !configured ? 'unconfigured' : isLive ? 'live' : 'test';
  return {
    configured,
    publishableKey,
    mode,
    webhookConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET?.trim()),
  };
}

function timingSafeHexMatch(aHex: string, bHex: string): boolean {
  const aBuf = Buffer.from(aHex, 'hex');
  const bBuf = Buffer.from(bHex, 'hex');
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
}

function verifyMerchantSecret(req: express.Request, db: GatewayDatabase): boolean {
  const authHeader = req.headers.authorization;
  const xApiKey = req.headers['x-api-key'];
  let token = '';
  if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (typeof xApiKey === 'string') {
    token = xApiKey.trim();
  }
  if (!token) return false;

  const tokenHash = sha256Hex(token);
  if (timingSafeHexMatch(tokenHash, db.merchant.secretKeyHash)) {
    return true;
  }

  const sharedEnvSecret = (process.env.PAYMENT_GATEWAY_SECRET || process.env.GATEWAY_API_SECRET)?.trim();
  if (sharedEnvSecret && timingSafeHexMatch(tokenHash, sha256Hex(sharedEnvSecret))) {
    return true;
  }
  return false;
}

function recordStripeSucceededIntent(
  db: GatewayDatabase,
  stripePi: Stripe.PaymentIntent
): { tx: TransactionRecord; delivery?: WebhookDelivery } {
  const existing = db.transactions.find((t) => t.stripePaymentIntentId === stripePi.id);
  if (existing) {
    return { tx: existing };
  }

  const latestCharge =
    typeof stripePi.latest_charge === 'object' && stripePi.latest_charge !== null
      ? (stripePi.latest_charge as Stripe.Charge)
      : null;

  const pmType = latestCharge?.payment_method_details?.type;
  const isPromptPay = pmType === 'promptpay';
  const method: PaymentMethod = isPromptPay ? 'promptpay_qr' : 'credit_card';

  const cardDetails = latestCharge?.payment_method_details?.card;
  const brand = mapStripeCardBrand(cardDetails?.brand);
  const last4 = cardDetails?.last4;
  const maskedPan = last4 ? `•••• •••• •••• ${last4}` : undefined;
  const threeDsAuth = cardDetails?.three_d_secure?.result === 'authenticated';

  const amountThb = round2(stripePi.amount / 100);
  const feeThb = isPromptPay ? round2(amountThb * 0.0165) : round2(amountThb * 0.0365 + 11);
  const netThb = round2(Math.max(0, amountThb - feeThb));

  const linkedIntentId = stripePi.metadata?.siamvault_intent_id || stripePi.id;
  const linkedOrderId = stripePi.metadata?.order_id || `STR-${stripePi.id.slice(-6).toUpperCase()}`;
  const linkedIntent = db.intents.find((i) => i.id === linkedIntentId || i.stripePaymentIntentId === stripePi.id);

  const txId = `tx_str_${stripePi.id.slice(-10)}`;
  const tx: TransactionRecord = {
    id: txId,
    intentId: linkedIntent?.id ?? linkedIntentId,
    orderId: linkedIntent?.orderId ?? linkedOrderId,
    description: stripePi.description || linkedIntent?.description || 'Stripe Thailand Payment',
    customerEmail: stripePi.receipt_email || linkedIntent?.customerEmail || 'customer@stripe.th',
    amount: amountThb,
    feeThb,
    netThb,
    currency: 'THB',
    method,
    brand: method === 'credit_card' ? brand : undefined,
    maskedPan: method === 'credit_card' ? maskedPan : undefined,
    qrReference: isPromptPay ? stripePi.id.slice(-10).toUpperCase() : undefined,
    stripePaymentIntentId: stripePi.id,
    processor: 'stripe_thailand',
    status: 'succeeded',
    threeDsStatus: isPromptPay ? 'not_applicable' : threeDsAuth ? 'authenticated' : 'frictionless',
    eci: isPromptPay ? undefined : threeDsAuth ? '05' : '07',
    riskScore: 5,
    riskChecks: [
      {
        code: 'STRIPE_TH_VERIFIED',
        label: 'Stripe Thailand Authorization',
        passed: true,
        detail: isPromptPay
          ? `Stripe PromptPay ยืนยันยอดชำระสำเร็จ (${stripePi.id})`
          : `Stripe Card Authorization (${brand.toUpperCase()} •••• ${last4 ?? '****'}) สำเร็จ`,
      },
      {
        code: 'STRIPE_SCA',
        label: isPromptPay ? 'PromptPay QR Settlement' : '3D Secure 2.0 / Fraud Radar',
        passed: true,
        detail: isPromptPay
          ? 'ชำระเงินผ่าน Stripe PromptPay สำเร็จ'
          : threeDsAuth
            ? 'ผ่านการยืนยันตัวตน 3D Secure จาก Stripe'
            : 'ผ่านการคัดกรอง Stripe Radar',
      },
    ],
    idempotencyKey: `stripe_${stripePi.id}`,
    createdAt: new Date(stripePi.created * 1000).toISOString(),
    settledAt: new Date().toISOString(),
  };

  if (linkedIntent) {
    linkedIntent.status = 'succeeded';
    linkedIntent.transactionId = txId;
  }

  db.transactions = [tx, ...db.transactions];
  const delivery = dispatchSignedWebhook(
    db,
    'charge.succeeded',
    {
      transactionId: txId,
      intentId: tx.intentId,
      stripePaymentIntentId: stripePi.id,
      orderId: tx.orderId,
      amount: tx.amount,
      currency: 'THB',
      method,
      processor: 'stripe_thailand',
    },
    txId,
    linkedIntent?.webhookUrl
  );

  return { tx, delivery };
}

function getClientKey(req: express.Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? 'local';
}

function getRecentFailuresCount(db: GatewayDatabase, clientKey: string): number {
  const now = Date.now();
  const windowMs = 60 * 1000;
  db.failedAttempts = db.failedAttempts ?? {};
  const active = (db.failedAttempts[clientKey] ?? []).filter((ts) => now - ts <= windowMs);
  db.failedAttempts[clientKey] = active;
  return active.length;
}

function recordFailedAttempt(db: GatewayDatabase, clientKey: string): void {
  const now = Date.now();
  const windowMs = 60 * 1000;
  db.failedAttempts = db.failedAttempts ?? {};
  const active = (db.failedAttempts[clientKey] ?? []).filter((ts) => now - ts <= windowMs);
  active.push(now);
  db.failedAttempts[clientKey] = active;
}

export function createApiApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // IMPORTANT: Stripe Webhook must receive raw Buffer BEFORE express.json() parses the body
  app.post(
    '/api/v1/stripe/webhook',
    express.raw({ type: 'application/json' }),
    async (req, res, next) => {
      try {
        const stripe = getStripeClient();
        if (!stripe) {
          res.status(503).json({ error: 'STRIPE_SECRET_KEY ยังไม่ได้ตั้งค่า' });
          return;
        }

        const sig = req.headers['stripe-signature'];
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
        let event: Stripe.Event;

        if (webhookSecret && typeof sig === 'string') {
          const rawBody = Buffer.isBuffer(req.body)
            ? req.body
            : typeof req.body === 'string'
              ? req.body
              : JSON.stringify(req.body);
          event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
        } else {
          // Fallback if webhook secret not yet configured during initial test
          const parsed = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString('utf8')) : req.body;
          event = parsed as Stripe.Event;
        }

        const db = await loadDb();

        if (event.type === 'payment_intent.succeeded') {
          const piObj = event.data.object as Stripe.PaymentIntent;
          const expanded = await stripe.paymentIntents.retrieve(piObj.id, {
            expand: ['latest_charge'],
          });
          const { delivery } = recordStripeSucceededIntent(db, expanded);
          if (delivery) {
            await deliverWebhookHttp(delivery);
          }
          await saveDb(db);
        } else if (event.type === 'payment_intent.payment_failed') {
          const piObj = event.data.object as Stripe.PaymentIntent;
          const linkedIntent = db.intents.find((i) => i.stripePaymentIntentId === piObj.id);
          if (linkedIntent) {
            linkedIntent.status = 'declined';
          }
          const delivery = dispatchSignedWebhook(
            db,
            'charge.declined',
            {
              intentId: linkedIntent?.id,
              orderId: linkedIntent?.orderId,
              stripePaymentIntentId: piObj.id,
              reason: piObj.last_payment_error?.message ?? 'Stripe payment failed',
            },
            undefined,
            linkedIntent?.webhookUrl
          );
          await deliverWebhookHttp(delivery);
          await saveDb(db);
        } else if (event.type === 'charge.refunded') {
          const chargeObj = event.data.object as Stripe.Charge;
          const piId = typeof chargeObj.payment_intent === 'string' ? chargeObj.payment_intent : chargeObj.payment_intent?.id;
          if (piId) {
            const tx = db.transactions.find((t) => t.stripePaymentIntentId === piId);
            if (tx && tx.status !== 'refunded') {
              tx.status = 'refunded';
              tx.refundedAt = new Date().toISOString();
              const linkedIntent = db.intents.find((i) => i.id === tx.intentId);
              const delivery = dispatchSignedWebhook(
                db,
                'charge.refunded',
                { transactionId: tx.id, orderId: tx.orderId, stripePaymentIntentId: piId },
                tx.id,
                linkedIntent?.webhookUrl
              );
              await deliverWebhookHttp(delivery);
              await saveDb(db);
            }
          }
        }

        res.json({ received: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Webhook verification failed';
        if (message.includes('signature') || message.includes('StripeSignatureVerificationError')) {
          res.status(400).json({ error: `Stripe Webhook Signature Error: ${message}` });
          return;
        }
        next(err);
      }
    }
  );

  app.use(express.json({ limit: '1mb' }));

  // Global Security Headers
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
    next();
  });

  app.get('/api/v1/health', (_req, res) => {
    const hasPostgres = Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
    res.json({
      status: 'ok',
      runtime: process.env.VERCEL ? 'vercel-serverless' : 'node-server',
      persistence: hasPostgres ? 'postgresql' : 'local-ledger',
      stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY && getStripePublishableKey()),
      timestamp: new Date().toISOString(),
    });
  });

  // Stripe Thailand Configuration & Status (never exposes secret key)
  app.get('/api/v1/stripe/config', (_req, res) => {
    res.json(getStripeConfigSummary());
  });

  // Create real Stripe PaymentIntent (supports THB Credit/Debit Cards + PromptPay QR)
  app.post('/api/v1/stripe/create-payment-intent', async (req, res, next) => {
    try {
      const stripe = getStripeClient();
      if (!stripe) {
        res.status(503).json({
          error: 'ยังไม่ได้ตั้งค่า STRIPE_SECRET_KEY ใน Secrets / Environment Variables',
        });
        return;
      }

      const db = await loadDb();
      const { intentId } = req.body as { intentId?: string };
      const intent = db.intents.find((i) => i.id === intentId);
      if (!intent) {
        res.status(404).json({ error: 'ไม่พบ Payment Intent ในระบบ' });
        return;
      }
      if (intent.status === 'succeeded') {
        res.status(409).json({ error: 'รายการนี้ชำระเงินสำเร็จแล้ว' });
        return;
      }

      // Reuse existing open Stripe PaymentIntent if already created for this order
      if (intent.stripePaymentIntentId) {
        try {
          const existingPi = await stripe.paymentIntents.retrieve(intent.stripePaymentIntentId);
          if (existingPi.status !== 'canceled' && existingPi.status !== 'succeeded') {
            res.json({
              clientSecret: existingPi.client_secret,
              stripePaymentIntentId: existingPi.id,
              amount: intent.amount,
            });
            return;
          }
        } catch {
          // Create a fresh PaymentIntent below if retrieve fails
        }
      }

      const amountSatang = Math.round(intent.amount * 100);
      if (amountSatang < 1000) {
        res.status(400).json({ error: 'Stripe Thailand รองรับยอดชำระขั้นต่ำ ฿10.00 (1,000 สตางค์)' });
        return;
      }

      const stripePi = await stripe.paymentIntents.create({
        amount: amountSatang,
        currency: 'thb',
        automatic_payment_methods: { enabled: true },
        description: `${intent.orderId} - ${intent.description}`,
        receipt_email: intent.customerEmail || undefined,
        metadata: {
          siamvault_intent_id: intent.id,
          order_id: intent.orderId,
          merchant_id: db.merchant.merchantId,
        },
      });

      intent.stripePaymentIntentId = stripePi.id;
      await saveDb(db);

      res.json({
        clientSecret: stripePi.client_secret,
        stripePaymentIntentId: stripePi.id,
        amount: intent.amount,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'ไม่สามารถสร้าง Stripe PaymentIntent ได้';
      res.status(400).json({ error: msg });
      if (!(err instanceof Error)) next(err);
    }
  });

  // Retrieve & verify Stripe PaymentIntent server-side after checkout confirmation / PromptPay scan
  app.post('/api/v1/stripe/sync-intent', async (req, res, next) => {
    try {
      const stripe = getStripeClient();
      if (!stripe) {
        res.status(503).json({ error: 'STRIPE_SECRET_KEY ยังไม่ได้ตั้งค่า' });
        return;
      }

      const { stripePaymentIntentId } = req.body as { stripePaymentIntentId?: string };
      if (!stripePaymentIntentId) {
        res.status(400).json({ error: 'ต้องระบุ stripePaymentIntentId' });
        return;
      }

      const stripePi = await stripe.paymentIntents.retrieve(stripePaymentIntentId, {
        expand: ['latest_charge'],
      });

      const db = await loadDb();

      if (stripePi.status === 'succeeded') {
        const { tx, delivery } = recordStripeSucceededIntent(db, stripePi);
        if (delivery) {
          await deliverWebhookHttp(delivery);
        }
        await saveDb(db);
        res.json({
          status: 'succeeded',
          transaction: tx,
          dashboard: buildDashboardPayload(db),
        });
        return;
      }

      res.json({
        status: stripePi.status,
        lastError: stripePi.last_payment_error?.message ?? null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'ไม่สามารถตรวจสอบสถานะ Stripe ได้';
      res.status(400).json({ error: msg });
      if (!(err instanceof Error)) next(err);
    }
  });

  app.get('/api/v1/dashboard', async (_req, res, next) => {
    try {
      const db = await loadDb();
      res.json(buildDashboardPayload(db));
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/keys/rotate', async (_req, res, next) => {
    try {
      const db = await loadDb();
      const newSecretKey = `sk_live_${crypto.randomBytes(18).toString('hex')}`;
      const newWebhookSecret = `whsec_${crypto.randomBytes(20).toString('hex')}`;
      const newPublishableKey = `pk_live_${crypto.randomBytes(14).toString('hex')}`;

      db.merchant.publishableKey = newPublishableKey;
      db.merchant.secretKeyHash = sha256Hex(newSecretKey);
      db.merchant.secretKeyMasked = `sk_live_••••••••••••••••${newSecretKey.slice(-6)}`;
      db.merchant.webhookSecret = newWebhookSecret;
      db.merchant.keyRotatedAt = new Date().toISOString();
      await saveDb(db);

      res.json({
        revealedSecretKeyOnce: newSecretKey,
        revealedWebhookSecretOnce: newWebhookSecret,
        dashboard: buildDashboardPayload(db),
      });
    } catch (err) {
      next(err);
    }
  });

  app.put('/api/v1/security/policy', async (req, res, next) => {
    try {
      const db = await loadDb();
      const body = req.body as Partial<SecurityPolicy>;
      const updated: SecurityPolicy = {
        maxAmountThb: Math.max(100, Math.min(10000000, Number(body.maxAmountThb ?? db.policy.maxAmountThb))),
        threeDsThresholdThb: Math.max(0, Math.min(500000, Number(body.threeDsThresholdThb ?? db.policy.threeDsThresholdThb))),
        maxAttemptsPerMinute: Math.max(1, Math.min(30, Number(body.maxAttemptsPerMinute ?? db.policy.maxAttemptsPerMinute))),
        strictLuhnCvv: typeof body.strictLuhnCvv === 'boolean' ? body.strictLuhnCvv : db.policy.strictLuhnCvv,
        replayWindowSeconds: Math.max(30, Math.min(3600, Number(body.replayWindowSeconds ?? db.policy.replayWindowSeconds))),
        blockHighRiskBins: typeof body.blockHighRiskBins === 'boolean' ? body.blockHighRiskBins : db.policy.blockHighRiskBins,
      };
      db.policy = updated;
      await saveDb(db);
      res.json({ policy: updated, dashboard: buildDashboardPayload(db) });
    } catch (err) {
      next(err);
    }
  });

  app.put('/api/v1/merchant/profile', async (req, res, next) => {
    try {
      const db = await loadDb();
      const { merchantName, promptPayId, webhookUrl } = req.body as {
        merchantName?: string;
        promptPayId?: string;
        webhookUrl?: string;
      };

      if (merchantName && merchantName.trim().length > 0) {
        db.merchant.merchantName = merchantName.trim().slice(0, 80);
      }
      if (promptPayId) {
        const cleanPp = promptPayId.replace(/\D/g, '');
        if (cleanPp.length !== 10 && cleanPp.length !== 13 && cleanPp.length !== 15) {
          res.status(400).json({ error: 'รหัส PromptPay ต้องเป็นเบอร์โทร 10 หลัก หรือเลขนิติบุคคล/บัตรประชาชน 13 หลัก' });
          return;
        }
        db.merchant.promptPayId = cleanPp;
      }
      if (webhookUrl && /^https?:\/\//i.test(webhookUrl.trim())) {
        db.merchant.webhookUrl = webhookUrl.trim().slice(0, 200);
      }

      await saveDb(db);
      res.json({ dashboard: buildDashboardPayload(db) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/payment-intents', async (req, res, next) => {
    try {
      const db = await loadDb();
      const { amount, description, orderId, customerEmail, idempotencyKey } = req.body as {
        amount?: number;
        description?: string;
        orderId?: string;
        customerEmail?: string;
        idempotencyKey?: string;
      };

      const numericAmount = round2(Number(amount));
      if (!Number.isFinite(numericAmount) || numericAmount < 1) {
        res.status(400).json({ error: 'ยอดเงินต้องมากกว่าหรือเท่ากับ 1.00 บาท' });
        return;
      }
      if (numericAmount > db.policy.maxAmountThb) {
        res.status(400).json({
          error: `ยอดเงินเกินวงเงินสูงสุดต่อรายการที่กำหนดไว้ (฿${db.policy.maxAmountThb.toLocaleString('en-US')})`,
        });
        return;
      }

      const idemKey = idempotencyKey?.trim() || `idem_${crypto.randomBytes(6).toString('hex')}`;
      const existingIntent = db.intents.find((i) => i.idempotencyKey === idemKey);
      if (existingIntent) {
        res.json({ intent: existingIntent, idempotentReplay: true });
        return;
      }

      const cleanOrderId = (orderId?.trim() || `ORD-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`).slice(0, 32);
      const qrRef = `SV${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const qrPayload = generatePromptPayEmvcoQr(db.merchant.promptPayId, numericAmount, qrRef);

      const intent: PaymentIntent = {
        id: `pi_sv_${crypto.randomBytes(6).toString('hex')}`,
        orderId: cleanOrderId,
        amount: numericAmount,
        currency: 'THB',
        description: (description?.trim() || 'ชำระค่าสินค้าและบริการ').slice(0, 120),
        customerEmail: (customerEmail?.trim() || 'customer@example.com').slice(0, 100),
        idempotencyKey: idemKey,
        status: 'open',
        qrPayload,
        qrReference: qrRef,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        createdAt: new Date().toISOString(),
      };

      db.intents = [intent, ...db.intents].slice(0, 40);
      await saveDb(db);
      res.status(201).json({ intent, idempotentReplay: false });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/v1/payment-intents/:id', async (req, res, next) => {
    try {
      const db = await loadDb();
      const intent = db.intents.find((i) => i.id === req.params.id);
      if (!intent) {
        res.status(404).json({ error: 'ไม่พบ Payment Intent ที่ระบุ' });
        return;
      }
      const transaction = intent.transactionId
        ? db.transactions.find((t) => t.id === intent.transactionId) ?? null
        : null;
      res.json({ intent, transaction });
    } catch (err) {
      next(err);
    }
  });

  // Public safe Hosted Checkout read endpoint (never returns admin secrets or other transactions)
  app.get('/api/v1/checkout-sessions/:id', async (req, res, next) => {
    try {
      const db = await loadDb();
      const intent = db.intents.find((i) => i.id === req.params.id);
      if (!intent) {
        res.status(404).json({ error: 'ไม่พบรายการชำระเงิน หรือลิงก์หมดอายุแล้ว' });
        return;
      }
      const transaction = intent.transactionId
        ? db.transactions.find((t) => t.id === intent.transactionId) ?? null
        : null;
      res.json({
        intent,
        merchantName: db.merchant.merchantName,
        promptPayId: db.merchant.promptPayId,
        stripeConfig: getStripeConfigSummary(),
        transaction,
      });
    } catch (err) {
      next(err);
    }
  });

  // Authenticated Merchant API for external storefronts (e.g., Vela Commerce)
  app.post('/api/v1/merchant/checkout-sessions', async (req, res, next) => {
    try {
      const db = await loadDb();
      if (!verifyMerchantSecret(req, db)) {
        res.status(401).json({
          error: 'Unauthorized: กรุณาระบุ Authorization: Bearer <Secret Key> ให้ถูกต้อง',
        });
        return;
      }

      const {
        amount,
        orderId,
        description,
        customerEmail,
        successUrl,
        cancelUrl,
        webhookUrl,
        idempotencyKey,
      } = req.body as {
        amount?: number;
        orderId?: string;
        description?: string;
        customerEmail?: string;
        successUrl?: string;
        cancelUrl?: string;
        webhookUrl?: string;
        idempotencyKey?: string;
      };

      const numericAmount = round2(Number(amount));
      if (!Number.isFinite(numericAmount) || numericAmount < 10) {
        res.status(400).json({ error: 'ยอดชำระต้องไม่ต่ำกว่า 10.00 บาท (ขั้นต่ำของ Stripe Thailand)' });
        return;
      }
      if (numericAmount > db.policy.maxAmountThb) {
        res.status(400).json({
          error: `ยอดเงินเกินวงเงินสูงสุดต่อรายการที่กำหนดไว้ (฿${db.policy.maxAmountThb.toLocaleString('en-US')})`,
        });
        return;
      }

      const proto = (req.headers['x-forwarded-proto']?.toString().split(',')[0] || req.protocol || 'https').trim();
      const host = (req.headers['x-forwarded-host']?.toString().split(',')[0] || req.get('host') || 'velapayment.vercel.app').trim();
      const buildCheckoutUrl = (id: string) => `${proto}://${host}/?checkout=${encodeURIComponent(id)}`;

      const idemKey = idempotencyKey?.trim() || `idem_${crypto.randomBytes(6).toString('hex')}`;
      const existingIntent = db.intents.find((i) => i.idempotencyKey === idemKey);
      if (existingIntent) {
        res.json({
          intentId: existingIntent.id,
          orderId: existingIntent.orderId,
          amount: existingIntent.amount,
          currency: 'THB',
          status: existingIntent.status,
          checkoutUrl: buildCheckoutUrl(existingIntent.id),
          expiresAt: existingIntent.expiresAt,
          idempotentReplay: true,
        });
        return;
      }

      const cleanOrderId = (orderId?.trim() || `ORD-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`).slice(0, 48);
      const qrRef = `SV${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const qrPayload = generatePromptPayEmvcoQr(db.merchant.promptPayId, numericAmount, qrRef);

      const safeSuccessUrl = successUrl && /^https?:\/\//i.test(successUrl.trim()) ? successUrl.trim().slice(0, 300) : undefined;
      const safeCancelUrl = cancelUrl && /^https?:\/\//i.test(cancelUrl.trim()) ? cancelUrl.trim().slice(0, 300) : undefined;
      const safeWebhookUrl = webhookUrl && /^https?:\/\//i.test(webhookUrl.trim()) ? webhookUrl.trim().slice(0, 300) : undefined;

      const intent: PaymentIntent = {
        id: `pi_sv_${crypto.randomBytes(6).toString('hex')}`,
        orderId: cleanOrderId,
        amount: numericAmount,
        currency: 'THB',
        description: (description?.trim() || `ชำระเงินคำสั่งซื้อ ${cleanOrderId}`).slice(0, 140),
        customerEmail: (customerEmail?.trim() || 'customer@vela-commerce.th').slice(0, 100),
        idempotencyKey: idemKey,
        status: 'open',
        qrPayload,
        qrReference: qrRef,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        createdAt: new Date().toISOString(),
        successUrl: safeSuccessUrl,
        cancelUrl: safeCancelUrl,
        webhookUrl: safeWebhookUrl,
      };

      db.intents = [intent, ...db.intents].slice(0, 100);
      await saveDb(db);

      res.status(201).json({
        intentId: intent.id,
        orderId: intent.orderId,
        amount: intent.amount,
        currency: 'THB',
        status: intent.status,
        checkoutUrl: buildCheckoutUrl(intent.id),
        expiresAt: intent.expiresAt,
        idempotentReplay: false,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/v1/merchant/checkout-sessions/:id', async (req, res, next) => {
    try {
      const db = await loadDb();
      if (!verifyMerchantSecret(req, db)) {
        res.status(401).json({
          error: 'Unauthorized: กรุณาระบุ Authorization: Bearer <Secret Key> ให้ถูกต้อง',
        });
        return;
      }

      const intent = db.intents.find((i) => i.id === req.params.id);
      if (!intent) {
        res.status(404).json({ error: 'ไม่พบ Checkout Session ที่ระบุ' });
        return;
      }
      const transaction = intent.transactionId
        ? db.transactions.find((t) => t.id === intent.transactionId) ?? null
        : null;

      res.json({
        intentId: intent.id,
        orderId: intent.orderId,
        amount: intent.amount,
        currency: intent.currency,
        status: intent.status,
        paid: intent.status === 'succeeded',
        transaction,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/tokens', async (req, res, next) => {
    try {
      const db = await loadDb();
      const clientKey = getClientKey(req);
      const { pan, holderName, expMonth, expYear, cvv } = req.body as {
        pan?: string;
        holderName?: string;
        expMonth?: string;
        expYear?: string;
        cvv?: string;
      };

      const cleanPan = (pan ?? '').replace(/\D/g, '');
      const cleanHolder = (holderName ?? '').trim().toUpperCase().slice(0, 60);
      const cleanMonth = (expMonth ?? '').trim().padStart(2, '0');
      const cleanYear = (expYear ?? '').trim().slice(-2);
      const cleanCvv = (cvv ?? '').trim();

      if (cleanPan.length < 13 || cleanPan.length > 19) {
        recordFailedAttempt(db, clientKey);
        await saveDb(db);
        res.status(400).json({ error: 'หมายเลขบัตรต้องมีความยาว 13–19 หลัก' });
        return;
      }
      if (!cleanHolder) {
        res.status(400).json({ error: 'กรุณาระบุชื่อผู้ถือบัตร' });
        return;
      }
      if (db.policy.strictLuhnCvv && !validateLuhn(cleanPan)) {
        recordFailedAttempt(db, clientKey);
        await saveDb(db);
        res.status(422).json({ error: 'หมายเลขบัตรไม่ผ่านการตรวจสอบ Luhn Checksum (ISO/IEC 7812)' });
        return;
      }
      if (!validateExpiry(cleanMonth, cleanYear)) {
        recordFailedAttempt(db, clientKey);
        await saveDb(db);
        res.status(422).json({ error: 'บัตรหมดอายุหรือรูปแบบวันหมดอายุไม่ถูกต้อง' });
        return;
      }
      const brand = detectCardBrand(cleanPan);
      const expectedCvvLen = brand === 'amex' ? 4 : 3;
      if (db.policy.strictLuhnCvv && !new RegExp(`^\\d{${expectedCvvLen}}$`).test(cleanCvv)) {
        recordFailedAttempt(db, clientKey);
        await saveDb(db);
        res.status(422).json({ error: `รหัส CVV ต้องเป็นตัวเลข ${expectedCvvLen} หลัก` });
        return;
      }

      const vaultEnvelope = encryptPanVault(cleanPan, cleanHolder, cleanMonth, cleanYear);
      const tokenId = `tok_vlt_${crypto.randomBytes(6).toString('hex')}`;
      const tokenRecord = {
        id: tokenId,
        maskedPan: maskPan(cleanPan),
        last4: cleanPan.slice(-4),
        brand,
        expMonth: cleanMonth,
        expYear: cleanYear,
        holderName: cleanHolder,
        fingerprint: createCardFingerprint(cleanPan),
        algorithm: vaultEnvelope.algorithm,
        ivHex: vaultEnvelope.ivHex,
        authTagHex: vaultEnvelope.authTagHex,
        ciphertextPreview: `${vaultEnvelope.ciphertextHex.slice(0, 28)}...`,
        createdAt: new Date().toISOString(),
        vault: vaultEnvelope,
      };

      db.tokens = [tokenRecord, ...db.tokens].slice(0, 60);
      await saveDb(db);

      const { vault: _omitVault, ...publicToken } = tokenRecord;
      res.status(201).json({ token: publicToken });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/charges', async (req, res, next) => {
    try {
      const db = await loadDb();
      const clientKey = getClientKey(req);
      const { intentId, tokenId, cvv, idempotencyKey } = req.body as {
        intentId?: string;
        tokenId?: string;
        cvv?: string;
        idempotencyKey?: string;
      };

      const idemKey = (idempotencyKey ?? req.headers['idempotency-key']?.toString() ?? '').trim();
      if (!idemKey) {
        res.status(400).json({ error: 'ต้องระบุ Idempotency-Key เพื่อป้องกันการตัดเงินซ้ำซ้อน' });
        return;
      }

      const existingTx = db.transactions.find((t) => t.idempotencyKey === idemKey);
      if (existingTx) {
        res.json({
          transaction: existingTx,
          idempotentReplay: true,
          dashboard: buildDashboardPayload(db),
        });
        return;
      }

      const intent = db.intents.find((i) => i.id === intentId);
      if (!intent) {
        res.status(404).json({ error: 'ไม่พบ Payment Intent' });
        return;
      }
      if (intent.status === 'succeeded') {
        res.status(409).json({ error: 'รายการนี้ชำระเงินสำเร็จแล้ว' });
        return;
      }

      const token = db.tokens.find((t) => t.id === tokenId);
      if (!token) {
        res.status(404).json({ error: 'ไม่พบ Card Token ใน Vault' });
        return;
      }

      const decrypted = decryptPanVault(token.vault);
      const recentFailures = getRecentFailuresCount(db, clientKey);
      const risk = evaluateRisk({
        pan: decrypted.pan,
        cvv: cvv ?? '000',
        expMonth: decrypted.expMonth,
        expYear: decrypted.expYear,
        amount: intent.amount,
        recentFailedCount: recentFailures,
        policy: db.policy,
      });

      const txId = `tx_sv_${crypto.randomBytes(5).toString('hex')}`;

      if (risk.blocked) {
        recordFailedAttempt(db, clientKey);
        const declinedTx: TransactionRecord = {
          id: txId,
          intentId: intent.id,
          orderId: intent.orderId,
          description: intent.description,
          customerEmail: intent.customerEmail,
          amount: intent.amount,
          feeThb: 0,
          netThb: 0,
          currency: 'THB',
          method: 'credit_card',
          brand: token.brand,
          maskedPan: token.maskedPan,
          tokenId: token.id,
          processor: 'siamvault_sandbox',
          status: 'declined',
          threeDsStatus: 'failed',
          riskScore: risk.riskScore,
          riskChecks: risk.checks,
          idempotencyKey: idemKey,
          declineReason: risk.declineReason,
          createdAt: new Date().toISOString(),
        };
        intent.status = 'declined';
        intent.transactionId = txId;
        db.transactions = [declinedTx, ...db.transactions];
        dispatchSignedWebhook(
          db,
          'charge.declined',
          {
            transactionId: txId,
            orderId: intent.orderId,
            amount: intent.amount,
            reason: risk.declineReason,
          },
          txId
        );
        await saveDb(db);

        res.status(402).json({
          error: risk.declineReason ?? 'รายการถูกปฏิเสธ',
          transaction: declinedTx,
          dashboard: buildDashboardPayload(db),
        });
        return;
      }

      if (risk.requires3DS) {
        const otpCode = String(crypto.randomInt(100000, 999999));
        const challengeId = `3ds_${crypto.randomBytes(6).toString('hex')}`;
        const nowMs = Date.now();
        db.otpChallenges = (db.otpChallenges ?? []).filter((c) => c.expiresAt > nowMs);
        db.otpChallenges.push({
          challengeId,
          transactionId: txId,
          otpHash: sha256Hex(otpCode),
          attempts: 0,
          maxAttempts: 3,
          expiresAt: nowMs + 5 * 60 * 1000,
        });

        const pendingTx: TransactionRecord = {
          id: txId,
          intentId: intent.id,
          orderId: intent.orderId,
          description: intent.description,
          customerEmail: intent.customerEmail,
          amount: intent.amount,
          feeThb: round2(intent.amount * 0.0275),
          netThb: round2(intent.amount - intent.amount * 0.0275),
          currency: 'THB',
          method: 'credit_card',
          brand: token.brand,
          maskedPan: token.maskedPan,
          tokenId: token.id,
          processor: 'siamvault_sandbox',
          status: 'requires_3ds',
          threeDsStatus: 'challenge_pending',
          riskScore: risk.riskScore,
          riskChecks: risk.checks,
          idempotencyKey: idemKey,
          createdAt: new Date().toISOString(),
        };

        intent.status = 'requires_3ds';
        intent.transactionId = txId;
        db.transactions = [pendingTx, ...db.transactions];
        dispatchSignedWebhook(
          db,
          'charge.requires_3ds',
          { transactionId: txId, orderId: intent.orderId, amount: intent.amount },
          txId
        );
        await saveDb(db);

        res.status(202).json({
          requires3DS: true,
          challengeId,
          sandboxOtpHint: otpCode,
          transaction: pendingTx,
          dashboard: buildDashboardPayload(db),
        });
        return;
      }

      const fee = round2(intent.amount * 0.0275);
      const approvedTx: TransactionRecord = {
        id: txId,
        intentId: intent.id,
        orderId: intent.orderId,
        description: intent.description,
        customerEmail: intent.customerEmail,
        amount: intent.amount,
        feeThb: fee,
        netThb: round2(intent.amount - fee),
        currency: 'THB',
        method: 'credit_card',
        brand: token.brand,
        maskedPan: token.maskedPan,
        tokenId: token.id,
        processor: 'siamvault_sandbox',
        status: 'succeeded',
        threeDsStatus: 'frictionless',
        eci: '05',
        riskScore: risk.riskScore,
        riskChecks: risk.checks,
        idempotencyKey: idemKey,
        createdAt: new Date().toISOString(),
        settledAt: new Date().toISOString(),
      };

      intent.status = 'succeeded';
      intent.transactionId = txId;
      db.transactions = [approvedTx, ...db.transactions];
      dispatchSignedWebhook(
        db,
        'charge.succeeded',
        {
          transactionId: txId,
          orderId: intent.orderId,
          amount: intent.amount,
          currency: 'THB',
          method: 'credit_card',
          threeDsStatus: 'frictionless',
        },
        txId
      );
      await saveDb(db);

      res.status(201).json({
        requires3DS: false,
        transaction: approvedTx,
        dashboard: buildDashboardPayload(db),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/charges/:id/verify-3ds', async (req, res, next) => {
    try {
      const db = await loadDb();
      const clientKey = getClientKey(req);
      const { challengeId, otpCode } = req.body as { challengeId?: string; otpCode?: string };
      const tx = db.transactions.find((t) => t.id === req.params.id);
      if (!tx) {
        res.status(404).json({ error: 'ไม่พบรายการธุรกรรม' });
        return;
      }
      if (tx.status !== 'requires_3ds') {
        res.status(409).json({ error: 'รายการนี้ไม่ได้อยู่ในสถานะรอการยืนยัน 3DS2' });
        return;
      }

      db.otpChallenges = db.otpChallenges ?? [];
      const challengeIdx = challengeId
        ? db.otpChallenges.findIndex((c) => c.challengeId === challengeId && c.transactionId === tx.id)
        : -1;
      const challenge = challengeIdx >= 0 ? db.otpChallenges[challengeIdx] : undefined;

      if (!challenge) {
        res.status(400).json({ error: 'Session การยืนยัน 3DS2 ไม่ถูกต้องหรือหมดอายุ' });
        return;
      }
      if (Date.now() > challenge.expiresAt) {
        db.otpChallenges.splice(challengeIdx, 1);
        tx.status = 'declined';
        tx.threeDsStatus = 'failed';
        tx.declineReason = 'OTP 3DS2 หมดอายุ';
        const intent = db.intents.find((i) => i.id === tx.intentId);
        if (intent) intent.status = 'declined';
        await saveDb(db);
        res.status(410).json({ error: 'รหัส OTP หมดอายุแล้ว', transaction: tx, dashboard: buildDashboardPayload(db) });
        return;
      }

      const inputHash = sha256Hex((otpCode ?? '').trim());
      const expectedBuf = Buffer.from(challenge.otpHash, 'hex');
      const actualBuf = Buffer.from(inputHash, 'hex');
      const matches = expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);

      if (!matches) {
        challenge.attempts += 1;
        recordFailedAttempt(db, clientKey);
        if (challenge.attempts >= challenge.maxAttempts) {
          db.otpChallenges.splice(challengeIdx, 1);
          tx.status = 'declined';
          tx.threeDsStatus = 'failed';
          tx.declineReason = 'กรอกรหัส OTP 3DS2 ผิดเกินจำนวนครั้งที่กำหนด';
          const intent = db.intents.find((i) => i.id === tx.intentId);
          if (intent) intent.status = 'declined';
          dispatchSignedWebhook(db, 'charge.declined', { transactionId: tx.id, reason: tx.declineReason }, tx.id);
          await saveDb(db);
          res.status(403).json({
            error: 'กรอกรหัส OTP ผิดเกิน 3 ครั้ง รายการถูกปฏิเสธเพื่อความปลอดภัย',
            locked: true,
            transaction: tx,
            dashboard: buildDashboardPayload(db),
          });
          return;
        }

        await saveDb(db);
        res.status(401).json({
          error: `รหัส OTP ไม่ถูกต้อง (เหลือโอกาสอีก ${challenge.maxAttempts - challenge.attempts} ครั้ง)`,
          attemptsRemaining: challenge.maxAttempts - challenge.attempts,
        });
        return;
      }

      db.otpChallenges.splice(challengeIdx, 1);
      tx.status = 'succeeded';
      tx.threeDsStatus = 'authenticated';
      tx.eci = '05';
      tx.settledAt = new Date().toISOString();
      tx.riskChecks = [
        ...tx.riskChecks,
        {
          code: '3DS2_OTP',
          label: '3D Secure 2.0 SCA',
          passed: true,
          detail: 'ยืนยันตัวตนผู้ถือบัตรผ่าน 3DS2 OTP สำเร็จ (ECI 05)',
        },
      ];

      const intent = db.intents.find((i) => i.id === tx.intentId);
      if (intent) intent.status = 'succeeded';

      const delivery = dispatchSignedWebhook(
        db,
        'charge.succeeded',
        {
          transactionId: tx.id,
          intentId: tx.intentId,
          orderId: tx.orderId,
          amount: tx.amount,
          currency: 'THB',
          method: 'credit_card',
          threeDsStatus: 'authenticated',
        },
        tx.id,
        intent?.webhookUrl
      );
      await deliverWebhookHttp(delivery);
      await saveDb(db);

      res.json({ transaction: tx, dashboard: buildDashboardPayload(db) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/qr/simulate-bank-callback', async (req, res, next) => {
    try {
      const db = await loadDb();
      const { intentId } = req.body as { intentId?: string };
      const intent = db.intents.find((i) => i.id === intentId);
      if (!intent) {
        res.status(404).json({ error: 'ไม่พบ Payment Intent' });
        return;
      }
      if (intent.status === 'succeeded') {
        const existing = db.transactions.find((t) => t.id === intent.transactionId);
        res.json({ transaction: existing, alreadySettled: true, dashboard: buildDashboardPayload(db) });
        return;
      }

      const bankCallbackPayload = JSON.stringify({
        intentId: intent.id,
        qrReference: intent.qrReference,
        amount: intent.amount,
        currency: 'THB',
        payerBank: 'KBANK-PROMPTPAY',
        settledAt: new Date().toISOString(),
      });
      const bankSig = createWebhookSignatureHeader(bankCallbackPayload, db.merchant.webhookSecret);

      const verification = verifyWebhookSignatureHeader(
        bankCallbackPayload,
        bankSig.header,
        db.merchant.webhookSecret,
        db.policy.replayWindowSeconds
      );
      if (!verification.valid) {
        res.status(401).json({ error: verification.reason });
        return;
      }

      const txId = `tx_sv_${crypto.randomBytes(5).toString('hex')}`;
      const fee = round2(intent.amount * 0.015);
      const qrTx: TransactionRecord = {
        id: txId,
        intentId: intent.id,
        orderId: intent.orderId,
        description: intent.description,
        customerEmail: intent.customerEmail,
        amount: intent.amount,
        feeThb: fee,
        netThb: round2(intent.amount - fee),
        currency: 'THB',
        method: 'promptpay_qr',
        qrReference: intent.qrReference,
        processor: 'siamvault_sandbox',
        status: 'succeeded',
        threeDsStatus: 'not_applicable',
        riskScore: 4,
        riskChecks: [
          {
            code: 'EMVCO_CRC16',
            label: 'EMVCo CRC-16 Integrity',
            passed: true,
            detail: `CRC-16 Tag 63 (${intent.qrPayload.slice(-4)}) ตรงตามมาตรฐาน PromptPay`,
          },
          {
            code: 'BANK_HMAC',
            label: 'Bank Callback HMAC-SHA256',
            passed: true,
            detail: verification.reason,
          },
        ],
        idempotencyKey: intent.idempotencyKey,
        createdAt: new Date().toISOString(),
        settledAt: new Date().toISOString(),
      };

      intent.status = 'succeeded';
      intent.transactionId = txId;
      db.transactions = [qrTx, ...db.transactions];
      const delivery = dispatchSignedWebhook(
        db,
        'charge.succeeded',
        {
          transactionId: txId,
          intentId: intent.id,
          orderId: intent.orderId,
          amount: intent.amount,
          currency: 'THB',
          method: 'promptpay_qr',
          qrReference: intent.qrReference,
        },
        txId,
        intent.webhookUrl
      );
      await deliverWebhookHttp(delivery);
      await saveDb(db);

      res.json({
        transaction: qrTx,
        bankSignatureHeader: bankSig.header,
        dashboard: buildDashboardPayload(db),
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/transactions/:id/refund', async (req, res, next) => {
    try {
      const db = await loadDb();
      const tx = db.transactions.find((t) => t.id === req.params.id);
      if (!tx) {
        res.status(404).json({ error: 'ไม่พบรายการธุรกรรม' });
        return;
      }
      if (tx.status !== 'succeeded') {
        res.status(400).json({ error: 'คืนเงินได้เฉพาะรายการที่ชำระสำเร็จแล้วเท่านั้น' });
        return;
      }

      // If this transaction was processed via Stripe Thailand, execute a real Stripe Refund
      if (tx.stripePaymentIntentId) {
        const stripe = getStripeClient();
        if (!stripe) {
          res.status(503).json({ error: 'ต้องตั้งค่า STRIPE_SECRET_KEY เพื่อทำรายการคืนเงินผ่าน Stripe' });
          return;
        }
        await stripe.refunds.create({
          payment_intent: tx.stripePaymentIntentId,
        });
      }

      tx.status = 'refunded';
      tx.refundedAt = new Date().toISOString();
      const linkedIntent = db.intents.find((i) => i.id === tx.intentId);
      const delivery = dispatchSignedWebhook(
        db,
        'charge.refunded',
        {
          transactionId: tx.id,
          intentId: tx.intentId,
          stripePaymentIntentId: tx.stripePaymentIntentId,
          orderId: tx.orderId,
          refundedAmount: tx.amount,
          currency: 'THB',
        },
        tx.id,
        linkedIntent?.webhookUrl
      );
      await deliverWebhookHttp(delivery);
      await saveDb(db);

      res.json({ transaction: tx, dashboard: buildDashboardPayload(db) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'ไม่สามารถคืนเงินได้';
      res.status(400).json({ error: msg });
      if (!(err instanceof Error)) next(err);
    }
  });

  app.post('/api/v1/webhooks/test', async (_req, res, next) => {
    try {
      const db = await loadDb();
      const delivery = dispatchSignedWebhook(db, 'ping.verified', {
        message: 'SiamVault Pay Webhook Endpoint Verification',
        merchantId: db.merchant.merchantId,
      });
      await deliverWebhookHttp(delivery);
      await saveDb(db);
      res.json({ delivery, dashboard: buildDashboardPayload(db) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/v1/webhooks/verify-signature', async (req, res, next) => {
    try {
      const db = await loadDb();
      const { payload, signatureHeader, secret } = req.body as {
        payload?: string;
        signatureHeader?: string;
        secret?: string;
      };

      const result = verifyWebhookSignatureHeader(
        payload ?? '',
        signatureHeader ?? '',
        secret?.trim() || db.merchant.webhookSecret,
        db.policy.replayWindowSeconds
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[SiamVault API Error]', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์ Payment Gateway' });
  });

  return app;
}
