import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import type {
  DashboardKPIs,
  DashboardPayload,
  MerchantPublicInfo,
  PaymentIntent,
  SecurityPolicy,
  TransactionRecord,
  VaultTokenRecord,
  WebhookDelivery,
} from '../src/types/gateway.ts';
import type { EncryptedVaultEnvelope } from './security.ts';
import {
  createCardFingerprint,
  createWebhookSignatureHeader,
  encryptPanVault,
  generatePromptPayEmvcoQr,
  sha256Hex,
} from './security.ts';

interface StoredVaultToken extends VaultTokenRecord {
  vault: EncryptedVaultEnvelope;
}

interface StoredMerchant {
  merchantId: string;
  merchantName: string;
  promptPayId: string;
  webhookUrl: string;
  publishableKey: string;
  secretKeyHash: string;
  secretKeyMasked: string;
  webhookSecret: string;
  keyRotatedAt: string;
}

export interface OtpChallenge {
  challengeId: string;
  transactionId: string;
  otpHash: string;
  attempts: number;
  maxAttempts: number;
  expiresAt: number;
}

export interface GatewayDatabase {
  merchant: StoredMerchant;
  policy: SecurityPolicy;
  tokens: StoredVaultToken[];
  intents: PaymentIntent[];
  transactions: TransactionRecord[];
  webhooks: WebhookDelivery[];
  otpChallenges?: OtpChallenge[];
  failedAttempts?: Record<string, number[]>;
}

