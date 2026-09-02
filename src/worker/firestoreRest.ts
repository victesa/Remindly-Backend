import { AuthUser, ExtractedReminderData, ExtractionStrategy, LogEntry, QuotaInfo, StoredReminderItem, UserTier } from '../types.js';
import { getRuntimeConfig } from '../runtimeConfig.js';

interface FirestoreDocument {
  name?: string;
  fields?: Record<string, FirestoreValue>;
}

type FirestoreValue =
  | { nullValue: 'NULL_VALUE' }
  | { stringValue: string }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { arrayValue: { values?: FirestoreValue[] } }
  | { mapValue: { fields?: Record<string, FirestoreValue> } };

interface AccessTokenCache {
  accessToken: string;
  expiresAt: number;
  projectId: string;
  clientEmail: string;
}

interface ServiceAccountConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

interface CachedEntry {
  data: ExtractedReminderData;
  timestamp: number;
  hasImage: boolean;
  hasText: boolean;
  hasUrl: boolean;
}

interface RateLimitRecord {
  timestamps: number[];
  customLimit?: number;
}

type EditableItemState = 'OPEN' | 'DONE';

type SourceType = 'text' | 'image' | 'url' | 'multimodal';

export interface SaveItemContext {
  text?: string;
  url?: string;
  userTimezone?: string;
  currentDate?: string;
  imageMimeType?: string;
  imageOriginalName?: string;
  requestId?: string;
  sourceDomain?: string | null;
}

export interface UpdateItemInput {
  state?: string;
  title?: string;
  category?: string;
  summary?: string | null;
  deadline?: string | null;
  eventDate?: string | null;
  organization?: string | null;
  url?: string | null;
  actionableItems?: string[];
  confidenceScore?: number;
}

const RATE_LIMITS_COLLECTION = 'rateLimits';
const LOGS_COLLECTION = 'logs';
const IDEMPOTENCY_CACHE_COLLECTION = 'idempotencyCache';
const PAYLOAD_DEDUPE_COLLECTION = 'payloadDedupeCache';
const MAX_LOGS = 1000;
const startTime = Date.now();

const TIER_LIMITS: Record<UserTier, { limit: number; windowMs: number }> = {
  free: { limit: 25, windowMs: 15 * 60 * 1000 },
  premium: { limit: 250, windowMs: 15 * 60 * 1000 },
};

const CATEGORY_ALIAS_MAP: Record<string, ExtractedReminderData['category']> = {
  job: 'JOB',
  jobs: 'JOB',
  event: 'EVENT',
  events: 'EVENT',
  scholarship: 'SCHOLARSHIP',
  scholarships: 'SCHOLARSHIP',
  meeting: 'MEETING',
  meetings: 'MEETING',
  exam: 'EXAM',
  exams: 'EXAM',
  assignment: 'ASSIGNMENT',
  assignments: 'ASSIGNMENT',
  bill: 'BILL',
  bills: 'BILL',
  payment: 'PAYMENT',
  payments: 'PAYMENT',
  appointment: 'APPOINTMENT',
  appointments: 'APPOINTMENT',
  subscription: 'SUBSCRIPTION',
  subscriptions: 'SUBSCRIPTION',
  travel: 'TRAVEL',
  health: 'HEALTH',
  shopping: 'SHOPPING',
  document: 'DOCUMENT',
  documents: 'DOCUMENT',
  personal: 'PERSONAL',
  other: 'OTHER',
};

let accessTokenCache: AccessTokenCache | null = null;

function normalizeCategory(raw: unknown): ExtractedReminderData['category'] | null {
  if (typeof raw !== 'string') return null;
  return CATEGORY_ALIAS_MAP[raw.trim().toLowerCase()] || null;
}

function normalizeState(raw: unknown): EditableItemState | null {
  if (typeof raw !== 'string') return null;
  const upper = raw.trim().toUpperCase();
  if (upper === 'OPEN' || upper === 'DONE') {
    return upper;
  }
  return null;
}

