import type { CardBrand } from '../types/gateway';

export function formatThb(amount: number): string {
  return new Intl.NumberFormat('th-TH', {
    style: 'currency',
    currency: 'THB',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatDateTimeTh(iso: string): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat('th-TH', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

export function detectClientCardBrand(pan: string): CardBrand {
  const clean = pan.replace(/\D/g, '');
  if (/^4/.test(clean)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(clean)) return 'mastercard';
  if (/^35(2[89]|[3-8][0-9])/.test(clean)) return 'jcb';
  if (/^3[47]/.test(clean)) return 'amex';
  return 'unknown';
}

export function checkClientLuhn(pan: string): boolean {
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

export function formatCardNumberSpacing(raw: string): string {
  const clean = raw.replace(/\D/g, '').slice(0, 16);
  return clean.replace(/(\d{4})(?=\d)/g, '$1 ');
}

export function brandDisplayName(brand?: CardBrand): string {
  switch (brand) {
    case 'visa':
      return 'Visa';
    case 'mastercard':
      return 'Mastercard';
    case 'jcb':
      return 'JCB';
    case 'amex':
      return 'American Express';
    default:
      return 'Card';
  }
}

export interface EmvcoTagItem {
  tag: string;
  name: string;
  length: string;
  value: string;
}

const EMVCO_TAG_NAMES: Record<string, string> = {
  '00': 'Payload Format Indicator',
  '01': 'Point of Initiation (Dynamic QR)',
  '29': 'Merchant Account (PromptPay AID)',
  '53': 'Transaction Currency (764 = THB)',
  '54': 'Transaction Amount (THB)',
  '58': 'Country Code (TH)',
  '62': 'Additional Data (Reference)',
  '63': 'CRC-16/CCITT-FALSE Checksum',
};

export function parseEmvcoTlv(payload: string): EmvcoTagItem[] {
  const items: EmvcoTagItem[] = [];
  let i = 0;
  while (i + 4 <= payload.length) {
    const tag = payload.slice(i, i + 2);
    const lenStr = payload.slice(i + 2, i + 4);
    const len = Number.parseInt(lenStr, 10);
    if (Number.isNaN(len) || i + 4 + len > payload.length) break;
    const value = payload.slice(i + 4, i + 4 + len);
    items.push({
      tag,
      name: EMVCO_TAG_NAMES[tag] ?? `EMVCo Tag ${tag}`,
      length: lenStr,
      value,
    });
    i += 4 + len;
  }
  return items;
}
