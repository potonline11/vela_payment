import { useCallback, useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CreditCard,
  KeyRound,
  Lock,
  Plus,
  QrCode,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import type {
  DashboardPayload,
  PaymentIntent,
  StripeConfigResponse,
  TransactionRecord,
} from '../types/gateway';
import {
  brandDisplayName,
  checkClientLuhn,
  detectClientCardBrand,
  formatCardNumberSpacing,
  formatThb,
  parseEmvcoTlv,
} from '../lib/formatters';
import { StripeCheckoutPanel } from './StripeCheckoutPanel';

interface LiveCheckoutProps {
  dashboard: DashboardPayload;
  onDashboardUpdate: (next: DashboardPayload) => void;
  onGoToLedger: () => void;
}

const TEST_CARDS = [
  {
    label: 'Visa ปกติ (Frictionless / 3DS ตามวงเงิน)',
    pan: '4242 4242 4242 4242',
    expMonth: '08',
    expYear: '28',
    cvv: '842',
    holder: 'SOMCHAI PRASERT',
  },
  {
    label: 'JCB บังคับ 3DS2 OTP Challenge',
    pan: '3528 0000 0000 3155',
    expMonth: '05',
    expYear: '29',
    cvv: '355',
    holder: 'PIMCHANOK WONGSA',
  },
  {
    label: 'Mastercard ทั่วไป',
    pan: '5555 5555 5555 4444',
    expMonth: '11',
    expYear: '27',
    cvv: '444',
    holder: 'NATTAPONG K.',
  },
  {
    label: 'Visa ความเสี่ยงสูง (ทดสอบ Fraud Block)',
    pan: '4000 0000 0000 9999',
    expMonth: '09',
    expYear: '28',
    cvv: '999',
    holder: 'TEST HIGH RISK',
  },
];

export function LiveCheckout({ dashboard, onDashboardUpdate, onGoToLedger }: LiveCheckoutProps) {
  const [intent, setIntent] = useState<PaymentIntent | null>(null);
  const [processor, setProcessor] = useState<'stripe_thailand' | 'siamvault_sandbox'>('siamvault_sandbox');
  const [stripeConfig, setStripeConfig] = useState<StripeConfigResponse>({
    configured: false,
    publishableKey: null,
    mode: 'unconfigured',
    webhookConfigured: false,
  });

  const [method, setMethod] = useState<'credit_card' | 'promptpay_qr'>('credit_card');
  const [showIntentForm, setShowIntentForm] = useState(false);

  // New Intent builder fields
  const [newAmount, setNewAmount] = useState('1850');
  const [newDescription, setNewDescription] = useState('ค่าสินค้าและบริการ SiamVault Checkout');
  const [newEmail, setNewEmail] = useState('buyer@example.co.th');
  const [creatingIntent, setCreatingIntent] = useState(false);

  // Credit Card form fields
  const [pan, setPan] = useState(TEST_CARDS[0].pan);
  const [holderName, setHolderName] = useState(TEST_CARDS[0].holder);
  const [expMonth, setExpMonth] = useState(TEST_CARDS[0].expMonth);
  const [expYear, setExpYear] = useState(TEST_CARDS[0].expYear);
  const [cvv, setCvv] = useState(TEST_CARDS[0].cvv);

  // Payment processing state
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [completedTx, setCompletedTx] = useState<TransactionRecord | null>(null);

  // 3DS2 Challenge state
  const [threeDsSession, setThreeDsSession] = useState<{
    transactionId: string;
    challengeId: string;
    sandboxOtpHint: string;
  } | null>(null);
  const [otpInput, setOtpInput] = useState('');
  const [verifyingOtp, setVerifyingOtp] = useState(false);

  // QR Code state
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [showTlvInspector, setShowTlvInspector] = useState(false);
  const [bankCallbackHeader, setBankCallbackHeader] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(900);

  // Fetch Stripe configuration & check URL return from 3DS/redirect
  useEffect(() => {
    let active = true;
    async function loadStripeConfigAndReturn() {
      try {
        const res = await fetch('/api/v1/stripe/config');
        if (res.ok && active) {
          const cfg = (await res.json()) as StripeConfigResponse;
          setStripeConfig(cfg);
          if (cfg.configured) {
            setProcessor('stripe_thailand');
          }
        }
      } catch {
        // Keep sandbox fallback
      }

      const params = new URLSearchParams(window.location.search);
      const returnedPi = params.get('payment_intent');
      if (returnedPi && active) {
        const syncRes = await fetch('/api/v1/stripe/sync-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stripePaymentIntentId: returnedPi }),
        });
        if (syncRes.ok && active) {
          const json = await syncRes.json();
          if (json.status === 'succeeded' && json.transaction && json.dashboard) {
            setCompletedTx(json.transaction);
            onDashboardUpdate(json.dashboard);
            window.history.replaceState({}, '', window.location.pathname);
          }
        }
      }
    }
    loadStripeConfigAndReturn();
    return () => {
      active = false;
    };
  }, [onDashboardUpdate]);

  // Initialize an open intent on mount
  useEffect(() => {
    if (intent) return;
    let active = true;
    async function initIntent() {
      const res = await fetch('/api/v1/payment-intents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: 1850,
          description: 'แพ็กเกจ Cloud Security & Gateway API',
          customerEmail: 'buyer@example.co.th',
        }),
      });
      if (res.ok && active) {
        const json = await res.json();
        setIntent(json.intent);
      }
    }
    initIntent();
    return () => {
      active = false;
    };
  }, [intent]);

  // Generate scannable PromptPay QR image when intent changes
  useEffect(() => {
    if (!intent?.qrPayload) return;
    let cancelled = false;
    QRCode.toDataURL(intent.qrPayload, {
      width: 240,
      margin: 2,
      color: { dark: '#0F172A', light: '#FFFFFF' },
    }).then((url) => {
      if (!cancelled) setQrDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [intent?.qrPayload]);

  // Countdown timer for dynamic QR expiry
  useEffect(() => {
    if (!intent?.expiresAt || completedTx) return;
    const tick = () => {
      const diff = Math.max(0, Math.floor((new Date(intent.expiresAt).getTime() - Date.now()) / 1000));
      setSecondsLeft(diff);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [intent?.expiresAt, completedTx]);

  const cardBrand = useMemo(() => detectClientCardBrand(pan), [pan]);
  const luhnValid = useMemo(() => checkClientLuhn(pan), [pan]);
  const tlvItems = useMemo(() => (intent?.qrPayload ? parseEmvcoTlv(intent.qrPayload) : []), [intent?.qrPayload]);

  const handleStripeSuccess = useCallback(
    (tx: TransactionRecord, nextDashboard: DashboardPayload) => {
      onDashboardUpdate(nextDashboard);
      setCompletedTx(tx);
      setErrorMsg(null);
    },
    [onDashboardUpdate]
  );

  async function handleCreateIntent(e: React.FormEvent) {
    e.preventDefault();
    setCreatingIntent(true);
    setErrorMsg(null);
    setCompletedTx(null);
    setThreeDsSession(null);
    setBankCallbackHeader(null);
    try {
      const res = await fetch('/api/v1/payment-intents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: Number(newAmount),
          description: newDescription,
          customerEmail: newEmail,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json.error ?? 'ไม่สามารถสร้าง Payment Intent ได้');
        return;
      }
      setIntent(json.intent);
      setShowIntentForm(false);
    } finally {
      setCreatingIntent(false);
    }
  }

  async function handleQuickNewIntent() {
    setErrorMsg(null);
    setCompletedTx(null);
    setThreeDsSession(null);
    setBankCallbackHeader(null);
    setOtpInput('');
    const res = await fetch('/api/v1/payment-intents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: Number(newAmount) || 1850,
        description: newDescription || 'ค่าสินค้าและบริการ SiamVault Checkout',
        customerEmail: newEmail || 'buyer@example.co.th',
      }),
    });
    const json = await res.json();
    if (res.ok) {
      setIntent(json.intent);
    }
  }

  async function handleCardSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!intent) return;
    setSubmitting(true);
    setErrorMsg(null);

    try {
      const tokRes = await fetch('/api/v1/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pan,
          holderName,
          expMonth,
          expYear,
          cvv,
        }),
      });
      const tokJson = await tokRes.json();
      if (!tokRes.ok) {
        setErrorMsg(tokJson.error ?? 'การเข้ารหัส Token บัตรไม่สำเร็จ');
        return;
      }

      const idempotencyKey = `idem_chg_${intent.id}_${tokJson.token.id.slice(-6)}`;
      const chgRes = await fetch('/api/v1/charges', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          intentId: intent.id,
          tokenId: tokJson.token.id,
          cvv,
          idempotencyKey,
        }),
      });
      const chgJson = await chgRes.json();

      if (chgJson.dashboard) {
        onDashboardUpdate(chgJson.dashboard);
      }

      if (chgRes.status === 202 && chgJson.requires3DS) {
        setThreeDsSession({
          transactionId: chgJson.transaction.id,
          challengeId: chgJson.challengeId,
          sandboxOtpHint: chgJson.sandboxOtpHint,
        });
        setOtpInput('');
        return;
      }

      if (!chgRes.ok) {
        setErrorMsg(chgJson.error ?? 'การตัดบัตรถูกปฏิเสธ');
        return;
      }

      setCompletedTx(chgJson.transaction);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    if (!threeDsSession) return;
    setVerifyingOtp(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/v1/charges/${threeDsSession.transactionId}/verify-3ds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeId: threeDsSession.challengeId,
          otpCode: otpInput,
        }),
      });
      const json = await res.json();
      if (json.dashboard) {
        onDashboardUpdate(json.dashboard);
      }
      if (!res.ok) {
        setErrorMsg(json.error ?? 'การยืนยัน OTP ไม่สำเร็จ');
        if (json.locked || res.status === 410) {
          setThreeDsSession(null);
        }
        return;
      }
      setThreeDsSession(null);
      setCompletedTx(json.transaction);
    } finally {
      setVerifyingOtp(false);
    }
  }

  async function handleSimulateBankQrCallback() {
    if (!intent) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/v1/qr/simulate-bank-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intentId: intent.id }),
      });
      const json = await res.json();
      if (json.dashboard) {
        onDashboardUpdate(json.dashboard);
      }
      if (!res.ok) {
        setErrorMsg(json.error ?? 'ไม่สามารถยืนยันรายการ QR ได้');
        return;
      }
      setBankCallbackHeader(json.bankSignatureHeader ?? null);
      setCompletedTx(json.transaction);
    } finally {
      setSubmitting(false);
    }
  }

  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, '0');
  const ss = String(secondsLeft % 60).padStart(2, '0');

  return (
    <div className="space-y-6">
      {/* Intent Header & Customizer Bar */}
      <div className="bg-white border border-slate-200 rounded-lg p-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">หน้าชำระเงินมาตรฐาน Hosted Checkout</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              รองรับทั้งการตัดเงินจริงผ่าน Stripe Thailand (บัตรเครดิต + PromptPay) และโหมดทดสอบ SiamVault Sandbox
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setShowIntentForm((v) => !v)}
              className="px-3.5 py-2 text-xs font-medium border border-slate-200 rounded-md text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" />
              กำหนดยอดชำระใหม่
            </button>
            <button
              type="button"
              onClick={handleQuickNewIntent}
              className="px-3.5 py-2 text-xs font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              รีเซ็ตออเดอร์
            </button>
          </div>
        </div>

        {showIntentForm && (
          <form onSubmit={handleCreateIntent} className="mt-5 pt-5 border-t border-slate-100 grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">ยอดเงิน (THB)</label>
              <input
                type="number"
                min={10}
                step="0.01"
                required
                value={newAmount}
                onChange={(e) => setNewAmount(e.target.value)}
                className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-teal-600 focus:bg-white"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-700 mb-1">รายละเอียดสินค้า/บริการ</label>
              <input
                type="text"
                required
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-teal-600 focus:bg-white"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">อีเมลลูกค้า</label>
              <div className="flex gap-2">
                <input
                  type="email"
                  required
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="w-full px-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-teal-600 focus:bg-white"
                />
                <button
                  type="submit"
                  disabled={creatingIntent}
                  className="px-4 py-2 text-xs font-medium bg-teal-700 text-white rounded-md hover:bg-teal-800 whitespace-nowrap shrink-0"
                >
                  {creatingIntent ? 'กำลังสร้าง...' : 'สร้าง'}
                </button>
              </div>
            </div>
          </form>
        )}
      </div>

      {/* Main 2-Column Checkout Container */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left Column: Order Summary & Security Guarantees */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-6 flex flex-col justify-between">
          <div className="space-y-6">
            <div>
              <div className="text-xs font-medium text-slate-500">{dashboard.merchant.merchantName}</div>
              <div className="mt-2 text-3xl font-semibold text-slate-900 font-mono tabular-nums tracking-tight">
                {intent ? formatThb(intent.amount) : '฿0.00'}
              </div>
              <p className="mt-2 text-sm text-slate-600">{intent?.description ?? 'กำลังเตรียมคำสั่งรับชำระเงิน...'}</p>
            </div>

            {intent && (
              <dl className="pt-5 border-t border-slate-100 space-y-2.5 text-xs">
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-slate-500">Order Reference</dt>
                  <dd className="font-mono font-medium text-slate-900">{intent.orderId}</dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-slate-500">Payment Intent ID</dt>
                  <dd className="font-mono text-slate-700">{intent.id}</dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-slate-500">PromptPay Merchant ID</dt>
                  <dd className="font-mono text-slate-700">{dashboard.merchant.promptPayId}</dd>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <dt className="text-slate-500">Stripe Thailand</dt>
                  <dd className="font-mono text-slate-700">
                    {stripeConfig.configured
                      ? stripeConfig.mode === 'live'
                        ? 'เชื่อมต่อแล้ว (Live)'
                        : 'เชื่อมต่อแล้ว (Test)'
                      : 'ยังไม่ได้ตั้งค่าคีย์'}
                  </dd>
                </div>
              </dl>
            )}
          </div>

          <div className="mt-8 pt-5 border-t border-slate-100 space-y-2.5 text-xs text-slate-600">
            <div className="font-semibold text-slate-900">มาตรฐานความปลอดภัยที่ทำงานอยู่</div>
            <div className="flex items-start gap-2">
              <Lock className="w-3.5 h-3.5 text-teal-700 shrink-0 mt-0.5" />
              <span>เข้ารหัสหมายเลขบัตรแบบ AES-256-GCM Token Vault หรือส่งตรงเข้า Stripe PCI-DSS</span>
            </div>
            <div className="flex items-start gap-2">
              <ShieldCheck className="w-3.5 h-3.5 text-teal-700 shrink-0 mt-0.5" />
              <span>รองรับ 3D Secure 2.0 OTP Challenge และป้องกันการตัดซ้ำด้วย Idempotency Key</span>
            </div>
            <div className="flex items-start gap-2">
              <KeyRound className="w-3.5 h-3.5 text-teal-700 shrink-0 mt-0.5" />
              <span>ลงนาม Webhook และ Bank Callback ด้วย HMAC-SHA256 + Replay Window</span>
            </div>
          </div>
        </div>

        {/* Right Column: Interactive Payment Methods */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-6">
          {completedTx ? (
            /* Receipt View */
            <div className="py-4 space-y-6">
              <div className="flex items-start gap-3 pb-5 border-b border-slate-100">
                <CheckCircle2 className="w-7 h-7 text-emerald-600 shrink-0" />
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">ชำระเงินสำเร็จเรียบร้อย</h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    ระบบบันทึกธุรกรรมและส่ง Webhook event <span className="font-mono">charge.succeeded</span> พร้อมลายเซ็น HMAC-SHA256 แล้ว
                  </p>
                </div>
              </div>

              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md">
                  <dt className="text-slate-500">Transaction ID</dt>
                  <dd className="font-mono font-semibold text-slate-900 mt-1">{completedTx.id}</dd>
                </div>
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md">
                  <dt className="text-slate-500">ยอดชำระ / ยอดสุทธิ</dt>
                  <dd className="font-mono font-semibold text-slate-900 mt-1 tabular-nums">
                    {formatThb(completedTx.amount)} (สุทธิ {formatThb(completedTx.netThb)})
                  </dd>
                </div>
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md">
                  <dt className="text-slate-500">ช่องทางและการยืนยัน</dt>
                  <dd className="font-medium text-slate-900 mt-1">
                    {completedTx.method === 'credit_card'
                      ? `${brandDisplayName(completedTx.brand)} (${completedTx.maskedPan ?? 'Card'}) · ECI ${completedTx.eci ?? '05'}`
                      : `Thai QR PromptPay · Ref ${completedTx.qrReference ?? 'PromptPay'}`}
                  </dd>
                </div>
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md">
                  <dt className="text-slate-500">ผู้ประมวลผล (Processor)</dt>
                  <dd className="font-mono text-slate-900 mt-1">
                    {completedTx.processor === 'stripe_thailand' ? 'Stripe Thailand' : 'SiamVault Sandbox'}
                  </dd>
                </div>
              </dl>

              {bankCallbackHeader && (
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md text-xs">
                  <div className="font-medium text-slate-700">Bank Callback HMAC-SHA256 Verified</div>
                  <div className="font-mono text-[11px] text-slate-500 mt-1 break-all">{bankCallbackHeader}</div>
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleQuickNewIntent}
                  className="px-4 py-2 text-xs font-medium bg-teal-700 text-white rounded-md hover:bg-teal-800 whitespace-nowrap"
                >
                  ทดสอบรับชำระเงินรายการถัดไป
                </button>
                <button
                  type="button"
                  onClick={onGoToLedger}
                  className="px-4 py-2 text-xs font-medium border border-slate-200 text-slate-700 rounded-md hover:bg-slate-50 whitespace-nowrap"
                >
                  ดูรายการใน Transaction Ledger
                </button>
              </div>
            </div>
          ) : threeDsSession ? (
            /* 3D Secure 2.0 OTP Challenge Screen (Sandbox) */
            <div className="space-y-5">
              <div className="pb-4 border-b border-slate-100 flex items-center justify-between">
                <div>
                  <div className="text-xs font-medium text-amber-700">Strong Customer Authentication (3D Secure 2.0)</div>
                  <h3 className="text-base font-semibold text-slate-900 mt-0.5">ยืนยันตัวตนผู้ถือบัตรด้วยรหัส OTP</h3>
                </div>
                <ShieldCheck className="w-6 h-6 text-slate-700" />
              </div>

              <div className="p-4 bg-slate-50 border border-slate-200 rounded-md text-xs space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-slate-500">ร้านค้า</span>
                  <span className="font-medium text-slate-900">{dashboard.merchant.merchantName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">ยอดเงินที่รอการยืนยัน</span>
                  <span className="font-mono font-semibold text-slate-900 tabular-nums">
                    {intent ? formatThb(intent.amount) : '-'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">รหัสธุรกรรม</span>
                  <span className="font-mono text-slate-700">{threeDsSession.transactionId}</span>
                </div>
              </div>

              <div className="p-3.5 bg-teal-50 border border-teal-200 rounded-md text-xs text-teal-900 flex items-center justify-between gap-3">
                <div>
                  <span className="font-semibold">รหัส OTP จำลองจากธนาคารผู้ออกบัตร:</span>{' '}
                  <span className="font-mono font-bold text-sm tracking-wider">{threeDsSession.sandboxOtpHint}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setOtpInput(threeDsSession.sandboxOtpHint)}
                  className="px-2.5 py-1 text-xs font-medium bg-white border border-teal-300 text-teal-800 rounded hover:bg-teal-100 whitespace-nowrap shrink-0"
                >
                  กรอกรหัสอัตโนมัติ
                </button>
              </div>

              {errorMsg && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-700 flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{errorMsg}</span>
                </div>
              )}

              <form onSubmit={handleVerifyOtp} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">กรอกรหัส OTP 6 หลัก</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={6}
                    required
                    value={otpInput}
                    onChange={(e) => setOtpInput(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="••••••"
                    className="w-full px-4 py-2.5 text-center text-lg font-mono tracking-[0.4em] bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-teal-600 focus:bg-white"
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setThreeDsSession(null);
                      setErrorMsg(null);
                    }}
                    className="px-4 py-2 text-xs font-medium border border-slate-200 text-slate-700 rounded-md hover:bg-slate-50"
                  >
                    ยกเลิก
                  </button>
                  <button
                    type="submit"
                    disabled={verifyingOtp || otpInput.length !== 6}
                    className="px-5 py-2.5 text-xs font-semibold bg-teal-700 text-white rounded-md hover:bg-teal-800 disabled:opacity-50"
                  >
                    {verifyingOtp ? 'กำลังตรวจสอบ OTP...' : 'ยืนยันรหัส OTP และชำระเงิน'}
                  </button>
                </div>
              </form>
            </div>
          ) : (
            <div className="space-y-5">
              {/* Processor Mode Switcher: Stripe Thailand vs SiamVault Sandbox */}
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-4 border-b border-slate-100">
                <span className="text-xs font-semibold text-slate-700">ช่องทางประมวลผล (Processor)</span>
                <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
                  <button
                    type="button"
                    onClick={() => {
                      setProcessor('stripe_thailand');
                      setErrorMsg(null);
                    }}
                    className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                      processor === 'stripe_thailand'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Stripe Thailand {stripeConfig.configured ? `(${stripeConfig.mode})` : ''}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setProcessor('siamvault_sandbox');
                      setErrorMsg(null);
                    }}
                    className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap ${
                      processor === 'siamvault_sandbox'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    SiamVault Sandbox
                  </button>
                </div>
              </div>

              {errorMsg && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-700 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{errorMsg}</span>
                </div>
              )}

              {processor === 'stripe_thailand' ? (
                intent ? (
                  <StripeCheckoutPanel
                    intent={intent}
                    stripeConfig={stripeConfig}
                    onSuccess={handleStripeSuccess}
                    onError={setErrorMsg}
                  />
                ) : (
                  <div className="py-8 text-center text-xs text-slate-500">กำลังเตรียมรายการชำระเงิน...</div>
                )
              ) : (
                /* SiamVault Sandbox Mode */
                <div className="space-y-5">
                  <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg">
                    <button
                      type="button"
                      onClick={() => {
                        setMethod('credit_card');
                        setErrorMsg(null);
                      }}
                      className={`py-2 px-3 text-xs font-semibold rounded-md inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap ${
                        method === 'credit_card'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <CreditCard className="w-4 h-4" />
                      บัตรเครดิต / เดบิต
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setMethod('promptpay_qr');
                        setErrorMsg(null);
                      }}
                      className={`py-2 px-3 text-xs font-semibold rounded-md inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap ${
                        method === 'promptpay_qr'
                          ? 'bg-white text-slate-900 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      <QrCode className="w-4 h-4" />
                      Thai QR PromptPay
                    </button>
                  </div>

                  {method === 'credit_card' ? (
                    <div className="space-y-5">
                      <div>
                        <div className="text-[11px] font-medium text-slate-500 mb-2">เลือกบัตรทดสอบตามสถานการณ์ความปลอดภัย:</div>
                        <div className="flex flex-wrap gap-1.5">
                          {TEST_CARDS.map((card) => (
                            <button
                              key={card.pan}
                              type="button"
                              onClick={() => {
                                setPan(card.pan);
                                setHolderName(card.holder);
                                setExpMonth(card.expMonth);
                                setExpYear(card.expYear);
                                setCvv(card.cvv);
                                setErrorMsg(null);
                              }}
                              className={`px-2.5 py-1 text-[11px] font-medium rounded border transition-colors ${
                                pan === card.pan
                                  ? 'bg-slate-900 text-white border-slate-900'
                                  : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                              }`}
                            >
                              {card.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="bg-slate-900 text-slate-100 rounded-lg p-5 flex flex-col justify-between min-h-[156px]">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-mono text-slate-400">SIAMVAULT TOKENIZED</span>
                          <span className="font-semibold tracking-wide uppercase">{brandDisplayName(cardBrand)}</span>
                        </div>
                        <div className="my-4 font-mono text-lg sm:text-xl tracking-widest tabular-nums">
                          {pan || '•••• •••• •••• ••••'}
                        </div>
                        <div className="flex items-end justify-between text-xs">
                          <div>
                            <div className="text-[10px] text-slate-400">CARDHOLDER</div>
                            <div className="font-mono tracking-wide uppercase mt-0.5">{holderName || 'NAME ON CARD'}</div>
                          </div>
                          <div className="text-right">
                            <div className="text-[10px] text-slate-400">EXPIRES</div>
                            <div className="font-mono tabular-nums mt-0.5">
                              {expMonth || 'MM'}/{expYear || 'YY'}
                            </div>
                          </div>
                        </div>
                      </div>

                      <form onSubmit={handleCardSubmit} className="space-y-4">
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <label className="text-xs font-medium text-slate-700">หมายเลขบัตรเครดิต / เดบิต</label>
                            <span
                              className={`text-[11px] font-medium ${
                                pan.replace(/\D/g, '').length >= 13
                                  ? luhnValid
                                    ? 'text-emerald-700'
                                    : 'text-red-600'
                                  : 'text-slate-400'
                              }`}
                            >
                              {pan.replace(/\D/g, '').length >= 13
                                ? luhnValid
                                  ? `ผ่าน Luhn Mod-10 (${brandDisplayName(cardBrand)})`
                                  : 'หมายเลขบัตรไม่ผ่าน Luhn'
                                : '13–16 หลัก'}
                            </span>
                          </div>
                          <input
                            type="text"
                            inputMode="numeric"
                            required
                            value={pan}
                            onChange={(e) => setPan(formatCardNumberSpacing(e.target.value))}
                            placeholder="4242 4242 4242 4242"
                            className="w-full px-3.5 py-2 text-sm font-mono bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-teal-600 focus:bg-white"
                          />
                        </div>

                        <div>
                          <label className="block text-xs font-medium text-slate-700 mb-1">ชื่อผู้ถือบัตร (ตามหน้าบัตร)</label>
                          <input
                            type="text"
                            required
                            value={holderName}
                            onChange={(e) => setHolderName(e.target.value.toUpperCase())}
                            placeholder="SOMCHAI PRASERT"
                            className="w-full px-3.5 py-2 text-xs font-mono uppercase bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-teal-600 focus:bg-white"
                          />
                        </div>

                        <div className="grid grid-cols-3 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-slate-700 mb-1">เดือน (MM)</label>
                            <input
                              type="text"
                              inputMode="numeric"
                              maxLength={2}
                              required
                              value={expMonth}
                              onChange={(e) => setExpMonth(e.target.value.replace(/\D/g, '').slice(0, 2))}
                              placeholder="08"
                              className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-teal-600 focus:bg-white"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-700 mb-1">ปี (YY)</label>
                            <input
                              type="text"
                              inputMode="numeric"
                              maxLength={2}
                              required
                              value={expYear}
                              onChange={(e) => setExpYear(e.target.value.replace(/\D/g, '').slice(0, 2))}
                              placeholder="28"
                              className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-teal-600 focus:bg-white"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-slate-700 mb-1">CVV / CVC</label>
                            <input
                              type="password"
                              inputMode="numeric"
                              maxLength={4}
                              required
                              value={cvv}
                              onChange={(e) => setCvv(e.target.value.replace(/\D/g, '').slice(0, 4))}
                              placeholder="•••"
                              className="w-full px-3 py-2 text-xs font-mono bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-teal-600 focus:bg-white"
                            />
                          </div>
                        </div>

                        <button
                          type="submit"
                          disabled={submitting || !intent}
                          className="w-full py-2.5 px-4 text-sm font-semibold bg-teal-700 text-white rounded-md hover:bg-teal-800 transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-2"
                        >
                          <Lock className="w-4 h-4" />
                          {submitting
                            ? 'กำลังเข้ารหัส AES-256-GCM และตรวจสอบความเสี่ยง...'
                            : `ชำระเงินอย่างปลอดภัย ${intent ? formatThb(intent.amount) : ''}`}
                        </button>
                      </form>
                    </div>
                  ) : (
                    <div className="space-y-5">
                      <div className="flex flex-col items-center text-center py-2">
                        <div className="text-xs font-semibold text-slate-700">สแกน Thai QR Payment (PromptPay)</div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          รองรับทุกแอปธนาคารในประเทศไทย · หมดอายุภายใน{' '}
                          <span className="font-mono font-semibold text-slate-800 tabular-nums">
                            {mm}:{ss}
                          </span>
                        </div>

                        <div className="mt-4 p-4 bg-white border border-slate-200 rounded-lg inline-block">
                          {qrDataUrl ? (
                            <img
                              src={qrDataUrl}
                              alt="PromptPay EMVCo QR Code"
                              referrerPolicy="no-referrer"
                              className="w-52 h-52 object-contain"
                            />
                          ) : (
                            <div className="w-52 h-52 bg-slate-100 flex items-center justify-center text-xs text-slate-400">
                              กำลังสร้าง QR...
                            </div>
                          )}
                        </div>

                        <div className="mt-3 text-base font-semibold font-mono text-slate-900 tabular-nums">
                          {intent ? formatThb(intent.amount) : ''}
                        </div>
                        <div className="text-xs text-slate-500 font-mono mt-0.5">
                          Ref: {intent?.qrReference} · PromptPay ID: {dashboard.merchant.promptPayId}
                        </div>
                      </div>

                      <button
                        type="button"
                        disabled={submitting || !intent}
                        onClick={handleSimulateBankQrCallback}
                        className="w-full py-2.5 px-4 text-xs font-semibold bg-teal-700 text-white rounded-md hover:bg-teal-800 transition-colors disabled:opacity-50"
                      >
                        {submitting
                          ? 'กำลังตรวจสอบลายเซ็น Bank HMAC-SHA256...'
                          : 'จำลองการสแกนจ่ายจากแอปธนาคาร (Verify & Settle QR)'}
                      </button>

                      <div className="border border-slate-200 rounded-md overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setShowTlvInspector((v) => !v)}
                          className="w-full px-4 py-2.5 bg-slate-50 text-xs font-medium text-slate-700 flex items-center justify-between hover:bg-slate-100"
                        >
                          <span>ตรวจสอบโครงสร้าง EMVCo Tag-Length-Value (TLV) &amp; CRC-16</span>
                          {showTlvInspector ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                        {showTlvInspector && intent && (
                          <div className="p-4 space-y-3 bg-white border-t border-slate-200 text-xs">
                            <div>
                              <div className="text-[11px] text-slate-500 mb-1">Raw EMVCo String</div>
                              <div className="p-2.5 bg-slate-50 border border-slate-200 rounded font-mono text-[11px] text-slate-700 break-all">
                                {intent.qrPayload}
                              </div>
                            </div>
                            <div className="divide-y divide-slate-100 border border-slate-200 rounded">
                              {tlvItems.map((item) => (
                                <div key={item.tag} className="px-3 py-2 flex items-center justify-between gap-3">
                                  <div>
                                    <span className="font-mono font-semibold text-teal-800">Tag {item.tag}</span>
                                    <span className="text-slate-600 ml-2">{item.name}</span>
                                  </div>
                                  <div className="font-mono text-[11px] text-slate-800 truncate max-w-[200px]">
                                    ({item.length}) {item.value}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
