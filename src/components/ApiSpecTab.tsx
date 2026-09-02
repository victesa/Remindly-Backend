import React, { useState } from 'react';
import { Cpu, Sparkles, Check, Copy, Terminal, Shield, ArrowRight, BookOpen } from 'lucide-react';
import { UserTier } from '../types.js';

interface ApiSpecTabProps {
  currentTier: UserTier;
}

export const ApiSpecTab: React.FC<ApiSpecTabProps> = ({ currentTier }) => {
  const [selectedEndpoint, setSelectedEndpoint] = useState<string>('extract');
  const [copied, setCopied] = useState(false);

  const curlExamples: Record<string, string> = {
    extract: `# 1. Primary Extraction Endpoint (Multipart/Form-Data)
curl -X POST "http://localhost:3000/v1/extract-data" \\
  -H "Authorization: Bearer remindly_test_${currentTier}_user123" \\
  -H "X-User-Tier: ${currentTier}" \\
  -H "X-Client-Date: $(date -u +"%Y-%m-%dT%H:%M:%SZ")" \\
  -H "X-User-Timezone: America/Los_Angeles" \\
  -H "Idempotency-Key: mobile_req_$(date +%s)" \\
  -F "text=Team standup meeting today at 2:30pm" \\
  -F "currentDate=$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \\
  -F "timezone=America/Los_Angeles" \\
  -F "url=https://zoom.us/j/4938857579" \\
  -F "image=@/path/to/flyer.png;type=image/png"`,

    quota: `# 2. Inspect & Reset Quota
# Get Quota:
curl -X GET "http://localhost:3000/v1/quota" \\
  -H "Authorization: Bearer remindly_test_${currentTier}_user123"

# Reset Quota:
curl -X POST "http://localhost:3000/v1/quota/reset" \\
  -H "Authorization: Bearer remindly_test_${currentTier}_user123" \\
  -H "Content-Type: application/json" \\
  -d '{"userId": "user123"}'`,

    health: `# 3. Service Health & Transient AI Error Telemetry
# Basic Health:
curl -X GET "http://localhost:3000/v1/health"

# AI Status (Error Rate & Latency Stats):
curl -X GET "http://localhost:3000/v1/ai-status"`,

    auth: `# 4. Dev Token Minting
curl -X POST "http://localhost:3000/v1/auth/mint-token" \\
  -H "Content-Type: application/json" \\
  -d '{"tier": "${currentTier}", "userId": "test_user_789"}'`,

    items: `# 5. User Captures History (Synced with Firestore / In-Memory)
curl -X GET "http://localhost:3000/v1/items?limit=20" \\
  -H "Authorization: Bearer remindly_test_${currentTier}_user123"`,

    account: `# 6. GDPR Account Deletion & Password Reset
# Request Password Reset:
curl -X POST "http://localhost:3000/v1/account/request-password-reset" \\
  -H "Content-Type: application/json" \\
  -d '{"email": "user@example.com"}'

# Delete Account & Purge Captures:
curl -X POST "http://localhost:3000/v1/account/delete" \\
  -H "Authorization: Bearer remindly_test_${currentTier}_user123"`
  };

  const handleCopy = (code: string) => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div id="api-spec-section" className="space-y-6">
      {/* Tier Architecture Matrix */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-xs space-y-4">
        <div className="flex items-center gap-2 border-b border-gray-100 pb-3">
          <BookOpen className="w-5 h-5 text-indigo-600" />
          <h2 className="text-base font-bold text-gray-900">Tier Capabilities & Architecture Matrix</h2>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-gray-200 text-gray-400 font-bold uppercase text-[10px]">
                <th className="py-3 px-4">Feature / Capability</th>
                <th className="py-3 px-4 text-emerald-700 font-bold">Free Tier (Gemini 3.1 Flash Lite)</th>
                <th className="py-3 px-4 text-indigo-700 font-bold">Premium Tier (Fast Lite Engine + Full Suite)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 text-gray-700">
              <tr>
                <td className="py-3 px-4 font-semibold text-gray-900">Extraction Engine</td>
                <td className="py-3 px-4 font-mono text-emerald-700 font-semibold">gemini_flash_lite (Gemini 3.1 Flash Lite)</td>
                <td className="py-3 px-4 font-mono text-indigo-700 font-semibold">gemini_cloud_ai (Gemini 3.1 Flash Lite + Auto-Failover)</td>
              </tr>
              <tr>
                <td className="py-3 px-4 font-semibold text-gray-900">AI Intelligence</td>
                <td className="py-3 px-4 text-emerald-900">100% Pure LLM Context Reasoning (No Regexes)</td>
                <td className="py-3 px-4 text-indigo-900">Deep Reasoning, Multimodal Vision & OCR</td>
              </tr>
              <tr>
                <td className="py-3 px-4 font-semibold text-gray-900">AI Summary</td>
                <td className="py-3 px-4 text-gray-400 font-medium italic">Strictly null (Free restriction)</td>
                <td className="py-3 px-4 text-indigo-900">Rich 1-2 sentence executive overview</td>
              </tr>
              <tr>
                <td className="py-3 px-4 font-semibold text-gray-900">Semantic Deduplication</td>
                <td className="py-3 px-4 text-emerald-900 font-medium">0-Token Instant Cache (SHA-256 Keyed)</td>
                <td className="py-3 px-4 text-indigo-900 font-medium">0-Token Instant Cache (SHA-256 Keyed)</td>
              </tr>
              <tr>
                <td className="py-3 px-4 font-semibold text-gray-900">Rate Quota Window</td>
                <td className="py-3 px-4 font-mono text-gray-600">25 requests / 15 minutes (High RPM ceiling)</td>
                <td className="py-3 px-4 font-mono text-indigo-700 font-semibold">250 requests / 15 minutes</td>
              </tr>
              <tr>
                <td className="py-3 px-4 font-semibold text-gray-900">Reliability Fallback</td>
                <td className="py-3 px-4 text-gray-600">Automatic retry & semantic cache fallback</td>
                <td className="py-3 px-4 text-indigo-900">Priority AI routing & automated retry fallback</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Endpoints & cURL Inspector */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 shadow-xs space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-gray-100 pb-4">
          <div>
            <h3 className="text-sm font-bold text-gray-900 flex items-center gap-2">
              <Terminal className="w-4 h-4 text-indigo-600" />
              <span>Interactive cURL Examples</span>
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">Test endpoints directly from terminal or client scripts</p>
          </div>

          <button
            onClick={() => handleCopy(curlExamples[selectedEndpoint])}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-xs font-semibold text-white shadow-xs transition cursor-pointer"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5" />
                <span>Copied cURL</span>
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" />
                <span>Copy Command</span>
              </>
            )}
          </button>
        </div>

        {/* Endpoint Selector Tabs */}
        <div className="flex flex-wrap gap-2">
          {[
            { id: 'extract', label: 'POST /v1/extract-data' },
            { id: 'quota', label: 'GET/POST /v1/quota' },
            { id: 'health', label: 'GET /v1/health & ai-status' },
            { id: 'auth', label: 'POST /v1/auth/mint-token' },
            { id: 'items', label: 'GET /v1/items' },
            { id: 'account', label: 'POST /v1/account/*' },
          ].map((ep) => (
            <button
              key={ep.id}
              onClick={() => setSelectedEndpoint(ep.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-mono transition cursor-pointer ${
                selectedEndpoint === ep.id
                  ? 'bg-indigo-50 text-indigo-700 border border-indigo-200 font-semibold'
                  : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
              }`}
            >
              {ep.label}
            </button>
          ))}
        </div>

        {/* Terminal Block */}
        <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 font-mono text-xs text-emerald-400 overflow-x-auto shadow-xs">
          <pre className="leading-relaxed whitespace-pre-wrap">{curlExamples[selectedEndpoint]}</pre>
        </div>
      </div>
    </div>
  );
};
