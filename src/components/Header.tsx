import React from 'react';
import { 
  Zap, 
  ShieldCheck, 
  Activity, 
  Sparkles, 
  Cpu, 
  RefreshCw, 
  Layers
} from 'lucide-react';
import { UserTier, AiServiceStatus, QuotaInfo } from '../types.js';

interface HeaderProps {
  currentTier: UserTier;
  onTierChange: (tier: UserTier) => void;
  aiStatus: AiServiceStatus | null;
  quota: QuotaInfo | null;
  onRefreshStatus: () => void;
  activeTab: string;
  onTabChange: (tab: string) => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentTier,
  onTierChange,
  aiStatus,
  quota,
  onRefreshStatus,
  activeTab,
  onTabChange,
}) => {
  const tabs = [
    { id: 'playground', label: 'API Playground', icon: Zap },
    { id: 'captures', label: 'Captured Items', icon: Layers },
    { id: 'android', label: 'Android Kotlin', icon: ShieldCheck },
    { id: 'telemetry', label: 'Telemetry & Logs', icon: Activity },
    { id: 'spec', label: 'API Specification', icon: Cpu },
    { id: 'account', label: 'Account & Quota', icon: Sparkles },
  ];

  const isHealthy = aiStatus?.status === 'healthy';

  return (
    <header id="remindly-header" className="bg-white border-b border-[#E5E7EB] sticky top-0 z-40 text-[#1A1A1B] shadow-xs">
      {/* Top Banner / Brand Row */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center text-white font-bold shadow-sm">
            R
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-base font-bold tracking-tight text-gray-900">Remindly AI</h1>
              <span className="text-[11px] font-mono text-gray-400">
                PROXY_NODE_v1.2.4
              </span>
            </div>
            <p className="text-xs text-gray-500">
              Extraction Gateway Proxy • Local Rule Engine & Gemini Cloud AI
            </p>
          </div>
        </div>

        {/* Right side controls: Health Badge, Quota, Tier Switcher */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Status Badge */}
          <div 
            id="status-indicator-badge"
            className="flex items-center gap-2 px-2.5 py-1 rounded-md bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-medium cursor-pointer hover:bg-emerald-100/70 transition"
            onClick={onRefreshStatus}
            title="Click to refresh service status"
          >
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span className="capitalize">{aiStatus?.status || 'System Healthy'}</span>
            <RefreshCw className="w-3 h-3 text-emerald-600 hover:rotate-180 transition-transform" />
          </div>

          {/* Quota Badge */}
          {quota && (
            <div id="quota-badge" className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-gray-50 border border-gray-200 text-xs text-gray-600">
              <span className="text-gray-400 font-medium">Quota:</span>
              <span className={`font-semibold font-mono ${quota.remaining < 5 ? 'text-rose-600' : 'text-indigo-600'}`}>
                {quota.remaining}/{quota.limit}
              </span>
            </div>
          )}

          {/* Tier Switcher Control */}
          <div id="tier-switcher-container" className="flex items-center bg-gray-100 p-0.5 rounded-lg border border-gray-200 text-xs">
            <button
              id="tier-btn-free"
              type="button"
              onClick={() => onTierChange('free')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium transition ${
                currentTier === 'free'
                  ? 'bg-white text-gray-900 shadow-xs font-semibold'
                  : 'text-gray-500 hover:text-gray-800'
              }`}
            >
              <Cpu className="w-3.5 h-3.5 text-gray-400" />
              <span>Free (Local)</span>
            </button>

            <button
              id="tier-btn-premium"
              type="button"
              onClick={() => onTierChange('premium')}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md font-medium transition ${
                currentTier === 'premium'
                  ? 'bg-indigo-600 text-white shadow-xs font-semibold'
                  : 'text-gray-500 hover:text-gray-800'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-300" />
              <span>Premium (Gemini)</span>
            </button>
          </div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 border-t border-[#E5E7EB]">
        <nav id="nav-tabs-list" className="flex space-x-1 overflow-x-auto py-1.5 no-scrollbar">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                id={`tab-btn-${tab.id}`}
                key={tab.id}
                onClick={() => onTabChange(tab.id)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition ${
                  isActive
                    ? 'bg-indigo-50 text-indigo-700 font-semibold'
                    : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100/70'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-indigo-600' : 'text-gray-400'}`} />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </header>
  );
};