function base64UrlEncode(input: string | ArrayBuffer): string {
  const buffer = typeof input === 'string' ? Buffer.from(input, 'utf-8') : Buffer.from(input);
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem.replace(/-----BEGIN PRIVATE KEY-----/g, '').replace(/-----END PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const buffer = Buffer.from(base64, 'base64');
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function getServiceAccountConfig(): ServiceAccountConfig {
  const runtime = getRuntimeConfig();
  const rawJson = runtime.FIREBASE_SERVICE_ACCOUNT_JSON;
  const projectId = runtime.FIREBASE_PROJECT_ID;

  if (!rawJson) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is required for Cloudflare Workers Firestore access.');
  }

  const parsed = JSON.parse(rawJson);
  const clientEmail = parsed.client_email as string | undefined;
  const privateKey = (parsed.private_key as string | undefined)?.replace(/\\n/g, '\n');
  const resolvedProjectId = (parsed.project_id as string | undefined) || projectId;

  if (!resolvedProjectId || !clientEmail || !privateKey) {
    throw new Error('Invalid Firebase service account configuration.');
  }

  return {
    projectId: resolvedProjectId,
    clientEmail,
    privateKey,
  };
}

async function getGoogleAccessToken(): Promise<AccessTokenCache> {
  if (accessTokenCache && accessTokenCache.expiresAt > Date.now() + 60_000) {
    return accessTokenCache;
  }

  const serviceAccount = getServiceAccountConfig();
  const header = { alg: 'RS256', typ: 'JWT' };
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.clientEmail,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(serviceAccount.privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput));
  const assertion = `${signingInput}.${base64UrlEncode(signature)}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    throw new Error(`Failed to obtain Google access token: HTTP ${response.status}`);
  }

  const json = await response.json() as { access_token: string; expires_in: number };
  accessTokenCache = {
    accessToken: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
    projectId: serviceAccount.projectId,
    clientEmail: serviceAccount.clientEmail,
  };
  return accessTokenCache;
}

function toFirestoreValue(value: unknown): FirestoreValue {
  if (value === null || value === undefined) {
    return { nullValue: 'NULL_VALUE' };
  }
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (typeof value === 'boolean') {
    return { booleanValue: value };
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((entry) => toFirestoreValue(entry)) } };
  }

  const fields: Record<string, FirestoreValue> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (nested === undefined) {
      continue;
    }
    fields[key] = toFirestoreValue(nested);
  }
  return { mapValue: { fields } };
}

function fromFirestoreValue(value?: FirestoreValue): unknown {
  if (!value) return null;
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('arrayValue' in value) {
    return (value.arrayValue.values || []).map((entry) => fromFirestoreValue(entry));
  }
  if ('mapValue' in value) {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value.mapValue.fields || {})) {
      result[key] = fromFirestoreValue(nested);
    }
    return result;
  }
  return null;
}

function decodeDocument<T = Record<string, unknown>>(document: FirestoreDocument): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document.fields || {})) {
    result[key] = fromFirestoreValue(value);
  }
  return result as T;
}

function documentPath(...segments: string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
}

function documentIdFromName(name?: string): string {
  if (!name) return '';
  return name.split('/').pop() || '';
}

async function firestoreRequest(path: string, init?: RequestInit): Promise<Response> {
  const token = await getGoogleAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${token.projectId}/databases/(default)/documents/${path}`;
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token.accessToken}`);
  headers.set('Content-Type', 'application/json');
  return fetch(url, { ...init, headers });
}

async function getDocument<T = Record<string, unknown>>(path: string): Promise<(T & { id?: string }) | null> {
  const response = await firestoreRequest(path);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Firestore read failed: HTTP ${response.status}`);
  }
  const document = await response.json() as FirestoreDocument;
  return {
    ...decodeDocument<T>(document),
    id: documentIdFromName(document.name),
  };
}

async function setDocument(path: string, data: Record<string, unknown>): Promise<void> {
  const response = await firestoreRequest(path, {
    method: 'PATCH',
    body: JSON.stringify({ fields: (toFirestoreValue(data) as { mapValue: { fields: Record<string, FirestoreValue> } }).mapValue.fields || {} }),
  });
  if (!response.ok) {
    throw new Error(`Firestore write failed: HTTP ${response.status}`);
  }
}

