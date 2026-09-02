import React, { useState, useEffect } from 'react';
import { 
  Activity, 
  RefreshCw, 
  Trash2, 
  CheckCircle2, 
  AlertTriangle, 
  Clock, 
  Cpu, 
  Sparkles, 
  Filter,
  Layers
} from 'lucide-react';
import { LogEntry, AiServiceStatus, UserTier } from '../types.js';

interface TelemetryTabProps {
  aiStatus: AiServiceStatus | null;
  onRefresh: () => void;
}

export const TelemetryTab: React.FC<TelemetryTabProps> = ({ aiStatus, onRefresh }) => {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [tierFilter, setTierFilter] = useState<'all' | UserTier>('all');
  const [isLoading, setIsLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchLogs = async () => {
    setIsLoading(true);
    try {
      const url = tierFilter === 'all' ? '/v1/logs?limit=100' : `/v1/logs?limit=100&tier=${tierFilter}`;
      const res = await fetch(url);
      const data = await res.json() as { success?: boolean; logs?: LogEntry[] };
      if (data.success) {
        setLogs(data.logs || []);
      }
    } catch (err) {
      console.error('Failed to fetch logs', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearLogs = async () => {
    try {
      await fetch('/v1/logs/clear', { method: 'POST' });
      setLogs([]);
      onRefresh();
    } catch (err) {
      console.error('Failed to clear logs', err);
    }
  };

  useEffect(() => {
    fetchLogs();
  }, [tierFilter]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchLogs();
      onRefresh();
    }, 4000);
    return () => clearInterval(interval);
  }, [autoRefresh, tierFilter]);

  return (
    <div id="telemetry-section" className="space-y-6">
      {/* Metric Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: AI Health */}
        <div className="bg-white border border-gray-200 p-4 rounded-xl shadow-xs">
          <div className="flex items-center justify-between text-gray-400 text-[10px] uppercase font-bold tracking-wider mb-2">
            <span>AI Service Status</span>
            <Activity className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-bold text-gray-900 capitalize">
              {aiStatus?.status || 'Healthy'}
            </span>
            <span className="text-xs text-emerald-700 font-medium">
              {aiStatus?.geminiConfigured ? 'Gemini Ready' : 'Local Fallback'}
            </span>
          </div>
          <div className="text-[11px] text-gray-500 mt-2 font-mono">
            Model: {aiStatus?.primaryModel || 'gemini-3.7-flash'}
          </div>
        </div>

        {/* Card 2: Error Rate */}
        <div className="bg-white border border-gray-200 p-4 rounded-xl shadow-xs">
          <div className="flex items-center justify-between text-gray-400 text-[10px] uppercase font-bold tracking-wider mb-2">
            <span>Recent Error Rate</span>
            <AlertTriangle className="w-4 h-4 text-amber-500" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className={`text-xl font-bold ${
              (aiStatus?.errorRateRecent || 0) > 0.05 ? 'text-rose-600' : 'text-emerald-600'
            }`}>
              {((aiStatus?.errorRateRecent || 0) * 100).toFixed(1)}%
            </span>
            <span className="text-xs text-gray-500">Past 100 reqs</span>
          </div>
          <div className="text-[11px] text-gray-500 mt-2">
            Total Requests: {aiStatus?.totalRequests || 0}
          </div>
        </div>

        {/* Card 3: Average Latency */}
        <div className="bg-white border border-gray-200 p-4 rounded-xl shadow-xs">
          <div className="flex items-center justify-between text-gray-400 text-[10px] uppercase font-bold tracking-wider mb-2">
            <span>Avg Processing Latency</span>
            <Clock className="w-4 h-4 text-indigo-600" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-bold text-gray-900">
              {aiStatus?.avgLatencyMs || 0}ms
            </span>
            <span className="text-xs text-gray-500">Response time</span>
          </div>
          <div className="text-[11px] text-gray-500 mt-2">
            Cache hit ratio: {((aiStatus?.cacheHitRatio || 0) * 100).toFixed(0)}%
          </div>
        </div>

        {/* Card 4: Tier Usage */}
        <div className="bg-white border border-gray-200 p-4 rounded-xl shadow-xs">
          <div className="flex items-center justify-between text-gray-400 text-[10px] uppercase font-bold tracking-wider mb-2">
            <span>Tier Distribution</span>
            <Layers className="w-4 h-4 text-indigo-600" />
          </div>
          <div className="flex items-center gap-3 text-xs font-semibold">
            <div className="flex items-center gap-1 text-gray-700">
              <Cpu className="w-3.5 h-3.5 text-gray-400" />
              <span>Free: {aiStatus?.tierBreakdown.freeRequests || 0}</span>
            </div>
            <div className="flex items-center gap-1 text-indigo-600">
              <Sparkles className="w-3.5 h-3.5 text-amber-500" />
              <span>Prem: {aiStatus?.tierBreakdown.premiumRequests || 0}</span>
            </div>
          </div>
          <div className="text-[11px] text-gray-500 mt-2">
            Uptime: {Math.floor((aiStatus?.uptimeSeconds || 0) / 60)}m {((aiStatus?.uptimeSeconds || 0) % 60)}s
          </div>
        </div>
      </div>

      {/* Logs Table Controls */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-gray-100 pb-4">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-indigo-600" />
            <div>
              <h3 className="text-sm font-bold text-gray-900">Live Telemetry & In-Memory Logs</h3>
              <p className="text-xs text-gray-500">Real-time structured logs with strategy and dedupe tracking</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* Tier Filter */}
            <div className="flex items-center bg-gray-100 p-0.5 rounded-lg border border-gray-200 text-xs">
              <Filter className="w-3 h-3 text-gray-400 ml-1.5" />
              {(['all', 'free', 'premium'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTierFilter(t)}
                  className={`px-2.5 py-1 rounded text-xs font-medium capitalize transition cursor-pointer ${
                    tierFilter === t
                      ? 'bg-white text-gray-900 font-semibold shadow-xs'
                      : 'text-gray-500 hover:text-gray-800'
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>

            {/* Auto Refresh Toggle */}
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`px-3 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-1.5 transition cursor-pointer ${
                autoRefresh
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                  : 'bg-gray-50 border-gray-200 text-gray-600'
              }`}
            >
              <RefreshCw className={`w-3 h-3 ${autoRefresh ? 'animate-spin' : ''}`} />
              <span>{autoRefresh ? 'Live Streaming' : 'Paused'}</span>
            </button>

            {/* Clear Logs */}
            <button
              onClick={handleClearLogs}
              className="p-1.5 rounded-lg bg-gray-50 hover:bg-rose-50 border border-gray-200 hover:border-rose-200 text-gray-500 hover:text-rose-600 transition cursor-pointer"
              title="Clear log buffer"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Logs Table */}
        {logs.length === 0 ? (
          <div className="text-center py-10 text-xs text-gray-400">
            No logs captured yet. Execute extractions to populate telemetry stream.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-gray-700">
              <thead className="text-[10px] font-bold uppercase tracking-wider text-gray-400 bg-gray-50/80 border-b border-gray-200">
                <tr>
                  <th className="py-2.5 px-3">Time</th>
                  <th className="py-2.5 px-3">Status</th>
                  <th className="py-2.5 px-3">Tier</th>
                  <th className="py-2.5 px-3">Strategy</th>
                  <th className="py-2.5 px-3">Extracted Title / Category</th>
                  <th className="py-2.5 px-3">Latency</th>
                  <th className="py-2.5 px-3">Signals</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {logs.map((log) => {
                  const isOk = log.statusCode < 400;
                  return (
                    <tr key={log.id} className="hover:bg-gray-50/80 font-mono text-xs transition">
                      <td className="py-2.5 px-3 text-gray-500 whitespace-nowrap">
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          isOk ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-rose-50 text-rose-700 border border-rose-200'
                        }`}>
                          {log.statusCode} {log.method}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-bold ${
                          log.userTier === 'premium' ? 'bg-amber-50 text-amber-800 border border-amber-200' : 'bg-gray-100 text-gray-600 border border-gray-200'
                        }`}>
                          {log.userTier}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap text-gray-600 font-sans text-[11px]">
                        {log.strategy || 'N/A'}
                        {log.cached && <span className="ml-1 text-[10px] text-blue-600 font-mono">[Cached]</span>}
                      </td>
                      <td className="py-2.5 px-3 max-w-xs truncate font-sans text-gray-900">
                        {log.titleExtracted ? (
                          <div className="flex items-center gap-1.5">
                            {log.categoryExtracted && (
                              <span className="text-[10px] px-1.5 py-0.2 rounded bg-indigo-50 text-indigo-700 font-mono border border-indigo-100">
                                {log.categoryExtracted}
                              </span>
                            )}
                            <span className="truncate">{log.titleExtracted}</span>
                          </div>
                        ) : (
                          <span className="text-gray-400">{log.error || log.endpoint}</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap text-gray-700 font-mono">
                        {log.latencyMs}ms
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap text-gray-500 text-[11px] font-sans">
                        {[
                          log.hasText && 'text',
                          log.hasUrl && 'url',
                          log.hasImage && 'img',
                        ].filter(Boolean).join(' + ') || 'empty'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
