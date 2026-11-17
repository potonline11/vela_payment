import { useState } from 'react';
import { Check, CheckCircle2, Copy, Send, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { DashboardPayload, WebhookDelivery } from '../types/gateway';
import { formatDateTimeTh } from '../lib/formatters';

interface WebhooksDevProps {
  dashboard: DashboardPayload;
  onDashboardUpdate: (next: DashboardPayload) => void;
}

export function WebhooksDev({ dashboard, onDashboardUpdate }: WebhooksDevProps) {
  const [sendingTest, setSendingTest] = useState(false);
  const [selectedWebhook, setSelectedWebhook] = useState<WebhookDelivery | null>(dashboard.webhooks[0] ?? null);

  // Interactive HMAC-SHA256 Verifier state
  const [verifyPayload, setVerifyPayload] = useState(dashboard.webhooks[0]?.payload ?? '');
  const [verifyHeader, setVerifyHeader] = useState(dashboard.webhooks[0]?.signatureHeader ?? '');
  const [verifySecret, setVerifySecret] = useState(dashboard.merchant.webhookSecretRawForVerifier);
  const [verifyResult, setVerifyResult] = useState<{ valid: boolean; reason: string } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null);

  function copyCode(id: string, content: string) {
    navigator.clipboard.writeText(content);
    setCopiedSnippet(id);
    setTimeout(() => setCopiedSnippet((prev) => (prev === id ? null : prev)), 2000);
  }

  async function handleSendTestWebhook() {
    setSendingTest(true);
    try {
      const res = await fetch('/api/v1/webhooks/test', { method: 'POST' });
      const json = await res.json();
      if (res.ok && json.dashboard) {
        onDashboardUpdate(json.dashboard);
        if (json.delivery) {
          setSelectedWebhook(json.delivery);
          setVerifyPayload(json.delivery.payload);
          setVerifyHeader(json.delivery.signatureHeader);
          setVerifySecret(json.dashboard.merchant.webhookSecretRawForVerifier);
          setVerifyResult(null);
        }
      }
    } finally {
      setSendingTest(false);
    }
  }

  async function handleVerifySignature(e: React.FormEvent) {
    e.preventDefault();
    setVerifying(true);
    try {
      const res = await fetch('/api/v1/webhooks/verify-signature', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payload: verifyPayload,
          signatureHeader: verifyHeader,
          secret: verifySecret,
        }),
      });
      const json = await res.json();
      setVerifyResult(json);
    } finally {
      setVerifying(false);
    }
  }

  const nodeVerifierCode = `import crypto from 'node:crypto';

export function verifySiamVaultWebhook(rawBody: string, sigHeader: string, secret: string) {
  const parts = Object.fromEntries(sigHeader.split(',').map((p) => p.split('=')));
  const timestamp = Number(parts.t);
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > ${dashboard.policy.replayWindowSeconds}) {
    throw new Error('Webhook timestamp outside replay protection window');
  }
  const expected = crypto.createHmac('sha256', secret).update(\`\${timestamp}.\${rawBody}\`).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(parts.v1, 'hex'));
}`;

  const curlCreateIntent = `curl -X POST ${window.location.origin}/api/v1/payment-intents \\
  -H "Content-Type: application/json" \\
  -d '{
    "amount": 1850,
    "orderId": "ORD-2026-9001",
    "description": "Cloud Package",
    "idempotencyKey": "idem_9001_abc"
  }'`;

  return (
    <div className="space-y-6">
      {/* Top Grid: Webhook Logs + HMAC Verifier */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left: Webhook Delivery Logs */}
        <div className="lg:col-span-6 bg-white border border-slate-200 rounded-lg overflow-hidden flex flex-col">
          <div className="p-5 border-b border-slate-200 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">ประวัติการส่ง Webhook (HMAC-SHA256)</h2>
              <p className="text-xs text-slate-500 mt-0.5 truncate max-w-[300px]">
                ปลายทาง: <span className="font-mono">{dashboard.merchant.webhookUrl}</span>
              </p>
            </div>
            <button
              type="button"
              disabled={sendingTest}
              onClick={handleSendTestWebhook}
              className="px-3.5 py-2 text-xs font-medium bg-teal-700 text-white rounded-md hover:bg-teal-800 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <Send className="w-3.5 h-3.5" />
              {sendingTest ? 'กำลังส่ง...' : 'ส่ง Test Webhook'}
            </button>
          </div>

          <div className="divide-y divide-slate-100 max-h-[420px] overflow-y-auto flex-1">
            {dashboard.webhooks.map((wh) => {
              const active = selectedWebhook?.id === wh.id;
              return (
                <button
                  key={wh.id}
                  type="button"
                  onClick={() => {
                    setSelectedWebhook(wh);
                    setVerifyPayload(wh.payload);
                    setVerifyHeader(wh.signatureHeader);
                    setVerifySecret(dashboard.merchant.webhookSecretRawForVerifier);
                    setVerifyResult(null);
                  }}
                  className={`w-full text-left px-5 py-3.5 transition-colors ${
                    active ? 'bg-slate-50' : 'hover:bg-slate-50/70'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-mono text-xs font-semibold text-slate-900">{wh.event}</span>
                    <span className="inline-flex items-center gap-1 text-xs font-mono text-emerald-700 tabular-nums">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      HTTP {wh.httpStatus}
                    </span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-slate-500">
                    <span className="font-mono">{wh.id}</span>
                    <span className="tabular-nums">{formatDateTimeTh(wh.deliveredAt)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Right: Real-Time HMAC-SHA256 Signature Verifier */}
        <form onSubmit={handleVerifySignature} className="lg:col-span-6 bg-white border border-slate-200 rounded-lg p-6 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-900">เครื่องมือตรวจสอบลายเซ็น HMAC-SHA256</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                ลองแก้ไขข้อความใน Payload แม้เพียง 1 ตัวอักษร เพื่อทดสอบระบบป้องกันการปลอมแปลง (Constant-Time Compare)
              </p>
            </div>
            <ShieldCheck className="w-5 h-5 text-teal-700 shrink-0" />
          </div>

          <div className="space-y-3 text-xs">
            <div>
              <label className="block font-medium text-slate-700 mb-1">X-SiamVault-Signature Header</label>
              <input
                type="text"
                required
                value={verifyHeader}
                onChange={(e) => setVerifyHeader(e.target.value)}
                className="w-full px-3 py-2 font-mono text-[11px] bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-teal-600 focus:bg-white"
              />
            </div>

            <div>
              <label className="block font-medium text-slate-700 mb-1">Webhook Signing Secret</label>
              <input
                type="text"
                required
                value={verifySecret}
                onChange={(e) => setVerifySecret(e.target.value)}
                className="w-full px-3 py-2 font-mono text-[11px] bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-teal-600 focus:bg-white"
              />
            </div>

            <div>
              <label className="block font-medium text-slate-700 mb-1">Raw JSON Payload</label>
              <textarea
                rows={4}
                required
                value={verifyPayload}
                onChange={(e) => setVerifyPayload(e.target.value)}
                className="w-full px-3 py-2 font-mono text-[11px] bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-teal-600 focus:bg-white"
              />
            </div>
          </div>

          {verifyResult && (
            <div
              className={`p-3 rounded-md border text-xs flex items-start gap-2 ${
                verifyResult.valid
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  : 'bg-red-50 border-red-200 text-red-800'
              }`}
            >
              {verifyResult.valid ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
              ) : (
                <ShieldAlert className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
              )}
              <span>{verifyResult.reason}</span>
            </div>
          )}

          <div className="pt-1 flex justify-end">
            <button
              type="submit"
              disabled={verifying}
              className="px-4 py-2 text-xs font-semibold bg-slate-900 text-white rounded-md hover:bg-slate-800 whitespace-nowrap"
            >
              {verifying ? 'กำลังตรวจสอบ...' : 'ตรวจสอบความถูกต้องของลายเซ็น'}
            </button>
          </div>
        </form>
      </div>

      {/* Developer Integration Snippets */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-900">1. ตัวอย่างการสร้าง Payment Intent ผ่าน REST API</h3>
            <button
              type="button"
              onClick={() => copyCode('curl', curlCreateIntent)}
              className="text-xs text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"
            >
              {copiedSnippet === 'curl' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              คัดลอก
            </button>
          </div>
          <pre className="p-4 bg-slate-950 text-slate-100 text-[11px] font-mono overflow-x-auto leading-relaxed">
            <code>{curlCreateIntent}</code>
          </pre>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-900">2. ตัวอย่าง Node.js ยืนยันลายเซ็น Webhook ด้วย timingSafeEqual</h3>
            <button
              type="button"
              onClick={() => copyCode('node', nodeVerifierCode)}
              className="text-xs text-slate-600 hover:text-slate-900 inline-flex items-center gap-1"
            >
              {copiedSnippet === 'node' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              คัดลอก
            </button>
          </div>
          <pre className="p-4 bg-slate-950 text-slate-100 text-[11px] font-mono overflow-x-auto leading-relaxed">
            <code>{nodeVerifierCode}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}