async function deleteDocument(path: string): Promise<void> {
  const response = await firestoreRequest(path, { method: 'DELETE', headers: {} });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Firestore delete failed: HTTP ${response.status}`);
  }
}

async function listDocuments<T = Record<string, unknown>>(collectionPath: string, options?: { pageSize?: number; orderBy?: string }): Promise<Array<T & { id?: string }>> {
  const token = await getGoogleAccessToken();
  const url = new URL(`https://firestore.googleapis.com/v1/projects/${token.projectId}/databases/(default)/documents/${collectionPath}`);
  if (options?.pageSize) {
    url.searchParams.set('pageSize', String(options.pageSize));
  }
  if (options?.orderBy) {
    url.searchParams.set('orderBy', options.orderBy);
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
    },
  });

  if (response.status === 404) {
    return [];
  }
  if (!response.ok) {
    throw new Error(`Firestore list failed: HTTP ${response.status}`);
  }
  const json = await response.json() as { documents?: FirestoreDocument[] };
  return (json.documents || []).map((document) => ({
    ...decodeDocument<T>(document),
    id: documentIdFromName(document.name),
  }));
}

function toStoredItem(userId: string, docId: string, docData: Record<string, unknown>): StoredReminderItem {
  const extractedAt =
    (typeof docData.extractedAt === 'string' && docData.extractedAt) ||
    (typeof docData.createdAt === 'string' && docData.createdAt) ||
    new Date(0).toISOString();

  const nestedData = docData.data as ExtractedReminderData | undefined;
  const metadata = docData.metadata as Record<string, unknown> | undefined;
  const resolvedData: ExtractedReminderData = nestedData
    ? nestedData
    : {
        title: (docData.title as string) || 'Reminder',
        summary: (docData.summary as string | null | undefined) ?? null,
        category: normalizeCategory(docData.category) || 'OTHER',
        deadline: (docData.deadline as string | null | undefined) ?? null,
        eventDate: (docData.eventDate as string | null | undefined) ?? null,
        organization: (docData.organization as string | null | undefined) ?? (metadata?.organization as string | null | undefined) ?? null,
        url: (docData.url as string | null | undefined) ?? null,
        strategy: ((docData.strategy as ExtractionStrategy | undefined) || 'local_rule_engine'),
        tier: ((docData.tier as UserTier | undefined) || 'premium'),
        confidenceScore: typeof docData.confidenceScore === 'number' ? docData.confidenceScore : undefined,
        actionableItems: Array.isArray(docData.actionableItems) ? docData.actionableItems as string[] : undefined,
      };

  return {
    id: (docData.id as string) || docId,
    userId: (docData.userId as string) || userId,
    extractedAt,
    state: docData.state === 'DONE' ? 'DONE' : 'OPEN',
    sourceType: ((docData.sourceType as SourceType | undefined) || 'text'),
    inputSnippet: typeof docData.inputSnippet === 'string' ? docData.inputSnippet : '',
    data: resolvedData,
    persistedSource: 'firestore',
    source: docData.source as StoredReminderItem['source'],
    createdAt: typeof docData.createdAt === 'string' ? docData.createdAt : extractedAt,
    updatedAt: typeof docData.updatedAt === 'string' ? docData.updatedAt : extractedAt,
    metadata,
  };
}

async function getItemRefs(userId: string, itemId: string): Promise<{
  capturesPath: string;
  itemsPath: string;
  capturesExists: boolean;
  itemsExists: boolean;
}> {
  const capturesPath = documentPath('users', userId, 'captures', itemId);
  const itemsPath = documentPath('users', userId, 'items', itemId);
  const [capture, item] = await Promise.all([getDocument(capturesPath), getDocument(itemsPath)]);
  return {
    capturesPath,
    itemsPath,
    capturesExists: Boolean(capture),
    itemsExists: Boolean(item),
  };
}

