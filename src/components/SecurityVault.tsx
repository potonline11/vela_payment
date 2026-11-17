import { useState } from 'react';
import { Check, Copy, KeyRound, Lock, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import type { DashboardPayload, SecurityPolicy } from '../types/gateway';
import { brandDisplayName, formatDateTimeTh } from '../lib/formatters';

interface SecurityVaultProps {
  dashboard: DashboardPayload;
  onDashboardUpdate: (next: DashboardPayload) => void;
}

export function SecurityVault({ dashboard, onDashboardUpdate }: SecurityVaultProps) {
  const [merchantName, setMerchantName] = useState(dashboard.merchant.merchantName);
  const [promptPayId, setPromptPayId] = useState(dashboard.merchant.promptPayId);
  const [webhookUrl, setWebhookUrl] = useState(dashboard.merchant.webhookUrl);
  const [savingMerchant, setSavingMerchant] = useState(false);
  const [merchantMsg, setMerchantMsg] = useState<string | null>(null);

  const [policy, setPolicy] = useState<SecurityPolicy>(dashboard.policy);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [policyMsg, setPolicyMsg] = useState<string | null>(null);

  const [rotatingKeys, setRotatingKeys] = useState(false);
  const [revealedKeys, setRevealedKeys] = useState<{ secretKey: string; webhookSecret: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  function copyText(id: string, text: string) {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 2000);
  }

  async function handleSaveMerchant(e: React.FormEvent) {
    e.preventDefault();
    setSavingMerchant(true);
    setMerchantMsg(null);
    try {
      const res = await fetch('/api/v1/merchant/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ merchantName, promptPayId, webhookUrl }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMerchantMsg(json.error ?? 'ไม่สามารถบันทึกข้อมูลร้านค้าได้');
        return;
      }
      onDashboardUpdate(json.dashboard);
      setMerchantMsg('บันทึกข้อมูลร้านค้าและรหัส PromptPay เรียบร้อยแล้ว');
    } finally {
      setSavingMerchant(false);
    }
  }

  async function handleSavePolicy(e: React.FormEvent) {
    e.preventDefault();
    setSavingPolicy(true);
    setPolicyMsg(null);
    try {
      const res = await fetch('/api/v1/security/policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(policy),
      });
      const json = await res.json();
      if (res.ok && json.dashboard) {
        onDashboardUpdate(json.dashboard);
        setPolicy(json.policy);
        setPolicyMsg('อัปเดตนโยบายความปลอดภัยและกฎป้องกันการทุจริตสำเร็จ');
      }
    } finally {
      setSavingPolicy(false);
    }
  }

  async function handleRotateKeys() {
    setRotatingKeys(true);
    try {
      const res = await fetch('/api/v1/keys/rotate', { method: 'POST' });
      const json = await res.json();
      if (res.ok) {
        setRevealedKeys({
          secretKey: json.revealedSecretKeyOnce,
          webhookSecret: json.revealedWebhookSecretOnce,
        });
        onDashboardUpdate(json.dashboard);
      }
    } finally {
      setRotatingKeys(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Row 1: API Credentials & Merchant PromptPay Config */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
        {/* API Keys & Rotation */}
        <div className="bg-white border border-slate-200 rounded-lg p-6 flex flex-col justify-between space-y-5">
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-base font-semibold text-slate-900">คีย์ API และการเข้ารหัสคีย์ลับ</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Secret Key ถูกจัดเก็บแบบ SHA-256 Hash บนเซิร์ฟเวอร์ และแสดงค่าเต็มเพียงครั้งเดียวเมื่อหมุนเวียนคีย์
                </p>
              </div>
              <KeyRound className="w-5 h-5 text-slate-400 shrink-0" />
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <div className="text-slate-500 mb-1">Publishable Key (ใช้งานฝั่ง Checkout Client)</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-md font-mono text-slate-800 truncate">
                    {dashboard.merchant.publishableKey}
                  </code>
                  <button
                    type="button"
                    onClick={() => copyText('pk', dashboard.merchant.publishableKey)}
                    className="px-2.5 py-2 border border-slate-200 rounded-md text-slate-600 hover:bg-slate-50"
                    title="คัดลอก Publishable Key"
                  >
                    {copiedId === 'pk' ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <div className="text-slate-500 mb-1">Secret Key (SHA-256 Hashed at Rest)</div>
                <code className="block px-3 py-2 bg-slate-50 border border-slate-200 rounded-md font-mono text-slate-600">
                  {dashboard.merchant.secretKeyMasked}
                </code>
              </div>

              <div>
                <div className="text-slate-500 mb-1">Webhook Signing Secret (HMAC-SHA256)</div>
                <code className="block px-3 py-2 bg-slate-50 border border-slate-200 rounded-md font-mono text-slate-600">
                  {dashboard.merchant.webhookSecretMasked}
                </code>
              </div>
            </div>

            {revealedKeys && (
              <div className="p-4 bg-amber-50 border border-amber-200 rounded-md space-y-2.5 text-xs">
                <div className="font-semibold text-amber-900">
                  บันทึกคีย์ใหม่ของคุณทันที (ระบบจะไม่แสดงคีย์นี้อีกครั้งหลังปิดหน้าต่าง)
                </div>
                <div>
                  <div className="text-amber-800 mb-1">New Secret Key:</div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-2.5 py-1.5 bg-white border border-amber-200 rounded font-mono text-slate-900 break-all">
                      {revealedKeys.secretKey}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyText('new_sk', revealedKeys.secretKey)}
                      className="px-2.5 py-1.5 bg-white border border-amber-300 rounded text-amber-900 hover:bg-amber-100"
                    >
                      {copiedId === 'new_sk' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
                <div>
                  <div className="text-amber-800 mb-1">New Webhook Signing Secret:</div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-2.5 py-1.5 bg-white border border-amber-200 rounded font-mono text-slate-900 break-all">
                      {revealedKeys.webhookSecret}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyText('new_wh', revealedKeys.webhookSecret)}
                      className="px-2.5 py-1.5 bg-white border border-amber-300 rounded text-amber-900 hover:bg-amber-100"
                    >
                      {copiedId === 'new_wh' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="pt-4 border-t border-slate-100 flex items-center justify-between gap-4">
            <span className="text-xs text-slate-500 tabular-nums">
              หมุนเวียนล่าสุด: {formatDateTimeTh(dashboard.merchant.keyRotatedAt)}
            </span>
            <button
              type="button"
              disabled={rotatingKeys}
              onClick={handleRotateKeys}
              className="px-3.5 py-2 text-xs font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${rotatingKeys ? 'animate-spin' : ''}`} />
              หมุนเวียนคีย์ API (Rotate)
            </button>
          </div>
        </div>

        {/* Merchant Profile & PromptPay Receiver */}
        <form onSubmit={handleSaveMerchant} className="bg-white border border-slate-200 rounded-lg p-6 flex flex-col justify-between space-y-5">
          <div className="space-y-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">ตั้งค่าร้านค้าและบัญชีรับ PromptPay QR</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                รหัส PromptPay นี้จะถูกเข้ารหัสลงใน EMVCo Tag 29 เพื่อสร้าง QR Code รับเงินจริง
              </p>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">ชื่อร้านค้า (Merchant Name)</label>
                <input
                  type="text"
                  required
                  value={merchantName}
                  onChange={(e) => setMerchantName(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-teal-600 focus:bg-white"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  PromptPay ID (เบอร์มือถือ 10 หลัก หรือ เลขนิติบุคคล/บัตรประชาชน 13 หลัก)
                </label>
                <input
                  type="text"
                  required
                  value={promptPayId}
                  onChange={(e) => setPromptPayId(e.target.value.replace(/\D/g, '').slice(0, 15))}
                  className="w-full px-3 py-2 font-mono bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-teal-600 focus:bg-white"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Webhook Endpoint URL</label>
                <input
                  type="url"
                  required
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  className="w-full px-3 py-2 font-mono bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-teal-600 focus:bg-white"
                />
              </div>
            </div>

            {merchantMsg && (
              <div className="p-2.5 bg-teal-50 border border-teal-200 rounded text-xs text-teal-900">{merchantMsg}</div>
            )}
          </div>

          <div className="pt-4 border-t border-slate-100 flex justify-end">
            <button
              type="submit"
              disabled={savingMerchant}
              className="px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-md hover:bg-teal-800 inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <Save className="w-3.5 h-3.5" />
              {savingMerchant ? 'กำลังบันทึก...' : 'บันทึกการตั้งค่าร้านค้า'}
            </button>
          </div>
        </form>
      </div>

      {/* Fraud & Security Engine Rules */}
      <form onSubmit={handleSavePolicy} className="bg-white border border-slate-200 rounded-lg p-6 space-y-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">นโยบายป้องกันการทุจริตและ 3D Secure 2.0 (Risk Engine)</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              กฎทั้งหมดทำงานจริงบนฝั่งเซิร์ฟเวอร์ก่อนอนุมัติรายการบัตรเครดิตและตรวจสอบ Callback
            </p>
          </div>
          <ShieldCheck className="w-5 h-5 text-teal-700 shrink-0" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
          <div>
            <label className="block font-medium text-slate-700 mb-1">วงเงินสูงสุดต่อรายการ (THB)</label>
            <input
              type="number"
              min={100}
              value={policy.maxAmountThb}
              onChange={(e) => setPolicy({ ...policy, maxAmountThb: Number(e.target.value) })}
              className="w-full px-3 py-2 font-mono bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-teal-600 focus:bg-white"
            />
          </div>
          <div>
            <label className="block font-medium text-slate-700 mb-1">บังคับ 3DS2 OTP เมื่อยอดเงิน ≥ (THB)</label>
            <input
              type="number"
              min={0}
              value={policy.threeDsThresholdThb}
              onChange={(e) => setPolicy({ ...policy, threeDsThresholdThb: Number(e.target.value) })}
              className="w-full px-3 py-2 font-mono bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-teal-600 focus:bg-white"
            />
          </div>
          <div>
            <label className="block font-medium text-slate-700 mb-1">จำกัดรายการผิดพลาด (ครั้ง/นาที)</label>
            <input
              type="number"
              min={1}
              max={30}
              value={policy.maxAttemptsPerMinute}
              onChange={(e) => setPolicy({ ...policy, maxAttemptsPerMinute: Number(e.target.value) })}
              className="w-full px-3 py-2 font-mono bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-teal-600 focus:bg-white"
            />
          </div>
          <div>
            <label className="block font-medium text-slate-700 mb-1">Replay Protection Window (วินาที)</label>
            <input
              type="number"
              min={30}
              max={3600}
              value={policy.replayWindowSeconds}
              onChange={(e) => setPolicy({ ...policy, replayWindowSeconds: Number(e.target.value) })}
              className="w-full px-3 py-2 font-mono bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-teal-600 focus:bg-white"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-6 pt-2 text-xs">
          <label className="inline-flex items-center gap-2 cursor-pointer text-slate-800">
            <input
              type="checkbox"
              checked={policy.strictLuhnCvv}
              onChange={(e) => setPolicy({ ...policy, strictLuhnCvv: e.target.checked })}
              className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
            />
            <span>บังคับตรวจ Luhn Mod-10 และ CVV อย่างเข้มงวด</span>
          </label>
          <label className="inline-flex items-center gap-2 cursor-pointer text-slate-800">
            <input
              type="checkbox"
              checked={policy.blockHighRiskBins}
              onChange={(e) => setPolicy({ ...policy, blockHighRiskBins: e.target.checked })}
              className="rounded border-slate-300 text-teal-700 focus:ring-teal-600"
            />
            <span>บล็อก BIN ความเสี่ยงสูงอัตโนมัติ (เช่น 400000... / ...9999)</span>
          </label>
        </div>

        <div className="pt-4 border-t border-slate-100 flex items-center justify-between gap-4">
          <div className="text-xs text-teal-800">{policyMsg ?? ''}</div>
          <button
            type="submit"
            disabled={savingPolicy}
            className="px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-md hover:bg-teal-800 inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            <Save className="w-3.5 h-3.5" />
            {savingPolicy ? 'กำลังบันทึก...' : 'อัปเดตกฎความปลอดภัย'}
          </button>
        </div>
      </form>

      {/* AES-256-GCM Card Token Vault Table */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="p-5 border-b border-slate-200 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">คลังเก็บโทเคนบัตรที่เข้ารหัส (AES-256-GCM Token Vault)</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              ข้อมูล PAN ถูกเข้ารหัสด้วย Symmetric Master Key 256-bit + Random 96-bit IV + 128-bit Authentication Tag
            </p>
          </div>
          <Lock className="w-5 h-5 text-slate-400 shrink-0" />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                <th className="py-2.5 px-5 whitespace-nowrap">Token ID</th>
                <th className="py-2.5 px-4 whitespace-nowrap">Masked PAN / ผู้ถือบัตร</th>
                <th className="py-2.5 px-4 whitespace-nowrap">Algorithm</th>
                <th className="py-2.5 px-4 whitespace-nowrap">96-bit IV (Hex)</th>
                <th className="py-2.5 px-4 whitespace-nowrap">Auth Tag / Ciphertext</th>
                <th className="py-2.5 px-5 whitespace-nowrap text-right">สร้างเมื่อ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs">
              {dashboard.vaultTokens.map((tok) => (
                <tr key={tok.id} className="hover:bg-slate-50/70">
                  <td className="py-3 px-5 font-mono font-medium text-teal-800 whitespace-nowrap">{tok.id}</td>
                  <td className="py-3 px-4 whitespace-nowrap">
                    <div className="font-mono text-slate-900">{tok.maskedPan}</div>
                    <div className="text-[11px] text-slate-500">
                      {brandDisplayName(tok.brand)} · {tok.holderName} · {tok.expMonth}/{tok.expYear}
                    </div>
                  </td>
                  <td className="py-3 px-4 font-mono text-slate-700 whitespace-nowrap uppercase">{tok.algorithm}</td>
                  <td className="py-3 px-4 font-mono text-[11px] text-slate-600 whitespace-nowrap">{tok.ivHex}</td>
                  <td className="py-3 px-4 font-mono text-[11px] text-slate-500">
                    <div>tag: {tok.authTagHex.slice(0, 16)}...</div>
                    <div>enc: {tok.ciphertextPreview}</div>
                  </td>
                  <td className="py-3 px-5 text-right text-slate-500 whitespace-nowrap tabular-nums">
                    {formatDateTimeTh(tok.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
