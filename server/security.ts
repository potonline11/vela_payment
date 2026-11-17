import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CardBrand, RiskCheckItem, SecurityPolicy } from '../src/types/gateway.ts';

function getWritableDataDir(): string {
  if (process.env.VERCEL === '1' || process.env.VERCEL === 'true') {
    return '/tmp/siamvault-data';
  }
  return path.resolve(process.cwd(), '.data');
}

function getOrCreateMasterKey(): Buffer {
  if (process.env.GATEWAY_MASTER_KEY && process.env.GATEWAY_MASTER_KEY.trim().length > 0) {
    return crypto.createHash('sha256').update(process.env.GATEWAY_MASTER_KEY.trim()).digest();
  }

  const dirs = [getWritableDataDir(), '/tmp/siamvault-data'];
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const keyPath = path.join(dir, 'vault-master.key');
      if (fs.existsSync(keyPath)) {
        const hex = fs.readFileSync(keyPath, 'utf8').trim();
        if (/^[0-9a-f]{64}$/i.test(hex)) {
          return Buffer.from(hex, 'hex');
        }
      }
      const freshKey = crypto.randomBytes(32);
      fs.writeFileSync(keyPath, freshKey.toString('hex'), { mode: 0o600 });
      return freshKey;
    } catch {
      // Try next writable directory
    }
  }

  console.warn('[SiamVault] GATEWAY_MASTER_KEY is not set; using ephemeral key for this process.');
  return crypto.randomBytes(32);
}

const MASTER_KEY = getOrCreateMasterKey();

export interface EncryptedVaultEnvelope {
  algorithm: 'aes-256-gcm';
  ivHex: string;
  authTagHex: string;
  ciphertextHex: string;
}

export function encryptPanVault(plainPan: string, holderName: string, expMonth: string, expYear: string): EncryptedVaultEnvelope {
  const iv = crypto.randomBytes(12); // 96-bit NIST-recommended IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const payload = JSON.stringify({ pan: plainPan, holderName, expMonth, expYear });
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    algorithm: 'aes-256-gcm',
    ivHex: iv.toString('hex'),
    authTagHex: authTag.toString('hex'),
    ciphertextHex: encrypted.toString('hex'),
  };
}

export function decryptPanVault(envelope: EncryptedVaultEnvelope): { pan: string; holderName: string; expMonth: string; expYear: string } {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    MASTER_KEY,
    Buffer.from(envelope.ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(envelope.authTagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertextHex, 'hex')),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString('utf8'));
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function createCardFingerprint(pan: string): string {
  return crypto.createHmac('sha256', MASTER_KEY).update(pan).digest('hex').slice(0, 24);
}

export function maskPan(pan: string): string {
  const clean = pan.replace(/\D/g, '');
  const first4 = clean.slice(0, 4);
  const last4 = clean.slice(-4);
  return `${first4} •••• •••• ${last4}`;
}

export function detectCardBrand(pan: string): CardBrand {
  const clean = pan.replace(/\D/g, '');
  if (/^4/.test(clean)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(clean)) return 'mastercard';
  if (/^35(2[89]|[3-8][0-9])/.test(clean)) return 'jcb';
  if (/^3[47]/.test(clean)) return 'amex';
  return 'unknown';
}