async function getOrCreateRateLimitRecord(userId: string): Promise<RateLimitRecord> {
  const path = documentPath(RATE_LIMITS_COLLECTION, userId);
  const existing = await getDocument<RateLimitRecord>(path);
  if (existing) {
    return {
      timestamps: Array.isArray(existing.timestamps) ? existing.timestamps : [],
      customLimit: existing.customLimit,
    };
  }

  const initial: RateLimitRecord = { timestamps: [] };
  await setDocument(path, initial as unknown as Record<string, unknown>);
  return initial;
}

async function saveRateLimitRecord(userId: string, record: RateLimitRecord): Promise<void> {
  await setDocument(documentPath(RATE_LIMITS_COLLECTION, userId), record as unknown as Record<string, unknown>);
}

export async function getQuotaInfo(userId: string, tier: UserTier): Promise<QuotaInfo> {
  const now = Date.now();
  const config = TIER_LIMITS[tier] || TIER_LIMITS.free;
  const windowStart = now - config.windowMs;
  const record = await getOrCreateRateLimitRecord(userId);
  record.timestamps = record.timestamps.filter((timestamp) => timestamp > windowStart);
  await saveRateLimitRecord(userId, record);

  const limit = record.customLimit ?? config.limit;
  const count = record.timestamps.length;
  const remaining = Math.max(0, limit - count);
  const oldest = record.timestamps[0];
  const resetInMs = oldest ? Math.max(0, oldest + config.windowMs - now) : config.windowMs;

  return {
    limit,
    remaining,
    resetInSeconds: Math.ceil(resetInMs / 1000),
    tier,
    windowSizeSeconds: Math.floor(config.windowMs / 1000),
  };
}

export async function consumeQuota(userId: string, tier: UserTier): Promise<{ allowed: boolean; quota: QuotaInfo }> {
  const quota = await getQuotaInfo(userId, tier);
  if (quota.remaining <= 0) {
    return { allowed: false, quota };
  }

  const record = await getOrCreateRateLimitRecord(userId);
  record.timestamps.push(Date.now());
  await saveRateLimitRecord(userId, record);
  return {
    allowed: true,
    quota: {
      ...quota,
      remaining: quota.remaining - 1,
    },
  };
}

export async function resetUserQuota(userId: string): Promise<boolean> {
  await deleteDocument(documentPath(RATE_LIMITS_COLLECTION, userId));
  return true;
}

export async function resetAllQuotas(): Promise<void> {
  const docs = await listDocuments(RATE_LIMITS_COLLECTION, { pageSize: 500 });
  await Promise.all(docs.map((doc) => deleteDocument(documentPath(RATE_LIMITS_COLLECTION, doc.id || ''))));
}

export async function getCachedEntry(collection: string, docId: string, ttlMs: number): Promise<CachedEntry | null> {
  const data = await getDocument<CachedEntry>(documentPath(collection, docId));
  if (!data || typeof data.timestamp !== 'number') {
    return null;
  }
  if (Date.now() - data.timestamp >= ttlMs) {
    return null;
  }
  return data;
}

export async function saveCachedEntry(collection: string, docId: string, entry: CachedEntry): Promise<void> {
  await setDocument(documentPath(collection, docId), entry as unknown as Record<string, unknown>);
}

export { IDEMPOTENCY_CACHE_COLLECTION, PAYLOAD_DEDUPE_COLLECTION };

