import React, { useState } from 'react';
import { 
  Zap, 
  Send, 
  Image as ImageIcon, 
  Link as LinkIcon, 
  CheckCircle2, 
  Clock, 
  Building, 
  Calendar, 
  Sparkles, 
  FileText, 
  Copy, 
  Check, 
  AlertCircle,
  Hash,
  ArrowRight,
  HelpCircle,
  Tag,
  Globe
} from 'lucide-react';
import { UserTier, ExtractionResponse } from '../types.js';

interface ApiPlaygroundProps {
  currentTier: UserTier;
  onRefreshTelemetry?: () => void;
}

export const ApiPlayground: React.FC<ApiPlaygroundProps> = ({ currentTier, onRefreshTelemetry }) => {
  const [textInput, setTextInput] = useState('Doctor appointment with Dr. Robert Smith at Kaiser Permanente on Friday August 28, 2026 at 3:00 PM.');
  const [urlInput, setUrlInput] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<ExtractionResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedJson, setCopiedJson] = useState(false);

  // Detect user's browser/system timezone automatically
  const detectedTimezone = typeof Intl !== 'undefined' && Intl.DateTimeFormat
    ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    : 'UTC';

  const [userTimezone, setUserTimezone] = useState<string>(detectedTimezone);

  // Common timezone quick picks
  const commonTimezones = [
    detectedTimezone,
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
    'Europe/London',
    'Europe/Paris',
    'Africa/Nairobi',
    'Asia/Dubai',
    'Asia/Kolkata',
    'Asia/Tokyo',
    'Australia/Sydney',
    'UTC',
  ].filter((v, i, a) => a.indexOf(v) === i); // deduplicate

  // Scenario Presets
  const presets = [
    {
      id: 'scenario-1-text',
      label: 'Scenario 1: Text Only',
      desc: 'Bill payment with strict deadline',
      text: 'Submit payment for PG&E utility electric bill $134.50 before August 30, 2026 at 5:00 PM to avoid late penalty fees.',
      url: '',
    },
    {
      id: 'scenario-2-text-url',
      label: 'Scenario 2: Text + URL',
      desc: 'Detailed meeting notes with Zoom link',
      text: 'Quarterly Board Review meeting scheduled with Microsoft leadership on next Wednesday at 10:00 AM. Join link: https://zoom.us/j/4938857579 - review attached spreadsheet.',
      url: 'https://zoom.us/j/4938857579',
    },
    {
      id: 'scenario-3-url-only',
      label: 'Scenario 3: URL Only',
      desc: 'Resolve and scrape webpage',
      text: '',
      url: 'https://news.ycombinator.com',
    },
    {
      id: 'scenario-4-appointment',
      label: 'Scenario: Doctor Visit',
      desc: 'Appointment with clinic',
      text: 'Dentist cleaning appointment with Dr. Chen at Bright Smiles Clinic on September 15, 2026 at 2:30 PM. Please arrive 15 minutes early.',
      url: '',
    },
    {
      id: 'scenario-5-conference',
      label: 'Scenario: Tech Conference',
      desc: 'Registration deadline',
      text: 'Early bird ticket registration deadline for Google Cloud Summit ends September 2, 2026 at 11:59 PM.',
      url: '',
    },
    {
      id: 'scenario-6-relative-time',
      label: 'Scenario: Relative Time',
      desc: 'Resolves in your local timezone',
      text: 'Team sprint alignment meeting today at 4:30 PM, and submit weekly report by tomorrow at 11:00 AM.',
      url: '',
    },
    {
      id: 'scenario-7-dual-dates',
      label: 'Scenario: Event + Cutoff',
      desc: 'Both Event Date & Deadline',
      text: 'Global AI Summit scheduled for November 12, 2026 at 9:00 AM at Moscone Center. Speaker proposal submission deadline is October 15, 2026 at 5:00 PM.',
      url: '',
    },
  ];

  const handleApplyPreset = (preset: typeof presets[0]) => {
    setTextInput(preset.text);
    setUrlInput(preset.url);
    setSelectedFile(null);
  };

  const handleExecuteExtraction = async () => {
    if (!textInput.trim() && !urlInput.trim() && !selectedFile) {
      setErrorMsg('Please provide text, a URL, or upload an image file.');
      return;
    }

    setIsLoading(true);
    setErrorMsg(null);

    const formData = new FormData();
    const clientNowIso = new Date().toISOString();
    if (textInput.trim()) formData.append('text', textInput.trim());
    if (urlInput.trim()) formData.append('url', urlInput.trim());
    if (selectedFile) formData.append('image', selectedFile);
    if (idempotencyKey.trim()) formData.append('idempotencyKey', idempotencyKey.trim());
    formData.append('currentDate', clientNowIso);
    formData.append('timezone', userTimezone || detectedTimezone);

    try {
      const headers: Record<string, string> = {
        'X-User-Tier': currentTier,
        'Authorization': `Bearer remindly_test_${currentTier}_playground_user`,
        'X-Client-Date': clientNowIso,
        'X-User-Timezone': userTimezone || detectedTimezone,
      };
      if (idempotencyKey.trim()) {
        headers['Idempotency-Key'] = idempotencyKey.trim();
      }

      const res = await fetch('/v1/extract-data', {
        method: 'POST',
        headers,
        body: formData,
      });

      const data = await res.json() as { error?: string } & Record<string, unknown>;
      if (!res.ok) {
        throw new Error(data.error || `HTTP error ${res.status}`);
      }

      setResponse(data);
      if (onRefreshTelemetry) onRefreshTelemetry();
    } catch (err: any) {
      setErrorMsg(err.message || 'Extraction failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopyJson = () => {
    if (!response) return;
    navigator.clipboard.writeText(JSON.stringify(response, null, 2));
    setCopiedJson(true);
    setTimeout(() => setCopiedJson(false), 2000);
  };

  const generateRandomIdempotency = () => {
    setIdempotencyKey(`idemp_${Math.random().toString(36).substring(2, 9)}`);
  };

  return (
    <div className="space-y-6">
      {/* Overview Banner */}
      <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-xs flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-indigo-600" />
            <h2 className="text-base font-bold text-gray-900">Cognitive AI Extraction Playground</h2>
            <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider ${
              currentTier === 'premium' ? 'bg-indigo-100 text-indigo-700' : 'bg-emerald-100 text-emerald-800'
            }`}>
              {currentTier === 'premium' ? 'Gemini 3.1 Flash Lite + Premium Suite' : 'Gemini 3.1 Flash Lite'}
            </span>
          </div>
          <p className="text-xs text-gray-600 mt-1 leading-relaxed">
            {currentTier === 'premium'
              ? 'Premium mode uses the ultra-fast sub-second engine with full executive AI summaries, actionable checklists, and 10x higher rate limits.'
              : 'Free mode runs high-throughput Gemini Flash Lite with pure contextual reasoning and instant 0-token semantic caching.'}
          </p>
        </div>

        {/* Timezone Indicator */}
        <div className="flex items-center gap-2 bg-slate-50 px-3 py-2 rounded-lg border border-slate-200 text-xs shrink-0">
          <Globe className="w-4 h-4 text-indigo-600 shrink-0" />
          <div>
            <div className="text-[10px] text-gray-500 font-semibold uppercase">Client Timezone</div>
            <div className="font-mono text-gray-900 font-semibold">{userTimezone}</div>
          </div>
        </div>
      </div>

      {/* Preset Buttons */}
      <div>
        <div className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-2 flex items-center gap-1.5">
          <Tag className="w-3.5 h-3.5 text-gray-400" />
          <span>Quick Scenario Presets</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2.5">
          {presets.map((preset) => (
            <button
              key={preset.id}
              id={`btn-preset-${preset.id}`}
              onClick={() => handleApplyPreset(preset)}
              className="text-left p-3 rounded-lg bg-white hover:bg-indigo-50/50 border border-gray-200 hover:border-indigo-200 shadow-xs transition group cursor-pointer"
            >
              <div className="text-xs font-semibold text-gray-900 group-hover:text-indigo-600 transition flex items-center justify-between">
                <span>{preset.label}</span>
                <ArrowRight className="w-3 h-3 opacity-0 group-hover:opacity-100 transition text-indigo-600" />
              </div>
              <div className="text-[11px] text-gray-500 truncate mt-0.5">{preset.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Main Form & Response Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: Request Builder */}
        <div className="lg:col-span-6 space-y-4">
          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-xs space-y-4">
            <div className="flex items-center justify-between border-b border-gray-100 pb-3">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-indigo-600" />
                <h3 className="text-sm font-bold text-gray-900">Extraction Payload</h3>
              </div>
              <span className="text-[11px] font-mono text-gray-400">POST /v1/extract-data</span>
            </div>

            {/* Timezone Selector */}
            <div>
              <label htmlFor="tz-select" className="block text-xs font-semibold text-gray-700 mb-1.5 flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5 text-indigo-600" />
                  <span>User Timezone (IANA)</span>
                </span>
                <span className="text-[10px] text-gray-400 font-normal">Passed via X-User-Timezone</span>
              </label>
              <select
                id="tz-select"
                value={userTimezone}
                onChange={(e) => setUserTimezone(e.target.value)}
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-900 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition font-mono"
              >
                {commonTimezones.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz} {tz === detectedTimezone ? '(Auto-Detected Local Device Timezone)' : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* Text Input */}
            <div>
              <label htmlFor="text-input" className="block text-xs font-semibold text-gray-700 mb-1.5">
                Unstructured Content / OCR Text
              </label>
              <textarea
                id="text-input"
                rows={4}
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                placeholder="Paste OCR text, meeting notes, invoice description, or reminder details..."
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition font-sans"
              />
            </div>

            {/* URL Input */}
            <div>
              <label htmlFor="url-input" className="block text-xs font-semibold text-gray-700 mb-1.5 flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <LinkIcon className="w-3.5 h-3.5 text-gray-400" />
                  <span>URL Reference / Webpage Target</span>
                </span>
                <span className="text-[10px] text-gray-400">Scenario 2 & 3</span>
              </label>
              <input
                id="url-input"
                type="url"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://example.com/event-invitation"
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 transition font-sans"
              />
            </div>

            {/* Image File Upload */}
            <div>
              <label htmlFor="file-upload" className="block text-xs font-semibold text-gray-700 mb-1.5 flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <ImageIcon className="w-3.5 h-3.5 text-gray-400" />
                  <span>Image Upload (Flyer / Screenshot)</span>
                </span>
                <span className="text-[10px] text-gray-400">JPG, PNG, WEBP</span>
              </label>
              <div className="flex items-center gap-3">
                <label className="flex-1 cursor-pointer bg-gray-50 hover:bg-gray-100/70 border border-dashed border-gray-300 rounded-lg p-3 text-center transition">
                  <input
                    id="file-upload"
                    type="file"
                    accept="image/*"
                    onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                    className="hidden"
                  />
                  <div className="text-xs text-gray-600 flex items-center justify-center gap-2">
                    <ImageIcon className="w-4 h-4 text-indigo-600" />
                    <span>{selectedFile ? selectedFile.name : 'Click or drop flyer image here'}</span>
                  </div>
                </label>
                {selectedFile && (
                  <button
                    type="button"
                    onClick={() => setSelectedFile(null)}
                    className="text-xs text-rose-600 hover:text-rose-700 px-2.5 py-1 bg-rose-50 rounded-md border border-rose-200 cursor-pointer"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>

            {/* Idempotency Key */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor="idemp-key-input" className="text-xs font-semibold text-gray-700 flex items-center gap-1.5">
                  <Hash className="w-3.5 h-3.5 text-gray-400" />
                  <span>Idempotency-Key (Header)</span>
                </label>
                <button
                  type="button"
                  onClick={generateRandomIdempotency}
                  className="text-[11px] font-medium text-indigo-600 hover:text-indigo-700 cursor-pointer"
                >
                  Generate Key
                </button>
              </div>
              <input
                id="idemp-key-input"
                type="text"
                value={idempotencyKey}
                onChange={(e) => setIdempotencyKey(e.target.value)}
                placeholder="e.g. mobile_client_uuid_12345"
                className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-xs text-gray-900 placeholder-gray-400 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 font-mono transition"
              />
            </div>

            {/* Submit Button */}
            <div className="pt-2">
              <button
                id="execute-extract-btn"
                type="button"
                onClick={handleExecuteExtraction}
                disabled={isLoading}
                className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-2.5 px-4 rounded-lg text-xs flex items-center justify-center gap-2 shadow-xs transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {isLoading ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    <span>Extracting Structured Data...</span>
                  </>
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    <span>Execute Extraction ({currentTier.toUpperCase()})</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>

        {/* Right Column: Visual Result Card & JSON Response */}
        <div className="lg:col-span-6 space-y-4">
          {errorMsg && (
            <div className="p-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-start gap-3 shadow-xs">
              <AlertCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold text-rose-900">Extraction Error</div>
                <p className="mt-0.5">{errorMsg}</p>
              </div>
            </div>
          )}

          {response ? (
            <div className="space-y-4">
              {/* Visual Card Representation */}
              <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-xs space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">
                        {response.data.category}
                      </span>
                      <span className="text-[10px] font-mono text-gray-500">
                        {response.data.strategy}
                      </span>
                      {response.metadata.cached && (
                        <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                          ⚡ Cached (0 Tokens)
                        </span>
                      )}
                    </div>
                    <h3 className="text-base font-bold text-gray-900 leading-snug">
                      {response.data.title}
                    </h3>
                  </div>

                  <span className="text-xs text-gray-400 font-mono shrink-0">
                    {response.metadata.processingTimeMs}ms
                  </span>
                </div>

                {/* AI Summary */}
                <div className="p-3 rounded-lg bg-gray-50/80 border border-gray-100">
                  <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                    <Sparkles className="w-3 h-3 text-indigo-500" />
                    <span>AI Executive Summary</span>
                  </div>
                  {response.data.summary ? (
                    <p className="text-xs text-gray-700 leading-relaxed">
                      {response.data.summary}
                    </p>
                  ) : (
                    <p className="text-xs text-gray-400 italic">
                      No AI Summary generated (Executive summaries are reserved for Premium; Free tier extracts structured title, dates, categories, and organizations with Gemini Flash Lite).
                    </p>
                  )}
                </div>

                {/* Details Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 text-xs">
                  {response.data.deadline && (
                    <div className="p-2.5 rounded-lg bg-amber-50/60 border border-amber-200/80 flex items-center gap-2 text-amber-900">
                      <Clock className="w-4 h-4 text-amber-600 shrink-0" />
                      <div className="overflow-hidden">
                        <div className="text-[10px] text-amber-700 uppercase font-semibold">Deadline / Due</div>
                        <div className="font-semibold text-xs text-amber-950">
                          {(() => {
                            const d = new Date(response.data.deadline);
                            return isNaN(d.getTime()) ? response.data.deadline : d.toLocaleString(undefined, { timeZone: userTimezone, dateStyle: 'medium', timeStyle: 'short' });
                          })()}
                        </div>
                        <div className="truncate font-mono text-[10px] text-amber-700/80">{response.data.deadline}</div>
                      </div>
                    </div>
                  )}

                  {response.data.eventDate && (
                    <div className="p-2.5 rounded-lg bg-blue-50/60 border border-blue-200/80 flex items-center gap-2 text-blue-900">
                      <Calendar className="w-4 h-4 text-blue-600 shrink-0" />
                      <div className="overflow-hidden">
                        <div className="text-[10px] text-blue-700 uppercase font-semibold">Event Date</div>
                        <div className="font-semibold text-xs text-blue-950">
                          {(() => {
                            const d = new Date(response.data.eventDate);
                            return isNaN(d.getTime()) ? response.data.eventDate : d.toLocaleString(undefined, { timeZone: userTimezone, dateStyle: 'medium', timeStyle: 'short' });
                          })()}
                        </div>
                        <div className="truncate font-mono text-[10px] text-blue-700/80">{response.data.eventDate}</div>
                      </div>
                    </div>
                  )}

                  {response.data.organization && (
                    <div className="p-2.5 rounded-lg bg-gray-50 border border-gray-200 flex items-center gap-2 text-gray-800">
                      <Building className="w-4 h-4 text-gray-500 shrink-0" />
                      <div className="overflow-hidden">
                        <div className="text-[10px] text-gray-500 uppercase font-semibold">Organization</div>
                        <div className="truncate text-xs text-gray-900 font-medium">{response.data.organization}</div>
                      </div>
                    </div>
                  )}

                  {response.data.url && (
                    <div className="p-2.5 rounded-lg bg-indigo-50/60 border border-indigo-100 flex items-center gap-2 text-indigo-900">
                      <LinkIcon className="w-4 h-4 text-indigo-600 shrink-0" />
                      <div className="overflow-hidden">
                        <div className="text-[10px] text-indigo-600 uppercase font-semibold">URL</div>
                        <a href={response.data.url} target="_blank" rel="noreferrer" className="truncate text-xs underline hover:text-indigo-700">
                          {response.data.url}
                        </a>
                      </div>
                    </div>
                  )}

                  {!response.data.deadline && !response.data.eventDate && (
                    <div className="p-2.5 rounded-lg bg-gray-50 border border-gray-200 flex items-center gap-2 text-gray-500 sm:col-span-2">
                      <Clock className="w-4 h-4 text-gray-400 shrink-0" />
                      <div>
                        <div className="text-[10px] text-gray-400 uppercase font-semibold">Date & Time</div>
                        <div className="text-xs text-gray-600 font-medium">No deadline or event time detected in capture</div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Actionable items checklist */}
                {response.data.actionableItems && response.data.actionableItems.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    <div className="text-[11px] font-semibold text-gray-500 uppercase">Actionable Checklist:</div>
                    <div className="space-y-1">
                      {response.data.actionableItems.map((item, idx) => (
                        <div key={idx} className="flex items-center gap-2 text-xs text-gray-700">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                          <span>{item}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Raw JSON viewer */}
              <div className="bg-slate-900 rounded-xl border border-slate-800 p-4 shadow-xs text-slate-200 font-mono text-xs">
                <div className="flex items-center justify-between pb-3 border-b border-slate-800 mb-3">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-emerald-500"></div>
                    <span className="font-semibold text-slate-300">HTTP 200 OK — JSON Response</span>
                  </div>
                  <button
                    onClick={handleCopyJson}
                    className="flex items-center gap-1.5 text-slate-400 hover:text-white text-[11px] bg-slate-800 hover:bg-slate-700 px-2.5 py-1 rounded transition cursor-pointer"
                  >
                    {copiedJson ? (
                      <>
                        <Check className="w-3 h-3 text-emerald-400" />
                        <span className="text-emerald-400">Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-3 h-3" />
                        <span>Copy JSON</span>
                      </>
                    )}
                  </button>
                </div>
                <pre className="overflow-x-auto max-h-80 text-[11px] leading-relaxed scrollbar-thin scrollbar-thumb-slate-700">
                  {JSON.stringify(response, null, 2)}
                </pre>
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-dashed border-gray-300 p-12 text-center shadow-xs">
              <Zap className="w-8 h-8 text-gray-300 mx-auto mb-2" />
              <h4 className="text-sm font-semibold text-gray-700">Ready to Extract</h4>
              <p className="text-xs text-gray-400 mt-1 max-w-sm mx-auto">
                Fill in the payload on the left or select a preset scenario to execute a structured AI extraction.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
