export type PaymentMethod = 'credit_card' | 'promptpay_qr';

export type CardBrand = 'visa' | 'mastercard' | 'jcb' | 'amex' | 'unknown';

export type TransactionStatus =
  | 'succeeded'
  | 'requires_3ds'
  | 'pending_qr'
  | 'declined'
  | 'refunded';

export type ThreeDsStatus = 'authenticated' | 'challenge_pending' | 'frictionless' | 'failed' | 'not_applicable';

export interface RiskCheckItem {
  code: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface VaultTokenRecord {
  id: string;
  maskedPan: string;
  last4: string;
  brand: CardBrand;
  expMonth: string;
  expYear: string;
  holderName: string;
  fingerprint: string;
  algorithm: 'aes-256-gcm';
  ivHex: string;
  authTagHex: string;
  ciphertextPreview: string;
  createdAt: string;
}

export interface PaymentIntent {
  id: string;
  orderId: string;
  amount: number;
  currency: 'THB';
  description: string;
  customerEmail: string;
  idempotencyKey: string;
  status: 'open' | 'requires_3ds' | 'succeeded' | 'declined';
  qrPayload: string;
  qrReference: string;
  expiresAt: string;
  createdAt: string;
  transactionId?: string;
  stripePaymentIntentId?: string;
}

export interface TransactionRecord {
  id: string;
  intentId: string;
  orderId: string;
  description: string;
  customerEmail: string;
  amount: number;
  feeThb: number;
  netThb: number;
  currency: 'THB';
  method: PaymentMethod;
  brand?: CardBrand;
  maskedPan?: string;
  tokenId?: string;
  qrReference?: string;
  stripePaymentIntentId?: string;
  processor?: 'siamvault_sandbox' | 'stripe_thailand';
  status: TransactionStatus;
  threeDsStatus: ThreeDsStatus;
  eci?: string;
  riskScore: number;
  riskChecks: RiskCheckItem[];
  idempotencyKey: string;
  declineReason?: string;
  createdAt: string;
  settledAt?: string;
  refundedAt?: string;
}

export interface WebhookDelivery {
  id: string;
  event: 'charge.succeeded' | 'charge.requires_3ds' | 'charge.declined' | 'charge.refunded' | 'ping.verified';
  transactionId?: string;
  targetUrl: string;
  timestamp: number;
  signatureHeader: string;
  payload: string;
  httpStatus: number;
  verified: boolean;
  deliveredAt: string;
}

export interface SecurityPolicy {
  maxAmountThb: number;
  threeDsThresholdThb: number;
  maxAttemptsPerMinute: number;
  strictLuhnCvv: boolean;
  replayWindowSeconds: number;
  blockHighRiskBins: boolean;
}

export interface MerchantPublicInfo {
  merchantId: string;
  merchantName: string;
  promptPayId: string;
  webhookUrl: string;
  publishableKey: string;
  secretKeyMasked: string;
  webhookSecretMasked: string;
  webhookSecretRawForVerifier: string;
  keyRotatedAt: string;
}

export interface DashboardKPIs {
  totalVolumeThb: number;
  netSettlementThb: number;
  approvalRatePct: number;
  totalCount: number;
  succeededCount: number;
  blockedCount: number;
  cardVolumeThb: number;
  qrVolumeThb: number;
}

export interface DashboardPayload {
  merchant: MerchantPublicInfo;
  policy: SecurityPolicy;
  kpis: DashboardKPIs;
  transactions: TransactionRecord[];
  vaultTokens: VaultTokenRecord[];
  webhooks: WebhookDelivery[];
}

export interface StripeConfigResponse {
  configured: boolean;
  publishableKey: string | null;
  mode: 'live' | 'test' | 'unconfigured';
  webhookConfigured: boolean;
}