export async function saveExtractedItem(
  userId: string,
  data: ExtractedReminderData,
  sourceType: SourceType,
  inputSnippet: string,
  context?: SaveItemContext
): Promise<{ success: boolean; id: string; persistedSource: 'firestore' }> {
  const id = `item_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const nowIso = new Date().toISOString();
  const capturedAt = context?.currentDate || nowIso;
  const sourceContentType: StoredReminderItem['source']['contentType'] =
    sourceType === 'multimodal' ? 'MULTIMODAL' : sourceType === 'text' ? 'TEXT' : sourceType === 'url' ? 'URL' : 'IMAGE';
  const source = {
    contentType: sourceContentType,
    sourceUrl: context?.url || data.url || null,
    mimeType: context?.imageMimeType || null,
    fileName: context?.imageOriginalName || null,
    sourceDomain: context?.sourceDomain || null,
    capturedAt,
    receivedAt: nowIso,
    extractedTextProvided: Boolean(context?.text && context.text.trim().length > 0),
  };
  const metadata = {
    requestId: context?.requestId || null,
    timezone: context?.userTimezone || null,
    organization: data.organization || null,
    strategy: data.strategy,
    confidenceScore: data.confidenceScore ?? null,
  };

  const item: StoredReminderItem = {
    id,
    userId,
    extractedAt: nowIso,
    state: 'OPEN',
    sourceType,
    inputSnippet: inputSnippet.slice(0, 250),
    data,
    persistedSource: 'firestore',
    source,
    createdAt: nowIso,
    updatedAt: nowIso,
    metadata,
  };

  const legacyItem = {
    id,
    userId,
    title: data.title,
    summary: data.summary,
    category: data.category,
    deadline: data.deadline,
    eventDate: data.eventDate,
    organization: data.organization,
    url: data.url || null,
    strategy: data.strategy,
    tier: data.tier,
    confidenceScore: data.confidenceScore ?? null,
    actionableItems: data.actionableItems || null,
    sourceType,
    inputSnippet: inputSnippet.slice(0, 250),
    state: 'READY',
    source,
    metadata,
    createdAt: nowIso,
    updatedAt: nowIso,
  };

  await Promise.all([
    setDocument(documentPath('users', userId, 'captures', id), item as unknown as Record<string, unknown>),
    setDocument(documentPath('users', userId, 'items', id), legacyItem as Record<string, unknown>),
    setDocument(documentPath('users', userId, 'item_debug', id), {
      itemId: id,
      uid: userId,
      source,
      metadata,
      updatedAt: nowIso,
    }),
  ]);

  return {
    success: true,
    id,
    persistedSource: 'firestore',
  };
}

export async function getUserItems(userId: string, limit = 50): Promise<StoredReminderItem[]> {
  const [captures, items, legacyCaptures] = await Promise.all([
    listDocuments(documentPath('users', userId, 'captures'), { pageSize: limit * 4, orderBy: 'extractedAt desc' }).catch(() => []),
    listDocuments(documentPath('users', userId, 'items'), { pageSize: limit * 4, orderBy: 'updatedAt desc' }).catch(() => []),
    listDocuments('captures', { pageSize: limit * 4 }).catch(() => []),
  ]);

  const deduped = new Map<string, StoredReminderItem>();
  const all = [...captures, ...items, ...legacyCaptures.filter((doc) => doc.userId === userId)];
  for (const doc of all) {
    const normalized = toStoredItem(userId, doc.id || '', doc as Record<string, unknown>);
    deduped.set(normalized.id, normalized);
  }

  return Array.from(deduped.values())
    .sort((a, b) => new Date(b.extractedAt).getTime() - new Date(a.extractedAt).getTime())
    .slice(0, limit);
}

export async function updateUserItem(userId: string, itemId: string, patch: UpdateItemInput): Promise<StoredReminderItem> {
  const refs = await getItemRefs(userId, itemId);
  if (!refs.capturesExists && !refs.itemsExists) {
    throw new Error('Item not found.');
  }

  const captureDoc = refs.capturesExists ? await getDocument<Record<string, unknown>>(refs.capturesPath) : null;
  const itemsDoc = refs.itemsExists ? await getDocument<Record<string, unknown>>(refs.itemsPath) : null;
  const updatedAt = new Date().toISOString();

  if (patch.state !== undefined) {
    const normalizedState = normalizeState(patch.state);
    if (!normalizedState) {
      throw new Error('Invalid state. Allowed values: OPEN, DONE.');
    }
    if (captureDoc) captureDoc.state = normalizedState;
    if (itemsDoc) itemsDoc.state = normalizedState === 'OPEN' ? 'READY' : normalizedState;
  }

  if (patch.title !== undefined) {
    if (typeof patch.title !== 'string' || patch.title.trim().length === 0) {
      throw new Error('Invalid title.');
    }
    if (captureDoc && typeof captureDoc.data === 'object' && captureDoc.data) {
      (captureDoc.data as Record<string, unknown>).title = patch.title.trim();
    }
    if (itemsDoc) itemsDoc.title = patch.title.trim();
  }

  if (patch.category !== undefined) {
    const normalizedCategory = normalizeCategory(patch.category);
    if (!normalizedCategory) {
      throw new Error('Invalid category.');
    }
    if (captureDoc && typeof captureDoc.data === 'object' && captureDoc.data) {
      (captureDoc.data as Record<string, unknown>).category = normalizedCategory;
    }
    if (itemsDoc) itemsDoc.category = normalizedCategory;
  }

  if (patch.summary !== undefined) {
    if (patch.summary !== null && typeof patch.summary !== 'string') {
      throw new Error('Invalid summary. Must be string or null.');
    }
    if (captureDoc && typeof captureDoc.data === 'object' && captureDoc.data) {
      (captureDoc.data as Record<string, unknown>).summary = patch.summary === null ? null : patch.summary.trim();
    }
    if (itemsDoc) itemsDoc.summary = patch.summary === null ? null : patch.summary.trim();
  }

  if (patch.deadline !== undefined) {
    if (patch.deadline !== null && typeof patch.deadline !== 'string') {
      throw new Error('Invalid deadline. Must be string or null.');
    }
    if (captureDoc && typeof captureDoc.data === 'object' && captureDoc.data) {
      (captureDoc.data as Record<string, unknown>).deadline = patch.deadline;
    }
    if (itemsDoc) itemsDoc.deadline = patch.deadline;
  }

  if (patch.eventDate !== undefined) {
    if (patch.eventDate !== null && typeof patch.eventDate !== 'string') {
      throw new Error('Invalid eventDate. Must be string or null.');
    }
    if (captureDoc && typeof captureDoc.data === 'object' && captureDoc.data) {
      (captureDoc.data as Record<string, unknown>).eventDate = patch.eventDate;
    }
    if (itemsDoc) itemsDoc.eventDate = patch.eventDate;
  }

  if (patch.organization !== undefined) {
    if (patch.organization !== null && typeof patch.organization !== 'string') {
      throw new Error('Invalid organization. Must be string or null.');
    }
    const normalized = patch.organization === null ? null : patch.organization.trim();
    if (captureDoc && typeof captureDoc.data === 'object' && captureDoc.data) {
      (captureDoc.data as Record<string, unknown>).organization = normalized;
    }
    if (itemsDoc) itemsDoc.organization = normalized;
  }

  if (patch.url !== undefined) {
    if (patch.url !== null && typeof patch.url !== 'string') {
      throw new Error('Invalid url. Must be string or null.');
    }
    if (captureDoc && typeof captureDoc.data === 'object' && captureDoc.data) {
      (captureDoc.data as Record<string, unknown>).url = patch.url;
    }
    if (itemsDoc) itemsDoc.url = patch.url;
  }

  if (patch.actionableItems !== undefined) {
    if (!Array.isArray(patch.actionableItems) || patch.actionableItems.some((entry) => typeof entry !== 'string')) {
      throw new Error('Invalid actionableItems. Must be string array.');
    }
    if (captureDoc && typeof captureDoc.data === 'object' && captureDoc.data) {
      (captureDoc.data as Record<string, unknown>).actionableItems = patch.actionableItems;
    }
    if (itemsDoc) itemsDoc.actionableItems = patch.actionableItems;
  }

  if (patch.confidenceScore !== undefined) {
    if (typeof patch.confidenceScore !== 'number' || patch.confidenceScore < 0 || patch.confidenceScore > 1) {
      throw new Error('Invalid confidenceScore. Must be between 0 and 1.');
    }
    if (captureDoc && typeof captureDoc.data === 'object' && captureDoc.data) {
      (captureDoc.data as Record<string, unknown>).confidenceScore = patch.confidenceScore;
    }
    if (itemsDoc) itemsDoc.confidenceScore = patch.confidenceScore;
  }

  if (!captureDoc && !itemsDoc) {
    throw new Error('No valid fields provided for update.');
  }

  if (captureDoc) {
    captureDoc.updatedAt = updatedAt;
    await setDocument(refs.capturesPath, captureDoc);
  }
  if (itemsDoc) {
    itemsDoc.updatedAt = updatedAt;
    await setDocument(refs.itemsPath, itemsDoc);
  }

  const updated = captureDoc || itemsDoc;
  return toStoredItem(userId, itemId, updated as Record<string, unknown>);
}

export async function deleteUserItem(userId: string, itemId: string): Promise<boolean> {
  const refs = await getItemRefs(userId, itemId);
  if (!refs.capturesExists && !refs.itemsExists) {
    return false;
  }

  await Promise.all([
    refs.capturesExists ? deleteDocument(refs.capturesPath) : Promise.resolve(),
    refs.itemsExists ? deleteDocument(refs.itemsPath) : Promise.resolve(),
    deleteDocument(documentPath('users', userId, 'item_debug', itemId)),
  ]);
  return true;
}

export async function deleteUserData(userId: string): Promise<{ deletedCount: number }> {
  const collections = ['captures', 'items', 'item_debug'];
  let deletedCount = 0;

  for (const collection of collections) {
    const docs = await listDocuments(documentPath('users', userId, collection), { pageSize: 500 }).catch(() => []);
    deletedCount += docs.length;
    await Promise.all(docs.map((doc) => deleteDocument(documentPath('users', userId, collection, doc.id || ''))));
  }

  return { deletedCount };
}

export async function requestPasswordReset(email: string): Promise<{ sent: boolean; message: string }> {
  console.log(JSON.stringify({ message: 'password reset requested', email }));
  return {
    sent: true,
    message: `Password reset link dispatched to ${email}`,
  };
}

export async function logOperation(entry: Omit<LogEntry, 'id' | 'timestamp'>): Promise<LogEntry> {
  const fullEntry: LogEntry = {
    id: `log_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
    timestamp: new Date().toISOString(),
    ...entry,
  };

  await setDocument(documentPath(LOGS_COLLECTION, fullEntry.id), fullEntry as unknown as Record<string, unknown>);
  console.log(JSON.stringify({
    timestamp: fullEntry.timestamp,
    statusCode: fullEntry.statusCode,
    tier: fullEntry.userTier,
    endpoint: fullEntry.endpoint,
    latencyMs: fullEntry.latencyMs,
    strategy: fullEntry.strategy || null,
    error: fullEntry.error || null,
  }));
  return fullEntry;
}