export function validateLuhn(pan: string): boolean {
  const clean = pan.replace(/\D/g, '');
  if (clean.length < 13 || clean.length > 19) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = clean.length - 1; i >= 0; i -= 1) {
    let digit = Number.parseInt(clean.charAt(i), 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

export function validateExpiry(expMonth: string, expYear: string): boolean {
  const month = Number.parseInt(expMonth, 10);
  let year = Number.parseInt(expYear, 10);
  if (Number.isNaN(month) || Number.isNaN(year) || month < 1 || month > 12) return false;
  if (expYear.length === 2) year += 2000;
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  if (year < currentYear) return false;
  if (year === currentYear && month < currentMonth) return false;
  return true;
}

export function createWebhookSignatureHeader(payload: string, secret: string, timestamp?: number): {
  timestamp: number;
  signature: string;
  header: string;
} {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const signedPayload = `${ts}.${payload}`;
  const sig = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  return {
    timestamp: ts,
    signature: sig,
    header: `t=${ts},v1=${sig}`,
  };
}

export function verifyWebhookSignatureHeader(
  payload: string,
  header: string,
  secret: string,
  replayWindowSeconds: number
): { valid: boolean; reason: string; timestamp?: number } {
  const parts = header.split(',').reduce<Record<string, string>>((acc, item) => {
    const [k, v] = item.trim().split('=');
    if (k && v) acc[k] = v;
    return acc;
  }, {});

  const tsStr = parts.t;
  const sigHex = parts.v1;
  if (!tsStr || !sigHex) {
    return { valid: false, reason: 'รูปแบบ Header ไม่ถูกต้อง (ต้องมี t= และ v1=)' };
  }

  const ts = Number.parseInt(tsStr, 10);
  if (Number.isNaN(ts)) {
    return { valid: false, reason: 'Timestamp ไม่ถูกต้อง' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > replayWindowSeconds) {
    return {
      valid: false,
      reason: `Replay Protection: Timestamp เกินหน้าต่างเวลา ${replayWindowSeconds} วินาที`,
      timestamp: ts,
    };
  }

  const expectedHex = crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const actualBuf = Buffer.from(sigHex, 'hex');

  if (expectedBuf.length !== actualBuf.length) {
    return { valid: false, reason: 'ลายเซ็น HMAC-SHA256 ไม่ตรงกัน', timestamp: ts };
  }

  const isMatch = crypto.timingSafeEqual(expectedBuf, actualBuf);
  return isMatch
    ? { valid: true, reason: 'ยืนยันลายเซ็น HMAC-SHA256 สำเร็จ (Constant-Time Verified)', timestamp: ts }
    : { valid: false, reason: 'ลายเซ็น HMAC-SHA256 ไม่ตรงกัน (Signature Mismatch)', timestamp: ts };
}

function tlv(tag: string, value: string): string {
  const len = value.length.toString().padStart(2, '0');
  return `${tag}${len}${value}`;
}

export function computeCrc16Ccitt(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i += 1) {
    crc ^= input.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j += 1) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function generatePromptPayEmvcoQr(promptPayId: string, amountThb: number, referenceLabel: string): string {
  const cleanId = promptPayId.replace(/\D/g, '');
  let targetTag = '';
  if (cleanId.length === 10 && cleanId.startsWith('0')) {
    targetTag = tlv('01', `0066${cleanId.slice(1)}`);
  } else if (cleanId.length === 13) {
    targetTag = tlv('02', cleanId);
  } else {
    targetTag = tlv('03', cleanId.padEnd(15, '0').slice(0, 15));
  }

  const merchantAccountInfo = tlv('29', `${tlv('00', 'A000000677010111')}${targetTag}`);
  const formattedAmount = amountThb.toFixed(2);
  const additionalData = tlv('62', tlv('05', referenceLabel.slice(0, 20)));

  const payloadWithoutCrc =
    tlv('00', '01') +
    tlv('01', '12') +
    merchantAccountInfo +
    tlv('53', '764') +
    tlv('54', formattedAmount) +
    tlv('58', 'TH') +
    additionalData +
    '6304';

  const crc = computeCrc16Ccitt(payloadWithoutCrc);
  return `${payloadWithoutCrc}${crc}`;
}

export function evaluateRisk(params: {
  pan: string;
  cvv: string;
  expMonth: string;
  expYear: string;
  amount: number;
  recentFailedCount: number;
  policy: SecurityPolicy;
}): {
  riskScore: number;
  checks: RiskCheckItem[];
  blocked: boolean;
  requires3DS: boolean;
  declineReason?: string;
} {
  const cleanPan = params.pan.replace(/\D/g, '');
  const brand = detectCardBrand(cleanPan);
  const luhnOk = validateLuhn(cleanPan);
  const expiryOk = validateExpiry(params.expMonth, params.expYear);
  const expectedCvvLen = brand === 'amex' ? 4 : 3;
  const cvvOk = new RegExp(`^\\d{${expectedCvvLen}}$`).test(params.cvv.trim());
  const amountOk = params.amount > 0 && params.amount <= params.policy.maxAmountThb;
  const velocityOk = params.recentFailedCount < params.policy.maxAttemptsPerMinute;

  const isHighRiskBin =
    cleanPan.startsWith('400000') ||
    cleanPan.endsWith('0002') ||
    cleanPan.endsWith('9999');
  const binCheckOk = !(params.policy.blockHighRiskBins && isHighRiskBin);

  const checks: RiskCheckItem[] = [
    {
      code: 'LUHN_MOD10',
      label: 'Luhn Mod-10 Checksum',
      passed: luhnOk,
      detail: luhnOk ? `หมายเลขบัตรผ่านมาตรฐาน ISO/IEC 7812 (${brand.toUpperCase()})` : 'หมายเลขบัตรไม่ผ่านการตรวจสอบ Luhn Checksum',
    },
    {
      code: 'EXP_CVV',
      label: 'Expiry & CVV Format',
      passed: expiryOk && cvvOk,
      detail: expiryOk && cvvOk ? 'วันหมดอายุและรหัสความปลอดภัย CVV ถูกต้อง' : 'วันหมดอายุหรือรหัส CVV ไม่ถูกต้อง',
    },
    {
      code: 'AMOUNT_CAP',
      label: 'Transaction Ceiling',
      passed: amountOk,
      detail: amountOk
        ? `ยอดชำระ ฿${params.amount.toLocaleString('en-US')} อยู่ในวงเงินไม่เกิน ฿${params.policy.maxAmountThb.toLocaleString('en-US')}`
        : `ยอดชำระเกินวงเงินสูงสุดที่กำหนด (฿${params.policy.maxAmountThb.toLocaleString('en-US')})`,
    },
    {
      code: 'VELOCITY_GUARD',
      label: 'Velocity Rate Guard',
      passed: velocityOk,
      detail: velocityOk
        ? `อัตราการเรียกใช้งานปกติ (${params.recentFailedCount}/${params.policy.maxAttemptsPerMinute} ครั้ง/นาที)`
        : 'ตรวจพบความพยายามชำระเงินผิดพลาดถี่ผิดปกติ (Velocity Exceeded)',
    },
    {
      code: 'BIN_INTELLIGENCE',
      label: 'BIN & Fraud Screening',
      passed: binCheckOk,
      detail: binCheckOk ? 'BIN อยู่ในบัญชีขาว ไม่พบประวัติทุจริต' : 'BIN ถูกจัดอยู่ในกลุ่มความเสี่ยงสูงหรือถูกอายัด',
    },
  ];

  let score = 8;
  if (!luhnOk) score += 45;
  if (!expiryOk || !cvvOk) score += 35;
  if (!amountOk) score += 40;
  if (!velocityOk) score += 35;
  if (!binCheckOk) score += 60;
  if (params.amount >= params.policy.threeDsThresholdThb) score += 18;
  score = Math.min(100, score);

  if (params.policy.strictLuhnCvv && (!luhnOk || !expiryOk || !cvvOk)) {
    return {
      riskScore: score,
      checks,
      blocked: true,
      requires3DS: false,
      declineReason: !luhnOk ? 'หมายเลขบัตรไม่ผ่าน Luhn Validation' : !expiryOk ? 'บัตรหมดอายุ' : 'รหัส CVV ไม่ถูกต้อง',
    };
  }

  if (!amountOk) {
    return {
      riskScore: score,
      checks,
      blocked: true,
      requires3DS: false,
      declineReason: 'ยอดเงินเกินเพดานความปลอดภัยต่อรายการ',
    };
  }

  if (!velocityOk) {
    return {
      riskScore: score,
      checks,
      blocked: true,
      requires3DS: false,
      declineReason: 'ถูกจำกัดความถี่ชั่วคราว (Velocity Rate Limit)',
    };
  }

  if (!binCheckOk) {
    return {
      riskScore: score,
      checks,
      blocked: true,
      requires3DS: false,
      declineReason: 'ปฏิเสธรายการโดยระบบคัดกรองความเสี่ยงสูง (Fraud Block)',
    };
  }

  const requires3DS =
    params.amount >= params.policy.threeDsThresholdThb ||
    cleanPan.endsWith('3155') ||
    cleanPan.endsWith('0005');

  return {
    riskScore: score,
    checks,
    blocked: false,
    requires3DS,
  };
}
