import React, { useState, useEffect } from 'react';
import { Header } from './components/Header.js';
import { ApiPlayground } from './components/ApiPlayground.js';
import { CapturesTab } from './components/CapturesTab.js';
import { AndroidKotlinTab } from './components/AndroidKotlinTab.js';
import { TelemetryTab } from './components/TelemetryTab.js';
import { ApiSpecTab } from './components/ApiSpecTab.js';
import { AccountLifecycleTab } from './components/AccountLifecycleTab.js';
import { UserTier, AiServiceStatus, QuotaInfo } from './types.js';

export default function App() {
  const [currentTier, setCurrentTier] = useState<UserTier>('premium');
  const [activeTab, setActiveTab] = useState<string>('playground');
  const [aiStatus, setAiStatus] = useState<AiServiceStatus | null>(null);
  const [quota, setQuota] = useState<QuotaInfo | null>(null);

  const fetchStatusAndQuota = async () => {
    try {
      // 1. Fetch AI Service Status
      const statusRes = await fetch('/v1/ai-status');
      if (statusRes.ok) {
        const data = await statusRes.json();
        if (data.success) {
          setAiStatus(data.data);
        }
      }

      // 2. Fetch Quota Info
      const quotaRes = await fetch('/v1/quota', {
        headers: {
          'X-User-Tier': currentTier,
          'Authorization': `Bearer remindly_test_${currentTier}_playground_user`,
        },
      });
      if (quotaRes.ok) {
        const data = await quotaRes.json();
        if (data.success) {
          setQuota(data.quota);
        }
      }
    } catch (err) {
      console.error('Error fetching service status or quota:', err);
    }
  };

  useEffect(() => {
    fetchStatusAndQuota();
  }, [currentTier]);

  return (
    <div id="remindly-app-root" className="min-h-screen bg-[#F8F9FA] text-[#1A1A1B] flex flex-col font-sans selection:bg-indigo-100 selection:text-indigo-900">
      {/* Header */}
      <Header
        currentTier={currentTier}
        onTierChange={(tier) => setCurrentTier(tier)}
        aiStatus={aiStatus}
        quota={quota}
        onRefreshStatus={fetchStatusAndQuota}
        activeTab={activeTab}
        onTabChange={(tab) => setActiveTab(tab)}
      />

      {/* Main Tab Content */}
      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {activeTab === 'playground' && (
          <ApiPlayground
            currentTier={currentTier}
            onRefreshTelemetry={fetchStatusAndQuota}
          />
        )}
        {activeTab === 'captures' && <CapturesTab currentTier={currentTier} />}
        {activeTab === 'android' && <AndroidKotlinTab />}
        {activeTab === 'telemetry' && (
          <TelemetryTab
            aiStatus={aiStatus}
            onRefresh={fetchStatusAndQuota}
          />
        )}
        {activeTab === 'spec' && <ApiSpecTab currentTier={currentTier} />}
        {activeTab === 'account' && (
          <AccountLifecycleTab
            currentTier={currentTier}
            quota={quota}
            onRefreshQuota={fetchStatusAndQuota}
            onTierChange={(tier) => setCurrentTier(tier)}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-[#E5E7EB] bg-white py-4 text-center text-xs text-gray-500">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-gray-700">Remindly AI</span>
            <span>•</span>
            <span>Extraction Gateway Proxy</span>
            <span className="text-gray-400 font-mono text-[11px]">(PROXY_NODE_v1.2.4)</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-gray-600">
              <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
              Port 3000 Ingress Active
            </span>
            <span className="text-gray-300">•</span>
            <span>Gemini 3.7 Flash & Local Rule Engine</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