function getLedgerFilePath(): string {
  const dir =
    process.env.VERCEL === '1' || process.env.VERCEL === 'true'
      ? '/tmp/siamvault-data'
      : path.resolve(process.cwd(), '.data');
  return path.join(dir, 'gateway-ledger.json');
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function createInitialDatabase(): GatewayDatabase {
  const secretKey = `sk_live_${crypto.randomBytes(18).toString('hex')}`;
  const webhookSecret = `whsec_${crypto.randomBytes(20).toString('hex')}`;
  const publishableKey = `pk_live_${crypto.randomBytes(14).toString('hex')}`;
  const now = Date.now();

  const sampleSeedToken1 = encryptPanVault('4242424242424242', 'SOMCHAI PRASERT', '08', '28');
  const sampleSeedToken2 = encryptPanVault('5555555555554444', 'NATTAPONG K.', '11', '27');
  const sampleSeedToken3 = encryptPanVault('3528000000003155', 'PIMCHANOK W.', '05', '29');

  const tok1: StoredVaultToken = {
    id: 'tok_vlt_9a41f82c',
    maskedPan: '4242 •••• •••• 4242',
    last4: '4242',
    brand: 'visa',
    expMonth: '08',
    expYear: '28',
    holderName: 'SOMCHAI PRASERT',
    fingerprint: createCardFingerprint('4242424242424242'),
    algorithm: 'aes-256-gcm',
    ivHex: sampleSeedToken1.ivHex,
    authTagHex: sampleSeedToken1.authTagHex,
    ciphertextPreview: `${sampleSeedToken1.ciphertextHex.slice(0, 28)}...`,
    createdAt: new Date(now - 1000 * 60 * 180).toISOString(),
    vault: sampleSeedToken1,
  };

  const tok2: StoredVaultToken = {
    id: 'tok_vlt_7b12d390',
    maskedPan: '5555 •••• •••• 4444',
    last4: '4444',
    brand: 'mastercard',
    expMonth: '11',
    expYear: '27',
    holderName: 'NATTAPONG K.',
    fingerprint: createCardFingerprint('5555555555554444'),
    algorithm: 'aes-256-gcm',
    ivHex: sampleSeedToken2.ivHex,
    authTagHex: sampleSeedToken2.authTagHex,
    ciphertextPreview: `${sampleSeedToken2.ciphertextHex.slice(0, 28)}...`,
    createdAt: new Date(now - 1000 * 60 * 95).toISOString(),
    vault: sampleSeedToken2,
  };

  const tok3: StoredVaultToken = {
    id: 'tok_vlt_3e98a114',
    maskedPan: '3528 •••• •••• 3155',
    last4: '3155',
    brand: 'jcb',
    expMonth: '05',
    expYear: '29',
    holderName: 'PIMCHANOK W.',
    fingerprint: createCardFingerprint('3528000000003155'),
    algorithm: 'aes-256-gcm',
    ivHex: sampleSeedToken3.ivHex,
    authTagHex: sampleSeedToken3.authTagHex,
    ciphertextPreview: `${sampleSeedToken3.ciphertextHex.slice(0, 28)}...`,
    createdAt: new Date(now - 1000 * 60 * 42).toISOString(),
    vault: sampleSeedToken3,
  };

  const transactions: TransactionRecord[] = [
    {
      id: 'tx_sv_894201',
      intentId: 'pi_sv_894201',
      orderId: 'ORD-2026-8841',
      description: 'แพ็กเกจ Cloud Infrastructure รายปี',
      customerEmail: 'somchai@techbkk.co.th',
      amount: 14900,
      feeThb: 409.75,
      netThb: 14490.25,
      currency: 'THB',
      method: 'credit_card',
      brand: 'visa',
      maskedPan: '4242 •••• •••• 4242',
      tokenId: tok1.id,
      status: 'succeeded',
      threeDsStatus: 'authenticated',
      eci: '05',
      riskScore: 12,
      riskChecks: [
        { code: 'LUHN_MOD10', label: 'Luhn Mod-10 Checksum', passed: true, detail: 'หมายเลขบัตรผ่านมาตรฐาน ISO/IEC 7812 (VISA)' },
        { code: 'EXP_CVV', label: 'Expiry & CVV Format', passed: true, detail: 'วันหมดอายุและรหัสความปลอดภัย CVV ถูกต้อง' },
        { code: 'BIN_INTELLIGENCE', label: 'BIN & Fraud Screening', passed: true, detail: 'ยืนยันตัวตน 3DS2 OTP สำเร็จ (ECI 05)' },
      ],
      idempotencyKey: 'idem_8841_a9f0c2',
      createdAt: new Date(now - 1000 * 60 * 180).toISOString(),
      settledAt: new Date(now - 1000 * 60 * 179).toISOString(),
    },
    {
      id: 'tx_sv_894202',
      intentId: 'pi_sv_894202',
      orderId: 'ORD-2026-8842',
      description: 'ค่าสมาชิก Enterprise Workspace',
      customerEmail: 'finance@aroi-retail.th',
      amount: 4500,
      feeThb: 67.5,
      netThb: 4432.5,
      currency: 'THB',
      method: 'promptpay_qr',
      qrReference: 'SVQR8842TH',
      status: 'succeeded',
      threeDsStatus: 'not_applicable',
      riskScore: 6,
      riskChecks: [
        { code: 'EMVCO_CRC16', label: 'EMVCo CRC-16 Integrity', passed: true, detail: 'Checksum CRC-16/CCITT-FALSE ถูกต้อง' },
        { code: 'BANK_HMAC', label: 'Bank Callback HMAC-SHA256', passed: true, detail: 'ลายเซ็น Callback จากธนาคารตรงกัน' },
      ],
      idempotencyKey: 'idem_8842_qr71b2',
      createdAt: new Date(now - 1000 * 60 * 130).toISOString(),
      settledAt: new Date(now - 1000 * 60 * 128).toISOString(),
    },
    {
      id: 'tx_sv_894203',
      intentId: 'pi_sv_894203',
      orderId: 'ORD-2026-8843',
      description: 'อุปกรณ์ POS Terminal รุ่น Pro',
      customerEmail: 'nattapong@cafe-siam.com',
      amount: 1250,
      feeThb: 34.38,
      netThb: 1215.62,
      currency: 'THB',
      method: 'credit_card',
      brand: 'mastercard',
      maskedPan: '5555 •••• •••• 4444',
      tokenId: tok2.id,
      status: 'succeeded',
      threeDsStatus: 'frictionless',
      eci: '05',
      riskScore: 9,
      riskChecks: [
        { code: 'LUHN_MOD10', label: 'Luhn Mod-10 Checksum', passed: true, detail: 'หมายเลขบัตรผ่านมาตรฐาน ISO/IEC 7812 (MASTERCARD)' },
        { code: 'EXP_CVV', label: 'Expiry & CVV Format', passed: true, detail: 'วันหมดอายุและรหัสความปลอดภัย CVV ถูกต้อง' },
      ],
      idempotencyKey: 'idem_8843_mc12c8',
      createdAt: new Date(now - 1000 * 60 * 95).toISOString(),
      settledAt: new Date(now - 1000 * 60 * 95).toISOString(),
    },
    {
      id: 'tx_sv_894204',
      intentId: 'pi_sv_894204',
      orderId: 'ORD-2026-8844',
      description: 'คำสั่งซื้อเครื่องประดับเงินแท้ #8844',
      customerEmail: 'unknown-proxy@mailtest.io',
      amount: 28900,
      feeThb: 0,
      netThb: 0,
      currency: 'THB',
      method: 'credit_card',
      brand: 'visa',
      maskedPan: '4000 •••• •••• 9999',
      status: 'declined',
      threeDsStatus: 'failed',
      riskScore: 86,
      declineReason: 'ปฏิเสธรายการโดยระบบคัดกรองความเสี่ยงสูง (Fraud Block)',
      riskChecks: [
        { code: 'LUHN_MOD10', label: 'Luhn Mod-10 Checksum', passed: true, detail: 'หมายเลขบัตรผ่านมาตรฐาน' },
        { code: 'BIN_INTELLIGENCE', label: 'BIN & Fraud Screening', passed: false, detail: 'BIN ถูกจัดอยู่ในกลุ่มความเสี่ยงสูงหรือถูกอายัด' },
      ],
      idempotencyKey: 'idem_8844_blk09',
      createdAt: new Date(now - 1000 * 60 * 62).toISOString(),
    },
    {
      id: 'tx_sv_894205',
      intentId: 'pi_sv_894205',
      orderId: 'ORD-2026-8845',
      description: 'จองห้องประชุม Co-Working รายวัน',
      customerEmail: 'pimchanok@designhub.th',
      amount: 3200,
      feeThb: 88,
      netThb: 3112,
      currency: 'THB',
      method: 'credit_card',
      brand: 'jcb',
      maskedPan: '3528 •••• •••• 3155',
      tokenId: tok3.id,
      status: 'succeeded',
      threeDsStatus: 'authenticated',
      eci: '05',
      riskScore: 18,
      riskChecks: [
        { code: 'LUHN_MOD10', label: 'Luhn Mod-10 Checksum', passed: true, detail: 'หมายเลขบัตรผ่านมาตรฐาน ISO/IEC 7812 (JCB)' },
        { code: 'EXP_CVV', label: 'Expiry & CVV Format', passed: true, detail: 'ยืนยันตัวตน 3DS2 OTP สำเร็จ' },
      ],
      idempotencyKey: 'idem_8845_jcb55',
      createdAt: new Date(now - 1000 * 60 * 40).toISOString(),
      settledAt: new Date(now - 1000 * 60 * 39).toISOString(),
    },
    {
      id: 'tx_sv_894206',
      intentId: 'pi_sv_894206',
      orderId: 'ORD-2026-8846',
      description: 'ชำระค่าบริการโลจิสติกส์ด่วน',
      customerEmail: 'ops@expresscargo.co.th',
      amount: 890,
      feeThb: 13.35,
      netThb: 876.65,
      currency: 'THB',
      method: 'promptpay_qr',
      qrReference: 'SVQR8846TH',
      status: 'succeeded',
      threeDsStatus: 'not_applicable',
      riskScore: 5,
      riskChecks: [
        { code: 'EMVCO_CRC16', label: 'EMVCo CRC-16 Integrity', passed: true, detail: 'Checksum CRC-16/CCITT-FALSE ถูกต้อง' },
        { code: 'BANK_HMAC', label: 'Bank Callback HMAC-SHA256', passed: true, detail: 'ลายเซ็น Callback จากธนาคารตรงกัน' },
      ],
      idempotencyKey: 'idem_8846_qr92a',
      createdAt: new Date(now - 1000 * 60 * 18).toISOString(),
      settledAt: new Date(now - 1000 * 60 * 17).toISOString(),
    },
  ];

  const samplePayload = JSON.stringify({
    id: 'evt_seed_01',
    type: 'charge.succeeded',
    data: {
      transactionId: 'tx_sv_894206',
      orderId: 'ORD-2026-8846',
      amount: 890,
      currency: 'THB',
      method: 'promptpay_qr',
    },
  });
  const sig = createWebhookSignatureHeader(samplePayload, webhookSecret, Math.floor((now - 1000 * 60 * 17) / 1000));

  const sampleCardPayload = JSON.stringify({
    id: 'evt_seed_02',
    type: 'charge.succeeded',
    data: {
      transactionId: 'tx_sv_894205',
      orderId: 'ORD-2026-8845',
      amount: 3200,
      currency: 'THB',
      method: 'credit_card',
      threeDsStatus: 'authenticated',
    },
  });
  const sigCard = createWebhookSignatureHeader(sampleCardPayload, webhookSecret, Math.floor((now - 1000 * 60 * 39) / 1000));

  return {
    merchant: {
      merchantId: 'mrc_siamvault_th01',
      merchantName: 'SiamCraft Commerce Co., Ltd.',
      promptPayId: '0105564098123',
      webhookUrl: 'https://api.siamcraft.example/webhooks/siamvault',
      publishableKey,
      secretKeyHash: sha256Hex(secretKey),
      secretKeyMasked: `sk_live_••••••••••••••••${secretKey.slice(-6)}`,
      webhookSecret,
      keyRotatedAt: new Date(now - 1000 * 60 * 60 * 24 * 3).toISOString(),
    },
    policy: {
      maxAmountThb: 150000,
      threeDsThresholdThb: 1500,
      maxAttemptsPerMinute: 6,
      strictLuhnCvv: true,
      replayWindowSeconds: 300,
      blockHighRiskBins: true,
    },
    tokens: [tok3, tok2, tok1],
    intents: [
      {
        id: 'pi_sv_demo_open',
        orderId: 'ORD-2026-8900',
        amount: 2450,
        currency: 'THB',
        description: 'ทดลองชำระเงิน SiamVault Gateway Checkout',
        customerEmail: 'customer@siamcraft.co.th',
        idempotencyKey: 'idem_demo_8900',
        status: 'open',
        qrReference: 'SVQR8900TH',
        qrPayload: generatePromptPayEmvcoQr('0105564098123', 2450, 'SVQR8900TH'),
        expiresAt: new Date(now + 1000 * 60 * 15).toISOString(),
        createdAt: new Date(now).toISOString(),
      },
    ],
    transactions,
    webhooks: [
      {
        id: 'wh_dlv_1002',
        event: 'charge.succeeded',
        transactionId: 'tx_sv_894206',
        targetUrl: 'https://api.siamcraft.example/webhooks/siamvault',
        timestamp: sig.timestamp,
        signatureHeader: sig.header,
        payload: samplePayload,
        httpStatus: 200,
        verified: true,
        deliveredAt: new Date(now - 1000 * 60 * 17).toISOString(),
      },
      {
        id: 'wh_dlv_1001',
        event: 'charge.succeeded',
        transactionId: 'tx_sv_894205',
        targetUrl: 'https://api.siamcraft.example/webhooks/siamvault',
        timestamp: sigCard.timestamp,
        signatureHeader: sigCard.header,
        payload: sampleCardPayload,
        httpStatus: 200,
        verified: true,
        deliveredAt: new Date(now - 1000 * 60 * 39).toISOString(),
      },
    ],
    otpChallenges: [],
    failedAttempts: {},
  };
}

let pgPool: Pool | null = null;
let pgSchemaInitialized = false;
let memoryFallbackDb: GatewayDatabase | null = null;

function getPgPool(): Pool | null {
  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!connectionString || connectionString.trim().length === 0) {
    return null;
  }
  if (!pgPool) {
    const isLocal = /localhost|127\.0\.0\.1/.test(connectionString) || connectionString.includes('sslmode=disable');
    pgPool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 10000,
      ssl: isLocal ? false : { rejectUnauthorized: false },
    });
  }
  return pgPool;
}

