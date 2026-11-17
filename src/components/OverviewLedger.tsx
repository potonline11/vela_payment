import { useMemo, useState } from 'react';
import {
  CheckCircle2,
  Clock,
  CreditCard,
  QrCode,
  RotateCcw,
  Search,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { DashboardPayload, PaymentMethod, TransactionRecord, TransactionStatus } from '../types/gateway';
import { brandDisplayName, formatDateTimeTh, formatThb } from '../lib/formatters';

interface OverviewLedgerProps {
  data: DashboardPayload;
  onRefund: (txId: string) => Promise<void>;
  onOpenCheckout: () => void;
}

const STATUS_META: Record<
  TransactionStatus,
  { label: string; colorClass: string; Icon: typeof CheckCircle2 }
> = {
  succeeded: { label: 'ชำระสำเร็จ', colorClass: 'text-emerald-700', Icon: CheckCircle2 },
  requires_3ds: { label: 'รอ 3DS2 OTP', colorClass: 'text-amber-700', Icon: Clock },
  pending_qr: { label: 'รอสแกน QR', colorClass: 'text-amber-700', Icon: Clock },
  declined: { label: 'ถูกปฏิเสธ', colorClass: 'text-red-700', Icon: ShieldAlert },
  refunded: { label: 'คืนเงินแล้ว', colorClass: 'text-slate-600', Icon: RotateCcw },
};

export function OverviewLedger({ data, onRefund, onOpenCheckout }: OverviewLedgerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | TransactionStatus>('all');
  const [methodFilter, setMethodFilter] = useState<'all' | PaymentMethod>('all');
  const [selectedTx, setSelectedTx] = useState<TransactionRecord | null>(null);
  const [refundLoadingId, setRefundLoadingId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const filteredTransactions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return data.transactions.filter((tx) => {
      if (statusFilter !== 'all' && tx.status !== statusFilter) return false;
      if (methodFilter !== 'all' && tx.method !== methodFilter) return false;
      if (!q) return true;
      return (
        tx.id.toLowerCase().includes(q) ||
        tx.orderId.toLowerCase().includes(q) ||
        tx.description.toLowerCase().includes(q) ||
        tx.customerEmail.toLowerCase().includes(q) ||
        (tx.maskedPan ?? '').toLowerCase().includes(q)
      );
    });
  }, [data.transactions, searchQuery, statusFilter, methodFilter]);

  const totalChannelVol = data.kpis.cardVolumeThb + data.kpis.qrVolumeThb;
  const cardPct = totalChannelVol > 0 ? Math.round((data.kpis.cardVolumeThb / totalChannelVol) * 100) : 50;
  const qrPct = totalChannelVol > 0 ? 100 - cardPct : 50;

  async function handleRefundClick(tx: TransactionRecord) {
    setRefundLoadingId(tx.id);
    setActionMessage(null);
    try {
      await onRefund(tx.id);
      setActionMessage(`คืนเงินรายการ ${tx.id} สำเร็จ พร้อมส่ง Webhook charge.refunded แล้ว`);
      setSelectedTx((prev) => (prev && prev.id === tx.id ? { ...prev, status: 'refunded' } : prev));
    } finally {
      setRefundLoadingId(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* 4-Column Tabular KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="text-xs font-medium text-slate-500">ยอดรับชำระสำเร็จรวม</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900 tabular-nums tracking-tight">
            {formatThb(data.kpis.totalVolumeThb)}
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
            <span className="tabular-nums">{data.kpis.succeededCount} รายการสำเร็จ</span>
            <span aria-hidden="true">·</span>
            <span>สกุลเงิน THB</span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="text-xs font-medium text-slate-500">ยอดเงินสุทธิ (หลังหักค่าธรรมเนียม)</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900 tabular-nums tracking-tight">
            {formatThb(data.kpis.netSettlementThb)}
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
            <span>บัตร 2.75%</span>
            <span aria-hidden="true">·</span>
            <span>PromptPay QR 1.50%</span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="text-xs font-medium text-slate-500">อัตราการอนุมัติรายการ</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900 tabular-nums tracking-tight">
            {data.kpis.approvalRatePct.toFixed(1)}%
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
            <span>3DS2 &amp; EMVCo Verified</span>
            <span aria-hidden="true">·</span>
            <span className="tabular-nums">{data.kpis.totalCount} ทั้งหมด</span>
          </div>
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5">
          <div className="text-xs font-medium text-slate-500">รายการที่ถูกบล็อกความเสี่ยง</div>
          <div className="mt-2 text-2xl font-semibold text-slate-900 tabular-nums tracking-tight">
            {data.kpis.blockedCount}
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
            <span>Fraud &amp; Velocity Guard</span>
            <span aria-hidden="true">·</span>
            <span>Token Vault {data.vaultTokens.length} บัตร</span>
          </div>
        </div>
      </div>

      {/* Channel Volume Split & Quick Checkout Callout */}
      <div className="bg-white border border-slate-200 rounded-lg p-5">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-slate-900">สัดส่วนช่องทางการชำระเงินที่สำเร็จ</h2>
            <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600 tabular-nums">
              <span className="inline-flex items-center gap-1.5">
                <CreditCard className="w-3.5 h-3.5 text-slate-700" />
                บัตรเครดิต: <strong className="text-slate-900">{formatThb(data.kpis.cardVolumeThb)}</strong> ({cardPct}%)
              </span>
              <span aria-hidden="true" className="text-slate-300">|</span>
              <span className="inline-flex items-center gap-1.5">
                <QrCode className="w-3.5 h-3.5 text-teal-700" />
                PromptPay QR: <strong className="text-slate-900">{formatThb(data.kpis.qrVolumeThb)}</strong> ({qrPct}%)
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onOpenCheckout}
            className="px-4 py-2 text-xs font-medium bg-teal-700 text-white rounded-md hover:bg-teal-800 transition-colors whitespace-nowrap shrink-0 self-start md:self-auto"
          >
            ทดสอบรับชำระเงินใหม่
          </button>
        </div>
        <div className="mt-4 h-2 w-full bg-slate-100 rounded-sm overflow-hidden flex">
          <div
            className="bg-slate-800 h-full transition-all duration-300"
            style={{ width: `${cardPct}%` }}
            title={`บัตรเครดิต ${cardPct}%`}
          />
          <div
            className="bg-teal-600 h-full transition-all duration-300"
            style={{ width: `${qrPct}%` }}
            title={`PromptPay QR ${qrPct}%`}
          />
        </div>
      </div>

      {/* Transaction Ledger Table */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="p-5 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-900">สมุดบัญชีธุรกรรม (Transaction Ledger)</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              คลิกที่รายการเพื่อตรวจสอบผลสแกนความเสี่ยง, โทเคน AES-256-GCM, รหัส ECI 3DS2 หรือทำรายการคืนเงิน
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative min-w-[220px] flex-1 sm:flex-initial">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="ค้นหา tx_id, ออเดอร์, อีเมล..."
                className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-md focus:outline-none focus:border-teal-600 focus:bg-white transition-colors"
              />
            </div>

            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
              {(
                [
                  { id: 'all', label: 'ทุกช่องทาง' },
                  { id: 'credit_card', label: 'บัตรเครดิต' },
                  { id: 'promptpay_qr', label: 'QR Code' },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setMethodFilter(item.id)}
                  className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                    methodFilter === item.id
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <select
              aria-label="กรองตามสถานะ"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'all' | TransactionStatus)}
              className="px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-md text-slate-700 focus:outline-none focus:border-teal-600"
            >
              <option value="all">ทุกสถานะ</option>
              <option value="succeeded">ชำระสำเร็จ</option>
              <option value="requires_3ds">รอ 3DS2 OTP</option>
              <option value="declined">ถูกปฏิเสธ</option>
              <option value="refunded">คืนเงินแล้ว</option>
            </select>
          </div>
        </div>

        {actionMessage && (
          <div className="px-5 py-2.5 bg-teal-50 border-b border-teal-200 text-xs text-teal-900 flex items-center justify-between">
            <span>{actionMessage}</span>
            <button type="button" onClick={() => setActionMessage(null)} className="text-teal-700 hover:text-teal-900">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {filteredTransactions.length === 0 ? (
          <div className="py-12 px-6 text-center">
            <p className="text-sm font-medium text-slate-700">ไม่พบรายการธุรกรรมที่ตรงกับเงื่อนไข</p>
            <p className="text-xs text-slate-500 mt-1">ลองล้างคำค้นหาหรือสร้างรายการชำระเงินใหม่ในหน้า Checkout</p>
            <div className="mt-4 flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setStatusFilter('all');
                  setMethodFilter('all');
                }}
                className="px-3.5 py-2 text-xs font-medium border border-slate-200 rounded-md text-slate-700 hover:bg-slate-50 whitespace-nowrap"
              >
                ล้างตัวกรอง
              </button>
              <button
                type="button"
                onClick={onOpenCheckout}
                className="px-3.5 py-2 text-xs font-medium bg-teal-700 text-white rounded-md hover:bg-teal-800 whitespace-nowrap"
              >
                สร้างรายการชำระเงิน
              </button>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-semibold text-slate-500">
                  <th className="py-2.5 px-5 whitespace-nowrap">รหัสธุรกรรม / ออเดอร์</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">ช่องทางชำระเงิน</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">ความปลอดภัย</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">สถานะ</th>
                  <th className="py-2.5 px-4 whitespace-nowrap text-right">ยอดเงิน (THB)</th>
                  <th className="py-2.5 px-5 whitespace-nowrap text-right">เวลาทำรายการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-xs">
                {filteredTransactions.map((tx) => {
                  const meta = STATUS_META[tx.status];
                  const StatusIcon = meta.Icon;
                  return (
                    <tr
                      key={tx.id}
                      onClick={() => setSelectedTx(tx)}
                      className="hover:bg-slate-50/90 cursor-pointer transition-colors"
                    >
                      <td className="py-3 px-5">
                        <div className="font-mono font-medium text-slate-900">{tx.id}</div>
                        <div className="text-slate-500 mt-0.5 truncate max-w-[230px]">
                          {tx.orderId} · {tx.description}
                        </div>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        {tx.method === 'credit_card' ? (
                          <div className="flex items-center gap-2">
                            <CreditCard className="w-4 h-4 text-slate-500 shrink-0" />
                            <div>
                              <div className="font-medium text-slate-800">{brandDisplayName(tx.brand)}</div>
                              <div className="font-mono text-[11px] text-slate-500">{tx.maskedPan}</div>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <QrCode className="w-4 h-4 text-teal-700 shrink-0" />
                            <div>
                              <div className="font-medium text-slate-800">Thai QR PromptPay</div>
                              <div className="font-mono text-[11px] text-slate-500">Ref {tx.qrReference}</div>
                            </div>
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <div className="flex items-center gap-1.5 text-slate-700">
                          <ShieldCheck className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                          <span>
                            {tx.method === 'credit_card'
                              ? tx.threeDsStatus === 'authenticated'
                                ? '3DS2 OTP'
                                : tx.threeDsStatus === 'frictionless'
                                  ? '3DS2 Frictionless'
                                  : tx.threeDsStatus === 'challenge_pending'
                                    ? 'รอ OTP'
                                    : 'Blocked'
                              : 'EMVCo CRC16 + HMAC'}
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-500 font-mono tabular-nums mt-0.5">
                          Risk {tx.riskScore}/100
                        </div>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span className={`inline-flex items-center gap-1.5 font-medium ${meta.colorClass}`}>
                          <StatusIcon className="w-3.5 h-3.5 shrink-0" />
                          {meta.label}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right whitespace-nowrap font-mono tabular-nums">
                        <div className="font-semibold text-slate-900">{formatThb(tx.amount)}</div>
                        {tx.status === 'succeeded' && (
                          <div className="text-[11px] text-slate-500">สุทธิ {formatThb(tx.netThb)}</div>
                        )}
                      </td>
                      <td className="py-3 px-5 text-right whitespace-nowrap text-slate-500 tabular-nums">
                        {formatDateTimeTh(tx.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Transaction & Security Inspector Slide-Over Drawer */}
      {selectedTx && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40 backdrop-blur-[1px]">
          <div className="w-full max-w-lg bg-white h-full border-l border-slate-200 overflow-y-auto flex flex-col">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
              <div>
                <div className="text-xs text-slate-500">รายละเอียดธุรกรรมและ Security Audit</div>
                <h3 className="text-base font-semibold font-mono text-slate-900">{selectedTx.id}</h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedTx(null)}
                className="p-2 text-slate-500 hover:text-slate-900 rounded-md hover:bg-slate-100"
                aria-label="ปิดหน้าต่างรายละเอียด"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-6 space-y-6 flex-1">
              <div className="flex items-baseline justify-between pb-4 border-b border-slate-100">
                <div>
                  <div className="text-xs text-slate-500">ยอดชำระ</div>
                  <div className="text-2xl font-semibold text-slate-900 font-mono tabular-nums mt-0.5">
                    {formatThb(selectedTx.amount)}
                  </div>
                </div>
                <div className="text-right">
                  {(() => {
                    const meta = STATUS_META[selectedTx.status];
                    const Icon = meta.Icon;
                    return (
                      <span className={`inline-flex items-center gap-1.5 text-sm font-medium ${meta.colorClass}`}>
                        <Icon className="w-4 h-4" />
                        {meta.label}
                      </span>
                    );
                  })()}
                  <div className="text-xs text-slate-500 mt-1 tabular-nums">{formatDateTimeTh(selectedTx.createdAt)}</div>
                </div>
              </div>

              {selectedTx.declineReason && (
                <div className="p-3.5 bg-red-50 border border-red-200 rounded-md text-xs text-red-800">
                  <div className="font-semibold">สาเหตุการปฏิเสธรายการ</div>
                  <div className="mt-0.5">{selectedTx.declineReason}</div>
                </div>
              )}

              <dl className="grid grid-cols-2 gap-y-3 gap-x-4 text-xs">
                <div>
                  <dt className="text-slate-500">Order ID</dt>
                  <dd className="font-mono font-medium text-slate-900 mt-0.5">{selectedTx.orderId}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">อีเมลผู้ชำระ</dt>
                  <dd className="text-slate-900 mt-0.5 truncate">{selectedTx.customerEmail}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">ค่าธรรมเนียม / สุทธิ</dt>
                  <dd className="font-mono tabular-nums text-slate-900 mt-0.5">
                    {formatThb(selectedTx.feeThb)} / {formatThb(selectedTx.netThb)}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">Idempotency Key</dt>
                  <dd className="font-mono text-slate-700 mt-0.5 truncate">{selectedTx.idempotencyKey}</dd>
                </div>
                {selectedTx.tokenId && (
                  <div>
                    <dt className="text-slate-500">AES-256-GCM Token ID</dt>
                    <dd className="font-mono text-teal-800 mt-0.5">{selectedTx.tokenId}</dd>
                  </div>
                )}
                {selectedTx.eci && (
                  <div>
                    <dt className="text-slate-500">3DS2 ECI Indicator</dt>
                    <dd className="font-mono text-slate-900 mt-0.5">ECI {selectedTx.eci}</dd>
                  </div>
                )}
              </dl>

              <div className="pt-4 border-t border-slate-100">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-xs font-semibold text-slate-900">ผลการตรวจสอบความปลอดภัย (Risk &amp; Fraud Checks)</h4>
                  <span className="text-xs font-mono tabular-nums text-slate-600">
                    Risk Score: {selectedTx.riskScore}/100
                  </span>
                </div>
                <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
                  {selectedTx.riskChecks.map((chk) => (
                    <div key={chk.code} className="p-3 flex items-start gap-2.5 text-xs">
                      {chk.passed ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                      ) : (
                        <ShieldAlert className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                      )}
                      <div>
                        <div className="font-medium text-slate-900">{chk.label}</div>
                        <div className="text-slate-500 mt-0.5">{chk.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setSelectedTx(null)}
                className="px-4 py-2 text-xs font-medium border border-slate-200 bg-white text-slate-700 rounded-md hover:bg-slate-100"
              >
                ปิด
              </button>
              {selectedTx.status === 'succeeded' && (
                <button
                  type="button"
                  disabled={refundLoadingId === selectedTx.id}
                  onClick={() => handleRefundClick(selectedTx)}
                  className="px-4 py-2 text-xs font-medium bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 whitespace-nowrap"
                >
                  {refundLoadingId === selectedTx.id ? 'กำลังคืนเงิน...' : 'คืนเงินเต็มจำนวน (Refund)'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