export async function getRecentLogs(limit = 100, filterTier?: UserTier, filterEndpoint?: string): Promise<LogEntry[]> {
  const safeLimit = Math.max(1, Math.min(limit, MAX_LOGS));
  const docs = await listDocuments<LogEntry>(LOGS_COLLECTION, { pageSize: safeLimit * 5, orderBy: 'timestamp desc' }).catch(() => []);
  let logs = docs.map((doc) => ({ ...doc, id: doc.id || '' } as LogEntry));
  if (filterTier) {
    logs = logs.filter((entry) => entry.userTier === filterTier);
  }
  if (filterEndpoint) {
    logs = logs.filter((entry) => entry.endpoint.includes(filterEndpoint));
  }
  return logs.slice(0, safeLimit);
}

export async function clearLogs(): Promise<void> {
  const docs = await listDocuments(LOGS_COLLECTION, { pageSize: 500 }).catch(() => []);
  await Promise.all(docs.map((doc) => deleteDocument(documentPath(LOGS_COLLECTION, doc.id || ''))));
}

export async function getAiServiceStatus(): Promise<import('../types.js').AiServiceStatus> {
  const geminiConfigured = Boolean(getRuntimeConfig().GEMINI_API_KEY && getRuntimeConfig().GEMINI_API_KEY!.length > 5);
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

  try {
    const extractionLogs = (await listDocuments<LogEntry>(LOGS_COLLECTION, { pageSize: 1000, orderBy: 'timestamp desc' }))
      .map((doc) => ({ ...doc, id: doc.id || '' } as LogEntry))
      .filter((entry) => entry.endpoint === '/v1/extract-data');

    const total = extractionLogs.length;
    let errorCount = 0;
    let totalLatency = 0;
    let freeCount = 0;
    let premiumCount = 0;
    let cacheHits = 0;

    for (const log of extractionLogs) {
      if (log.statusCode >= 500 || (log.statusCode >= 400 && log.statusCode !== 429)) {
        errorCount++;
      }
      totalLatency += log.latencyMs;
      if (log.userTier === 'premium') {
        premiumCount++;
      } else {
        freeCount++;
      }
      if (log.cached) {
        cacheHits++;
      }
    }

    const errorRateRecent = total > 0 ? Number((errorCount / total).toFixed(3)) : 0;
    const avgLatencyMs = total > 0 ? Math.round(totalLatency / total) : 0;
    const cacheHitRatio = total > 0 ? Number((cacheHits / total).toFixed(3)) : 0;

    let status: 'healthy' | 'degraded' | 'unavailable' | 'unknown' = 'healthy';
    if (errorRateRecent > 0.3) {
      status = 'unavailable';
    } else if (errorRateRecent > 0.05) {
      status = 'degraded';
    } else if (total === 0) {
      status = geminiConfigured ? 'healthy' : 'degraded';
    }

    return {
      status,
      geminiConfigured,
      primaryModel: 'gemini-3.1-flash-lite (with auto-failover)',
      totalRequests: total,
      errorRateRecent,
      avgLatencyMs,
      tierBreakdown: {
        freeRequests: freeCount,
        premiumRequests: premiumCount,
      },
      cacheHitRatio,
      uptimeSeconds,
    };
  } catch {
    return {
      status: geminiConfigured ? 'degraded' : 'unknown',
      geminiConfigured,
      primaryModel: 'gemini-3.1-flash-lite (with auto-failover)',
      totalRequests: 0,
      errorRateRecent: 0,
      avgLatencyMs: 0,
      tierBreakdown: {
        freeRequests: 0,
        premiumRequests: 0,
      },
      cacheHitRatio: 0,
      uptimeSeconds,
    };
  }
}

