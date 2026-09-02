export type UserTier = 'free' | 'premium';

export type ReminderCategory =
  | 'JOB'
  | 'EVENT'
  | 'SCHOLARSHIP'
  | 'MEETING'
  | 'EXAM'
  | 'ASSIGNMENT'
  | 'BILL'
  | 'PAYMENT'
  | 'APPOINTMENT'
  | 'SUBSCRIPTION'
  | 'TRAVEL'
  | 'HEALTH'
  | 'SHOPPING'
  | 'DOCUMENT'
  | 'PERSONAL'
  | 'OTHER';

export type ExtractionStrategy = 'gemini_cloud_ai' | 'gemini_flash_lite' | 'local_rule_engine' | 'cached_response';

export interface ExtractedReminderData {
  title: string;
  summary: string | null;
  category: ReminderCategory;
  deadline: string | null; // ISO UTC string
  eventDate: string | null; // ISO UTC string
  organization: string | null;
  url?: string | null;
  strategy: ExtractionStrategy;
  tier: UserTier;
  confidenceScore?: number; // 0.0 to 1.0
  actionableItems?: string[];
}

export interface QuotaInfo {
  limit: number;
  remaining: number;
  resetInSeconds: number;
  tier: UserTier;
  windowSizeSeconds: number;
}

export interface ExtractionMetadata {
  requestId: string;
  processingTimeMs: number;
  hasImage: boolean;
  hasText: boolean;
  hasUrl: boolean;
  userId: string;
  userTier: UserTier;
  cached: boolean;
  persistedToFirebase: boolean;
  idempotencyKey?: string | null;
}

export interface ExtractionResponse {
  success: boolean;
  data: ExtractedReminderData;
  quota: QuotaInfo;
  metadata: ExtractionMetadata;
  error?: string;
}

export interface LogEntry {
  id: string;
  timestamp: string;
  requestId: string;
  userId: string;
  userTier: UserTier;
  endpoint: string;
  method: string;
  statusCode: number;
  latencyMs: number;
  strategy?: ExtractionStrategy;
  hasText: boolean;
  hasImage: boolean;
  hasUrl: boolean;
  cached: boolean;
  error?: string;
  categoryExtracted?: ReminderCategory;
  titleExtracted?: string;
}

export interface StoredReminderItem {
  id: string;
  userId: string;
  extractedAt: string;
  state: 'OPEN' | 'DONE';
  sourceType: 'text' | 'image' | 'url' | 'multimodal';
  inputSnippet: string;
  data: ExtractedReminderData;
  persistedSource: 'firestore' | 'memory';
  source?: {
    contentType: 'TEXT' | 'URL' | 'IMAGE' | 'MULTIMODAL';
    sourceUrl?: string | null;
    mimeType?: string | null;
    fileName?: string | null;
    sourceDomain?: string | null;
    capturedAt: string;
    receivedAt: string;
    extractedTextProvided: boolean;
    sourceContentFetched?: boolean;
  };
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface AiServiceStatus {
  status: 'healthy' | 'degraded' | 'unavailable' | 'unknown';
  geminiConfigured: boolean;
  primaryModel: string;
  totalRequests: number;
  errorRateRecent: number;
  avgLatencyMs: number;
  tierBreakdown: {
    freeRequests: number;
    premiumRequests: number;
  };
  cacheHitRatio: number;
  uptimeSeconds: number;
}

export interface AuthUser {
  uid: string;
  email: string;
  tier: UserTier;
  name?: string;
  isAnonymous?: boolean;
}
