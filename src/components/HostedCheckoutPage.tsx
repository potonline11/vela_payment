import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  ExternalLink,
  Lock,
  QrCode,
  ShieldCheck,
} from 'lucide-react';
import type { HostedCheckoutSession, TransactionRecord } from '../types/gateway';
import { brandDisplayName, formatThb } from '../lib/formatters';
import { StripeCheckoutPanel } from './StripeCheckoutPanel';

interface HostedCheckoutPageProps {
  intentId: string;
}

function appendRedirectParams(baseUrl: string, params: Record<string, string>): string {
  try {
    const url = new URL(baseUrl);
    for (const [key, val] of Object.entries(params)) {
      url.searchParams.set(key, val);
    }
    return url.toString();
  } catch {
    return baseUrl;
  }
}

export function HostedCheckoutPage({ intentId }: HostedCheckoutPageProps) {
  const [session, setSession] = useState<HostedCheckoutSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [completedTx, setCompletedTx] = useState<TransactionRecord | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [sandboxSubmitting, setSandboxSubmitting] = useState(false);
  const [redirectCountdown, setRedirectCountdown] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    async function loadSession() {
      setLoading(true);
      setErrorMsg(null);
      try {
        const params = new URLSearchParams(window.location.search);
        const returnedPi = params.get('payment_intent');
        if (returnedPi) {
          const syncRes = await fetch('/api/v1/stripe/sync-intent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stripePaymentIntentId: returnedPi }),
          });
          if (syncRes.ok && active) {
            const syncJson = await syncRes.json();
            if (syncJson.status === 'succeeded' && syncJson.transaction) {
              setCompletedTx(syncJson.transaction);
            }
          }
        }

        const res = await fetch(`/api/v1/checkout-sessions/${encodeURIComponent(intentId)}`);
        const json = await res.json();
        if (!res.ok) {
          if (active) setErrorMsg(json.error ?? 'ไม่พบรายการชำระเงินที่ระบุ');
          return;
        }
        if (active) {
          const loaded = json as HostedCheckoutSession;
          setSession(loaded);
          if (loaded.transaction && loaded.transaction.status === 'succeeded') {
            setCompletedTx(loaded.transaction);
          }
        }
      } catch {
        if (active) setErrorMsg('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ชำระเงินได้');
      } finally {
        if (active) setLoading(false);
      }
    }
    loadSession();
    return () => {
      active = false;
    };
  }, [intentId]);

  useEffect(() => {
    if (!session || session.stripeConfig.configured || !session.intent.qrPayload) return;
    let cancelled = false;
    QRCode.toDataURL(session.intent.qrPayload, {
      width: 240,
      margin: 2,
      color: { dark: '#0F172A', light: '#FFFFFF' },
    }).then((url) => {
      if (!cancelled) setQrDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const successReturnUrl =
    completedTx && session?.intent.successUrl
      ? appendRedirectParams(session.intent.successUrl, {
          intentId: session.intent.id,
          orderId: session.intent.orderId,
          transactionId: completedTx.id,
          status: 'succeeded',
        })
      : null;

  useEffect(() => {
    if (!successReturnUrl) return;
    setRedirectCountdown(3);
    const timer = setInterval(() => {
      setRedirectCountdown((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          clearInterval(timer);
          window.location.href = successReturnUrl;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [successReturnUrl]);

  const handleStripeSuccess = useCallback((tx: TransactionRecord) => {
    setCompletedTx(tx);
    setErrorMsg(null);
  }, []);

  async function handleSandboxQrConfirm() {
    if (!session) return;
    setSandboxSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/v1/qr/simulate-bank-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intentId: session.intent.id }),
      });
      const json = await res.json();
      if (!res.ok) {
        setErrorMsg(json.error ?? 'ไม่สามารถยืนยันการชำระเงินได้');
        return;
      }
      setCompletedTx(json.transaction);
    } finally {
      setSandboxSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col">
      {/* Clean White-Label Checkout Header */}
      <header className="bg-white border-b border-slate-200 px-4 sm:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-md bg-slate-900 text-white flex items-center justify-center shrink-0">
            <Lock className="w-3.5 h-3.5" />
          </div>
          <span className="text-sm font-bold tracking-tight text-slate-900">
            {session?.merchantName ?? 'SiamVault Pay'}
          </span>
          <span className="text-xs text-slate-400 hidden sm:inline">· Encrypted Checkout</span>
        </div>

        {session?.intent.cancelUrl && !completedTx && (
          <a
            href={session.intent.cancelUrl}
            className="text-xs font-medium text-slate-600 hover:text-slate-900 inline-flex items-center gap-1.5"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            กลับไปยังร้านค้า
          </a>
        )}
      </header>

      <main className="flex-1 flex items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-4xl">
          {loading ? (
            <div className="bg-white border border-slate-200 rounded-lg p-10 text-center text-xs text-slate-500">
              กำลังโหลดข้อมูลคำสั่งซื้อและช่องทางชำระเงิน...
            </div>
          ) : !session ? (
            <div className="bg-white border border-slate-200 rounded-lg p-8 text-center space-y-3">
              <AlertCircle className="w-8 h-8 text-red-600 mx-auto" />
              <h1 className="text-base font-semibold text-slate-900">ไม่สามารถเปิดหน้าชำระเงินได้</h1>
              <p className="text-xs text-slate-600">{errorMsg ?? 'ไม่พบคำสั่งซื้อ หรือ Session หมดอายุแล้ว'}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
              {/* Left Column: Order Summary */}
              <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-6 flex flex-col justify-between">
                <div className="space-y-5">
                  <div>
                    <div className="text-xs font-medium text-slate-500">{session.merchantName}</div>
                    <div className="mt-2 text-3xl font-semibold text-slate-900 font-mono tabular-nums tracking-tight">
                      {formatThb(session.intent.amount)}
                    </div>
                    <p className="mt-2 text-sm text-slate-700">{session.intent.description}</p>
                  </div>

                  <dl className="pt-5 border-t border-slate-100 space-y-2.5 text-xs">
                    <div className="flex items-center justify-between gap-4">
                      <dt className="text-slate-500">เลขที่คำสั่งซื้อ</dt>
                      <dd className="font-mono font-semibold text-slate-900">{session.intent.orderId}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <dt className="text-slate-500">ผู้ชำระเงิน</dt>
                      <dd className="font-mono text-slate-700 truncate">{session.intent.customerEmail}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <dt className="text-slate-500">Checkout Reference</dt>
                      <dd className="font-mono text-slate-500">{session.intent.id}</dd>
                    </div>
                  </dl>
                </div>

                <div className="mt-8 pt-5 border-t border-slate-100 space-y-2 text-[11px] text-slate-500">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-teal-700 shrink-0" />
                    <span>ชำระเงินอย่างปลอดภัยผ่าน Stripe Thailand &amp; SiamVault Pay</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Lock className="w-4 h-4 text-teal-700 shrink-0" />
                    <span>รองรับบัตรเครดิต/เดบิต (3D Secure 2.0) และ Thai QR PromptPay</span>
                  </div>
                </div>
              </div>

              {/* Right Column: Payment Form / Success */}
              <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-6">
                {completedTx ? (
                  <div className="py-4 space-y-6">
                    <div className="flex items-start gap-3 pb-5 border-b border-slate-100">
                      <CheckCircle2 className="w-7 h-7 text-emerald-600 shrink-0" />
                      <div>
                        <h2 className="text-lg font-semibold text-slate-900">ชำระเงินสำเร็จเรียบร้อย</h2>
                        <p className="text-xs text-slate-500 mt-0.5">
                          ระบบได้บันทึกการชำระเงินสำหรับคำสั่งซื้อ{' '}
                          <span className="font-mono font-semibold text-slate-700">{session.intent.orderId}</span> แล้ว
                        </p>
                      </div>
                    </div>

                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                      <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md">
                        <dt className="text-slate-500">Transaction ID</dt>
                        <dd className="font-mono font-semibold text-slate-900 mt-1">{completedTx.id}</dd>
                      </div>
                      <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md">
                        <dt className="text-slate-500">ยอดที่ชำระ</dt>
                        <dd className="font-mono font-semibold text-slate-900 mt-1 tabular-nums">
                          {formatThb(completedTx.amount)}
                        </dd>
                      </div>
                      <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md sm:col-span-2">
                        <dt className="text-slate-500">ช่องทางการชำระ</dt>
                        <dd className="font-medium text-slate-900 mt-1">
                          {completedTx.method === 'credit_card'
                            ? `${brandDisplayName(completedTx.brand)} (${completedTx.maskedPan ?? 'Card'})`
                            : `Thai QR PromptPay (${completedTx.qrReference ?? 'PromptPay'})`}
                        </dd>
                      </div>
                    </dl>

                    {successReturnUrl && (
                      <div className="pt-2 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <span className="text-xs text-slate-500">
                          กำลังพากลับไปยังร้านค้าอัตโนมัติใน {redirectCountdown ?? 0} วินาที...
                        </span>
                        <a
                          href={successReturnUrl}
                          className="px-4 py-2.5 text-xs font-semibold bg-teal-700 text-white rounded-md hover:bg-teal-800 inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
                        >
                          กลับไปยังร้านค้าทันที
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-4">
                    {errorMsg && (
                      <div className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-700 flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>{errorMsg}</span>
                      </div>
                    )}

                    {session.stripeConfig.configured ? (
                      <StripeCheckoutPanel
                        intent={session.intent}
                        stripeConfig={session.stripeConfig}
                        onSuccess={handleStripeSuccess}
                        onError={setErrorMsg}
                      />
                    ) : (
                      <div className="space-y-4 text-center py-2">
                        <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700">
                          <QrCode className="w-4 h-4 text-teal-700" />
                          สแกน Thai QR Payment (PromptPay)
                        </div>
                        <div className="flex justify-center">
                          {qrDataUrl ? (
                            <img
                              src={qrDataUrl}
                              alt="PromptPay QR Code"
                              referrerPolicy="no-referrer"
                              className="w-52 h-52 border border-slate-200 rounded-lg p-3 bg-white object-contain"
                            />
                          ) : (
                            <div className="w-52 h-52 bg-slate-100 rounded-lg flex items-center justify-center text-xs text-slate-400">
                              กำลังสร้าง QR...
                            </div>
                          )}
                        </div>
                        <div className="text-xs font-mono text-slate-500">
                          PromptPay ID: {session.promptPayId} · Ref: {session.intent.qrReference}
                        </div>
                        <button
                          type="button"
                          disabled={sandboxSubmitting}
                          onClick={handleSandboxQrConfirm}
                          className="w-full py-2.5 px-4 text-xs font-semibold bg-teal-700 text-white rounded-md hover:bg-teal-800 disabled:opacity-50"
                        >
                          {sandboxSubmitting ? 'กำลังตรวจสอบ...' : 'จำลองการยืนยันยอดโอน PromptPay (Sandbox)'}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
