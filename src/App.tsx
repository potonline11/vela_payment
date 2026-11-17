import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  CreditCard,
  Lock,
  Menu,
  RefreshCw,
  ShieldCheck,
  Webhook,
  X,
} from 'lucide-react';
import type { DashboardPayload } from './types/gateway';
import { OverviewLedger } from './components/OverviewLedger';
import { LiveCheckout } from './components/LiveCheckout';
import { SecurityVault } from './components/SecurityVault';
import { WebhooksDev } from './components/WebhooksDev';

type TabId = 'overview' | 'checkout' | 'security' | 'webhooks';

const NAV_ITEMS: Array<{ id: TabId; label: string; Icon: typeof Activity }> = [
  { id: 'overview', label: 'ภาพรวมและธุรกรรม', Icon: Activity },
  { id: 'checkout', label: 'หน้าชำระเงิน (Checkout)', Icon: CreditCard },
  { id: 'security', label: 'ความปลอดภัยและ Vault', Icon: ShieldCheck },
  { id: 'webhooks', label: 'Webhooks & คู่มือ API', Icon: Webhook },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchDashboard = useCallback(async (isManualRefresh = false) => {
    if (isManualRefresh) setRefreshing(true);
    setError(null);
    try {
      const res = await fetch('/api/v1/dashboard');
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as DashboardPayload;
      setDashboard(data);
    } catch {
      setError('ไม่สามารถเชื่อมต่อกับเซิร์ฟเวอร์ Payment Gateway ได้ กรุณาลองใหม่อีกครั้ง');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboard(false);
  }, [fetchDashboard]);

  async function handleRefund(txId: string) {
    const res = await fetch(`/api/v1/transactions/${txId}/refund`, { method: 'POST' });
    const json = await res.json();
    if (res.ok && json.dashboard) {
      setDashboard(json.dashboard);
    }
  }

  const currentNavLabel = NAV_ITEMS.find((item) => item.id === activeTab)?.label ?? 'ภาพรวมและธุรกรรม';

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex">
      {/* Desktop Sidebar (256px) */}
      <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:shrink-0 bg-white border-r border-slate-200">
        <div className="h-16 px-6 border-b border-slate-200 flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-md bg-slate-900 text-white flex items-center justify-center shrink-0">
            <Lock className="w-3.5 h-3.5" />
          </div>
          <span className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
            SiamVault Pay
          </span>
        </div>

        <nav className="flex-1 px-3 py-5 space-y-1" aria-label="เมนูหลัก">
          {NAV_ITEMS.map(({ id, label, Icon }) => {
            const isActive = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`w-full px-3 py-2.5 rounded-md text-xs font-medium flex items-center gap-2.5 transition-colors whitespace-nowrap ${
                  isActive
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 text-xs">
          <div className="font-medium text-slate-900 truncate">
            {dashboard?.merchant.merchantName ?? 'SiamCraft Commerce'}
          </div>
          <div className="font-mono text-[11px] text-slate-500 mt-0.5 truncate">
            {dashboard?.merchant.merchantId ?? 'mrc_siamvault_th01'}
          </div>
        </div>
      </aside>

      {/* Mobile Sidebar Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-900/40"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative w-64 max-w-[80vw] bg-white h-full border-r border-slate-200 flex flex-col z-10">
            <div className="h-16 px-5 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-md bg-slate-900 text-white flex items-center justify-center">
                  <Lock className="w-3.5 h-3.5" />
                </div>
                <span className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap">
                  SiamVault Pay
                </span>
              </div>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="p-1.5 text-slate-500 hover:text-slate-900"
                aria-label="ปิดเมนู"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1">
              {NAV_ITEMS.map(({ id, label, Icon }) => {
                const isActive = activeTab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setActiveTab(id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full px-3 py-2.5 rounded-md text-xs font-medium flex items-center gap-2.5 transition-colors whitespace-nowrap ${
                      isActive
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar Contract */}
        <header className="h-16 bg-white border-b border-slate-200 px-4 sm:px-8 flex items-center justify-between gap-8 sticky top-0 z-30">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 -ml-2 text-slate-600 hover:text-slate-900 rounded-md hover:bg-slate-100"
              aria-label="เปิดเมนูนำทาง"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-xs sm:text-sm min-w-0">
              <span className="text-slate-500 whitespace-nowrap hidden sm:inline">SiamVault Pay</span>
              <span className="text-slate-300 hidden sm:inline" aria-hidden="true">/</span>
              <h1 className="font-semibold text-slate-900 truncate">{currentNavLabel}</h1>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => fetchDashboard(true)}
              disabled={refreshing}
              className="px-3 py-2 text-xs font-medium border border-slate-200 bg-white text-slate-700 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">รีเฟรชข้อมูล</span>
            </button>
            {activeTab !== 'checkout' && (
              <button
                type="button"
                onClick={() => setActiveTab('checkout')}
                className="px-4 py-2 text-xs font-semibold bg-teal-700 text-white rounded-md hover:bg-teal-800 transition-colors whitespace-nowrap shrink-0"
              >
                รับชำระเงินใหม่
              </button>
            )}
          </div>
        </header>

        {/* Main Viewport */}
        <main className="flex-1 p-4 sm:p-8 max-w-[1360px] w-full mx-auto">
          {loading ? (
            <div className="space-y-6">
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-28 bg-white border border-slate-200 rounded-lg p-5 animate-pulse">
                    <div className="h-3 w-24 bg-slate-200 rounded" />
                    <div className="h-7 w-36 bg-slate-200 rounded mt-3" />
                    <div className="h-3 w-28 bg-slate-100 rounded mt-3" />
                  </div>
                ))}
              </div>
              <div className="h-80 bg-white border border-slate-200 rounded-lg p-5 animate-pulse" />
            </div>
          ) : error || !dashboard ? (
            <div className="bg-white border border-slate-200 rounded-lg p-8 text-center">
              <p className="text-sm font-medium text-red-700">{error ?? 'เกิดข้อผิดพลาดในการโหลดข้อมูล'}</p>
              <button
                type="button"
                onClick={() => fetchDashboard(true)}
                className="mt-4 px-4 py-2 text-xs font-medium bg-slate-900 text-white rounded-md hover:bg-slate-800"
              >
                ลองเชื่อมต่อใหม่
              </button>
            </div>
          ) : (
            <>
              {activeTab === 'overview' && (
                <OverviewLedger
                  data={dashboard}
                  onRefund={handleRefund}
                  onOpenCheckout={() => setActiveTab('checkout')}
                />
              )}
              {activeTab === 'checkout' && (
                <LiveCheckout
                  dashboard={dashboard}
                  onDashboardUpdate={setDashboard}
                  onGoToLedger={() => setActiveTab('overview')}
                />
              )}
              {activeTab === 'security' && (
                <SecurityVault dashboard={dashboard} onDashboardUpdate={setDashboard} />
              )}
              {activeTab === 'webhooks' && (
                <WebhooksDev dashboard={dashboard} onDashboardUpdate={setDashboard} />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