async function ensurePgSchema(pool: Pool): Promise<void> {
  if (pgSchemaInitialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS siamvault_state (
      id TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  pgSchemaInitialized = true;
}

export async function loadDb(): Promise<GatewayDatabase> {
  const pool = getPgPool();
  if (pool) {
    await ensurePgSchema(pool);
    const res = await pool.query<{ payload: GatewayDatabase }>(
      `SELECT payload FROM siamvault_state WHERE id = 'default' LIMIT 1;`
    );
    if (res.rows.length > 0 && res.rows[0].payload) {
      const db = res.rows[0].payload;
      db.otpChallenges = db.otpChallenges ?? [];
      db.failedAttempts = db.failedAttempts ?? {};
      return db;
    }
    const seed = createInitialDatabase();
    await saveDb(seed);
    return seed;
  }

  const filePath = getLedgerFilePath();
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as GatewayDatabase;
      parsed.otpChallenges = parsed.otpChallenges ?? [];
      parsed.failedAttempts = parsed.failedAttempts ?? {};
      memoryFallbackDb = parsed;
      return parsed;
    } catch {
      // Fallback below
    }
  }

  if (memoryFallbackDb) {
    return memoryFallbackDb;
  }

  const seed = createInitialDatabase();
  await saveDb(seed);
  return seed;
}