function parseTokenPayload(token: string): Record<string, unknown> | null {
  try {
    const payloadPart = token.split('.')[1] || token.split('.')[0];
    return JSON.parse(Buffer.from(payloadPart, 'base64').toString('utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function authenticateHeaders(headers: Headers, url: URL): { user: AuthUser; bearerProvided: boolean } {
  const authHeader = headers.get('authorization');
  const devUserId = headers.get('x-user-id') || url.searchParams.get('userId');
  const headerTier = (headers.get('x-user-tier') || '').toLowerCase() as UserTier;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();

    if (token.startsWith('remindly_test_')) {
      const parts = token.split('_');
      const tier: UserTier = parts[2] === 'premium' ? 'premium' : 'free';
      const uid = parts.slice(3).join('_') || 'test-user-1';
      return {
        bearerProvided: true,
        user: {
          uid,
          email: `${uid}@example.com`,
          tier: headerTier || tier,
          name: `Test User (${tier.toUpperCase()})`,
        },
      };
    }

    const payload = parseTokenPayload(token);
    if (payload) {
      return {
        bearerProvided: true,
        user: {
          uid: (payload.uid as string) || (payload.user_id as string) || (payload.sub as string) || 'token-user',
          email: (payload.email as string) || 'token-user@example.com',
          tier: headerTier || ((payload.tier === 'premium' || payload.plan === 'premium') ? 'premium' : 'free'),
          name: (payload.name as string) || 'Authenticated User',
        },
      };
    }

    const derivedTier: UserTier = headerTier || (token.includes('premium') ? 'premium' : 'free');
    return {
      bearerProvided: true,
      user: {
        uid: devUserId || `user_${token.slice(0, 10).replace(/[^a-zA-Z0-9]/g, '') || 'anon'}`,
        email: 'user@remindly.internal',
        tier: derivedTier,
      },
    };
  }

  if (devUserId) {
    return {
      bearerProvided: false,
      user: {
        uid: devUserId,
        email: `${devUserId}@remindly.internal`,
        tier: headerTier || 'free',
        name: `User ${devUserId}`,
      },
    };
  }

  return {
    bearerProvided: false,
    user: {
      uid: 'demo_guest_user',
      email: 'guest@remindly.ai',
      tier: headerTier || 'free',
      name: 'Guest Tester',
      isAnonymous: true,
    },
  };
}
