import React, { useState, useEffect } from 'react';
import { Layers, RefreshCw, Clock, Calendar, Building, Sparkles, AlertCircle, FileText, CheckCircle2 } from 'lucide-react';
import { StoredReminderItem, UserTier } from '../types.js';

interface CapturesTabProps {
  currentTier: UserTier;
}

const formatSafeDate = (val?: string | null): string => {
  if (!val) return '';
  const d = new Date(val);
  if (isNaN(d.getTime())) return val;
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }) + (val.includes('T') ? ` ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : '');
};

export const CapturesTab: React.FC<CapturesTabProps> = ({ currentTier }) => {
  const [items, setItems] = useState<StoredReminderItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fetchItems = async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/v1/items', {
        headers: {
          'X-User-Tier': currentTier,
          'Authorization': `Bearer remindly_test_${currentTier}_playground_user`,
        },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load items');
      setItems(data.items || []);
    } catch (err: any) {
      setErrorMsg(err.message || 'Error fetching captures');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchItems();
  }, [currentTier]);

  return (
    <div id="captures-history-section" className="space-y-6">
      {/* Top Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 bg-white border border-gray-200 p-5 rounded-xl shadow-xs">
        <div>
          <div className="flex items-center gap-2">
            <Layers className="w-5 h-5 text-indigo-600" />
            <h2 className="text-base font-bold text-gray-900">Extracted Captures History</h2>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            Persisted items stored via Firestore or in-memory fallback for testing.
          </p>
        </div>
        <button
          id="refresh-captures-btn"
          type="button"
          onClick={fetchItems}
          disabled={isLoading}
          className="flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg bg-white hover:bg-gray-50 border border-gray-200 text-xs font-medium text-gray-700 shadow-xs transition cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-indigo-600' : 'text-gray-400'}`} />
          <span>Refresh History</span>
        </button>
      </div>

      {errorMsg && (
        <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2 shadow-xs">
          <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {items.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 border-dashed p-12 text-center text-gray-400 space-y-3 shadow-xs">
          <FileText className="w-8 h-8 mx-auto text-gray-300" />
          <div className="text-sm font-semibold text-gray-700">No Captures Yet</div>
          <p className="text-xs text-gray-500 max-w-sm mx-auto">
            Run an extraction in the API Playground tab to create and persist reminder items.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {items.map((item) => (
            <div
              key={item.id}
              className="bg-white border border-gray-200 rounded-xl p-5 shadow-xs space-y-3 hover:border-indigo-200 transition"
            >
              <div className="flex items-center justify-between border-b border-gray-100 pb-2.5">
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 border border-indigo-100">
                  {item.data.category}
                </span>
                <span className="text-[11px] text-gray-400 font-mono">
                  {new Date(item.extractedAt).toLocaleTimeString()} • {item.persistedSource}
                </span>
              </div>

              <div>
                <h4 className="text-sm font-bold text-gray-900 leading-snug">{item.data.title}</h4>
                <p className="text-xs text-gray-500 truncate mt-0.5 font-sans">Input: "{item.inputSnippet}"</p>
              </div>

              {item.data.summary ? (
                <div className="p-3 rounded-lg bg-amber-50/70 border border-amber-200/80 text-xs text-amber-950">
                  <div className="flex items-center gap-1.5 text-[10px] font-semibold text-amber-700 uppercase tracking-wider mb-1">
                    <Sparkles className="w-3 h-3 text-amber-600" />
                    <span>Gemini AI Summary</span>
                  </div>
                  <p className="leading-relaxed font-sans">{item.data.summary}</p>
                </div>
              ) : (
                <div className="text-xs text-gray-400 italic">
                  Free Tier AI Extraction (No executive summary)
                </div>
              )}

              <div className="flex flex-wrap gap-2 text-xs pt-1">
                {item.data.deadline && (
                  <div className="flex items-center gap-1.5 text-amber-900 bg-amber-50 px-2 py-1 rounded border border-amber-200 text-[11px]">
                    <Clock className="w-3 h-3 text-amber-600" />
                    <span>Due: {formatSafeDate(item.data.deadline)}</span>
                  </div>
                )}
                {item.data.eventDate && (
                  <div className="flex items-center gap-1.5 text-blue-900 bg-blue-50 px-2 py-1 rounded border border-blue-200 text-[11px]">
                    <Calendar className="w-3 h-3 text-blue-600" />
                    <span>Event: {formatSafeDate(item.data.eventDate)}</span>
                  </div>
                )}
                {item.data.organization && (
                  <div className="flex items-center gap-1.5 text-gray-700 bg-gray-50 px-2 py-1 rounded border border-gray-200 text-[11px]">
                    <Building className="w-3 h-3 text-gray-400" />
                    <span>{item.data.organization}</span>
                  </div>
                )}
                {!item.data.deadline && !item.data.eventDate && (
                  <div className="flex items-center gap-1.5 text-gray-400 bg-gray-50 px-2 py-1 rounded border border-gray-200 text-[11px]">
                    <Clock className="w-3 h-3 text-gray-400" />
                    <span>No date/time</span>
                  </div>
                )}
              </div>

              {item.data.actionableItems && item.data.actionableItems.length > 0 && (
                <div className="space-y-1 pt-2 border-t border-gray-100">
                  {item.data.actionableItems.map((act, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-xs text-gray-600">
                      <CheckCircle2 className="w-3 h-3 text-emerald-600 shrink-0" />
                      <span>{act}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