export async function saveDb(db: GatewayDatabase): Promise<void> {
  memoryFallbackDb = db;
  const pool = getPgPool();
  if (pool) {
    await ensurePgSchema(pool);
    await pool.query(
      `
      INSERT INTO siamvault_state (id, payload, updated_at)
      VALUES ('default', $1::jsonb, NOW())
      ON CONFLICT (id)
      DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW();
      `,
      [JSON.stringify(db)]
    );
    return;
  }

  try {
    const filePath = getLedgerFilePath();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    // Keep memoryFallbackDb if disk write unavailable
  }
}

export function computeKpis(transactions: TransactionRecord[]): DashboardKPIs {
  let totalVolumeThb = 0;
  let netSettlementThb = 0;
  let succeededCount = 0;
  let blockedCount = 0;
  let cardVolumeThb = 0;
  let qrVolumeThb = 0;

  for (const tx of transactions) {
    if (tx.status === 'succeeded') {
      succeededCount += 1;
      totalVolumeThb += tx.amount;
      netSettlementThb += tx.netThb;
      if (tx.method === 'credit_card') cardVolumeThb += tx.amount;
      if (tx.method === 'promptpay_qr') qrVolumeThb += tx.amount;
    } else if (tx.status === 'declined') {
      blockedCount += 1;
    }
  }

  const finalizedCount = transactions.filter((t) => t.status === 'succeeded' || t.status === 'declined' || t.status === 'refunded').length;
  const approvalRatePct = finalizedCount > 0 ? round2((succeededCount / finalizedCount) * 100) : 100;

  return {
    totalVolumeThb: round2(totalVolumeThb),
    netSettlementThb: round2(netSettlementThb),
    approvalRatePct,
    totalCount: transactions.length,
    succeededCount,
    blockedCount,
    cardVolumeThb: round2(cardVolumeThb),
    qrVolumeThb: round2(qrVolumeThb),
  };
}

