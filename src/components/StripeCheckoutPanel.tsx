import { useEffect, useMemo, useState } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe } from '@stripe/stripe-js';
import { Lock, RefreshCw, ShieldCheck } from 'lucide-react';
import type { DashboardPayload, PaymentIntent, StripeConfigResponse, TransactionRecord } from '../types/gateway';
import { formatThb } from '../lib/formatters';

interface StripeCheckoutPanelProps {
  intent: PaymentIntent;
  stripeConfig: StripeConfigResponse;
  onSuccess: (tx: TransactionRecord, dashboard: DashboardPayload) => void;
  onError: (message: string | null) => void;
}

interface InnerFormProps {
  intent: PaymentIntent;
  stripePaymentIntentId: string;
  mode: 'live' | 'test' | 'unconfigured';
  onSuccess: (tx: TransactionRecord, dashboard: DashboardPayload) => void;
  onError: (message: string | null) => void;
}

function StripePaymentForm({ intent, stripePaymentIntentId, mode, onSuccess, onError }: InnerFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [waitingSync, setWaitingSync] = useState(false);

  async function syncWithBackend(piId: string): Promise<boolean> {
    const res = await fetch('/api/v1/stripe/sync-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stripePaymentIntentId: piId }),
    });
    const json = await res.json();
    if (!res.ok) {
      onError(json.error ?? 'ไม่สามารถตรวจสอบสถานะกับ Stripe ได้');
      return false;
    }
    if (json.status === 'succeeded' && json.transaction && json.dashboard) {
      onSuccess(json.transaction, json.dashboard);
      return true;
    }
    if (json.lastError) {
      onError(json.lastError);
    }
    return false;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;

    setProcessing(true);
    onError(null);

    try {
      const result = await stripe.confirmPayment({
        elements,
        redirect: 'if_required',
        confirmParams: {
          return_url: window.location.href,
          payment_method_data: {
            billing_details: {
              email: intent.customerEmail,
            },
          },
        },
      });

      if (result.error) {
        onError(result.error.message ?? 'การชำระเงินผ่าน Stripe ไม่สำเร็จ');
        return;
      }

      if (result.paymentIntent) {
        const done = await syncWithBackend(result.paymentIntent.id);
        if (!done && result.paymentIntent.status !== 'succeeded') {
          setWaitingSync(true);
        }
      }
    } finally {
      setProcessing(false);
    }
  }

  async function handleManualCheck() {
    setWaitingSync(true);
    onError(null);
    try {
      const done = await syncWithBackend(stripePaymentIntentId);
      if (!done) {
        onError('ยังไม่พบยอดชำระสำเร็จจาก Stripe กรุณาสแกน QR หรือยืนยัน 3DS ให้เสร็จสิ้นแล้วลองอีกครั้ง');
      }
    } finally {
      setWaitingSync(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex items-center justify-between text-xs text-slate-500 pb-1">
        <span>รองรับบัตรเครดิต/เดบิต (3DS2) และ PromptPay QR จาก Stripe Thailand</span>
        <span className="font-mono font-medium text-slate-700 uppercase">
          {mode === 'live' ? 'Live Mode' : 'Test Mode'}
        </span>
      </div>

      <div className="p-3.5 border border-slate-200 rounded-md bg-white">
        <PaymentElement
          options={{
            layout: 'tabs',
          }}
        />
      </div>

      <div className="flex flex-col sm:flex-row gap-2.5">
        <button
          type="submit"
          disabled={!stripe || !elements || processing}
          className="flex-1 py-2.5 px-4 text-sm font-semibold bg-teal-700 text-white rounded-md hover:bg-teal-800 transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-2"
        >
          <Lock className="w-4 h-4" />
          {processing
            ? 'กำลังดำเนินการผ่าน Stripe...'
            : `ชำระเงิน ${formatThb(intent.amount)} ผ่าน Stripe`}
        </button>

        {waitingSync && (
          <button
            type="button"
            onClick={handleManualCheck}
            className="py-2.5 px-4 text-xs font-medium border border-slate-200 text-slate-700 rounded-md hover:bg-slate-50 inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            ตรวจสอบสถานะการโอน
          </button>
        )}
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
        <ShieldCheck className="w-3.5 h-3.5 text-teal-700 shrink-0" />
        <span>ข้อมูลบัตรถูกส่งตรงไปยังเซิร์ฟเวอร์ Stripe แบบ PCI-DSS โดยไม่ผ่านการจัดเก็บบนหน้าเว็บ</span>
      </div>
    </form>
  );
}

export function StripeCheckoutPanel({
  intent,
  stripeConfig,
  onSuccess,
  onError,
}: StripeCheckoutPanelProps) {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [stripePiId, setStripePiId] = useState<string | null>(null);
  const [loadingIntent, setLoadingIntent] = useState(false);

  const stripePromise = useMemo(() => {
    if (!stripeConfig.publishableKey) return null;
    return loadStripe(stripeConfig.publishableKey);
  }, [stripeConfig.publishableKey]);

  useEffect(() => {
    if (!stripeConfig.configured || !intent.id) return;
    let cancelled = false;

    async function createStripeIntent() {
      setLoadingIntent(true);
      setClientSecret(null);
      onError(null);
      try {
        const res = await fetch('/api/v1/stripe/create-payment-intent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ intentId: intent.id }),
        });
        const json = await res.json();
        if (!res.ok) {
          if (!cancelled) onError(json.error ?? 'ไม่สามารถเชื่อมต่อ Stripe PaymentIntent ได้');
          return;
        }
        if (!cancelled) {
          setClientSecret(json.clientSecret);
          setStripePiId(json.stripePaymentIntentId);
        }
      } catch {
        if (!cancelled) onError('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์ Stripe');
      } finally {
        if (!cancelled) setLoadingIntent(false);
      }
    }

    createStripeIntent();
    return () => {
      cancelled = true;
    };
  }, [intent.id, intent.amount, stripeConfig.configured, onError]);

  if (!stripeConfig.configured || !stripePromise) {
    return (
      <div className="p-5 bg-slate-50 border border-slate-200 rounded-md space-y-3 text-xs">
        <div className="font-semibold text-slate-900">ยังไม่ได้เชื่อมต่อ API Keys ของ Stripe Thailand</div>
        <p className="text-slate-600 leading-relaxed">
          กรุณาเพิ่มตัวแปรด้านล่างลงในเมนู <strong>Settings → Secrets</strong> ของ AI Studio (หรือ Environment Variables บน Vercel) จากนั้นกดรีเฟรชหน้าเว็บ:
        </p>
        <div className="space-y-1.5 font-mono text-[11px] bg-white border border-slate-200 rounded p-3 text-slate-800">
          <div>STRIPE_SECRET_KEY=sk_test_... หรือ sk_live_...</div>
          <div>VITE_STRIPE_PUBLISHABLE_KEY=pk_test_... หรือ pk_live_...</div>
          <div>STRIPE_WEBHOOK_SECRET=whsec_... (สำหรับ Webhook)</div>
        </div>
        <p className="text-slate-500">
          ระหว่างนี้คุณสามารถสลับไปใช้แท็บ <strong>SiamVault Sandbox</strong> ด้านบนเพื่อทดสอบระบบจำลองได้ทันทีครับ
        </p>
      </div>
    );
  }

  if (loadingIntent || !clientSecret || !stripePiId) {
    return (
      <div className="py-10 text-center space-y-2">
        <div className="text-xs text-slate-500">กำลังเชื่อมต่อ Stripe Thailand PaymentElement...</div>
      </div>
    );
  }

  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret,
        locale: 'th',
        appearance: {
          theme: 'stripe',
          variables: {
            colorPrimary: '#0f766e',
            colorText: '#0f172a',
            colorBackground: '#ffffff',
            borderRadius: '6px',
            fontFamily: '"Plus Jakarta Sans", "IBM Plex Sans Thai", sans-serif',
          },
        },
      }}
    >
      <StripePaymentForm
        intent={intent}
        stripePaymentIntentId={stripePiId}
        mode={stripeConfig.mode}
        onSuccess={onSuccess}
        onError={onError}
      />
    </Elements>
  );
}