export function toPublicMerchant(m: StoredMerchant): MerchantPublicInfo {
  return {
    merchantId: m.merchantId,
    merchantName: m.merchantName,
    promptPayId: m.promptPayId,
    webhookUrl: m.webhookUrl,
    publishableKey: m.publishableKey,
    secretKeyMasked: m.secretKeyMasked,
    webhookSecretMasked: `whsec_••••••••••••••••${m.webhookSecret.slice(-6)}`,
    webhookSecretRawForVerifier: m.webhookSecret,
    keyRotatedAt: m.keyRotatedAt,
  };
}

export function buildDashboardPayload(db: GatewayDatabase): DashboardPayload {
  return {
    merchant: toPublicMerchant(db.merchant),
    policy: db.policy,
    kpis: computeKpis(db.transactions),
    transactions: db.transactions,
    vaultTokens: db.tokens.map(({ vault: _vault, ...rest }) => rest),
    webhooks: db.webhooks,
  };
}

export async function getDashboardPayload(): Promise<DashboardPayload> {
  const db = await loadDb();
  return buildDashboardPayload(db);
}

export function dispatchSignedWebhook(
  db: GatewayDatabase,
  event: WebhookDelivery['event'],
  data: Record<string, unknown>,
  transactionId?: string,
  targetUrlOverride?: string
): WebhookDelivery {
  const payloadObj = {
    id: `evt_${crypto.randomBytes(6).toString('hex')}`,
    type: event,
    created: Math.floor(Date.now() / 1000),
    merchantId: db.merchant.merchantId,
    data,
  };
  const payload = JSON.stringify(payloadObj);
  const sig = createWebhookSignatureHeader(payload, db.merchant.webhookSecret);
  const targetUrl = targetUrlOverride?.trim() || db.merchant.webhookUrl;

  const delivery: WebhookDelivery = {
    id: `wh_dlv_${crypto.randomBytes(5).toString('hex')}`,
    event,
    transactionId,
    targetUrl,
    timestamp: sig.timestamp,
    signatureHeader: sig.header,
    payload,
    httpStatus: 200,
    verified: true,
    deliveredAt: new Date().toISOString(),
  };

  db.webhooks = [delivery, ...db.webhooks].slice(0, 50);
  return delivery;
}

export async function deliverWebhookHttp(delivery: WebhookDelivery): Promise<void> {
  const url = delivery.targetUrl?.trim();
  if (!url || !/^https?:\/\//i.test(url) || url.includes('.example/')) {
    return;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SiamVault-Signature': delivery.signatureHeader,
        'X-SiamVault-Event': delivery.event,
      },
      body: delivery.payload,
      signal: AbortSignal.timeout(5000),
    });
    delivery.httpStatus = res.status;
  } catch {
    delivery.httpStatus = 0;
  }
}
