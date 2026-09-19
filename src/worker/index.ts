import { createHash } from 'crypto';
import { extractWithGemini } from '../server/geminiExtractor.js';
import { extractUrls, fetchUrlContent, hasSufficientTextDetail } from '../server/urlFetcher.js';
import { getRuntimeConfig, setRuntimeConfig, type RuntimeConfig } from '../runtimeConfig.js';
import { ExtractedReminderData, ExtractionResponse, QuotaInfo, StoredReminderItem, SubscriptionEntitlement, UserTier } from '../types.js';
import {
  IDEMPOTENCY_CACHE_COLLECTION,
  PAYLOAD_DEDUPE_COLLECTION,
  clearLogs,
  consumeQuota,
  deleteUserData,
  deleteUserItem,
  getAiServiceStatus,
  getAnalyticsSummary,
  getCachedEntry,
  getQuotaInfo,
  getRecentLogs,
  getUserEntitlement,
  getUserIdForPurchaseToken,
  getUserItemsDelta,
  getUserItems,
  isEntitlementActive,
  logOperation,
  mapPurchaseTokenToUser,
  requestPasswordReset,
  resetAllQuotas,
  resetUserQuota,
  saveCachedEntry,
  saveExtractedItem,
  saveUserEntitlement,
  updateUserItem,
} from './firestoreRest.js';
import { decodeRtdnMessage, verifyGooglePlaySubscription } from './googlePlay.js';
import { verifyPubSubOidcToken } from './pubsubAuth.js';
import { verifyFirebaseIdToken } from './firebaseAuth.js';

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

interface WorkerEnv extends RuntimeConfig {
  ASSETS?: AssetsBinding;
}

interface WorkerExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

interface ExtractionImage {
  buffer: Buffer;
  mimeType: string;
  originalName?: string;
}

interface CachedEntry {
  data: ExtractedReminderData;
  timestamp: number;
  hasImage: boolean;
  hasText: boolean;
  hasUrl: boolean;
  clientSource: string | null;
}

const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;
const PAYLOAD_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/jpg']);
const inFlightRequests = new Map<string, Promise<ExtractedReminderData>>();

function corsHeaders(): Headers {
  return new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key, X-User-Tier, X-User-Id, X-Client-Date, X-User-Timezone, X-Analytics-Key, X-Tunnel-Skip-Anti-Phishing-Page',
  });
}

function withCors(response: Response): Response {
  const headers = corsHeaders();
  response.headers.forEach((value, key) => headers.set(key, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(payload: unknown, init?: ResponseInit): Response {
  return withCors(Response.json(payload, init));
}

function createRequestId(): string {
  return `req_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

function mintDevToken(tier: UserTier = 'free', userId?: string): { token: string; user: { uid: string; email: string; tier: UserTier; name: string } } {
  const uid = userId || `user_${crypto.randomUUID().slice(0, 8)}`;
  return {
    token: `remindly_test_${tier}_${uid}`,
    user: {
      uid,
      email: `${uid}@example.com`,
      tier,
      name: `${tier.toUpperCase()} Tester`,
    },
  };
}

function computePayloadHash(
  userId: string,
  userTier: UserTier,
  text?: string,
  url?: string,
  clientSource?: string,
  imageBuffer?: Buffer,
): string {
  const hash = createHash('sha256');
  hash.update(`${userId}:`);
  hash.update(`${userTier}:`);
  hash.update(text ? text.trim().toLowerCase() : '');
  hash.update(url ? url.trim().toLowerCase() : '');
  hash.update(clientSource ? clientSource.trim().toLowerCase() : '');
  if (imageBuffer && imageBuffer.length > 0) {
    hash.update(imageBuffer.slice(0, 2048));
  }
  return hash.digest('hex');
}

async function parseExtractionRequest(request: Request): Promise<{
  text?: string;
  url?: string;
  clientSource?: string;
  idempotencyKey?: string | null;
  currentDate?: string;
  userTimezone?: string;
  image: ExtractionImage | null;
}> {
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData();
    const fileEntry = formData.get('image');
    let image: ExtractionImage | null = null;

    if (fileEntry instanceof File) {
      if (!ALLOWED_MIME_TYPES.has(fileEntry.type)) {
        throw new Error(`Unsupported file type: ${fileEntry.type}. Allowed: JPEG, PNG, WEBP, GIF`);
      }
      if (fileEntry.size > MAX_UPLOAD_BYTES) {
        throw new Error(`Upload error: File too large. Max 10MB allowed.`);
      }
      image = {
        buffer: Buffer.from(await fileEntry.arrayBuffer()),
        mimeType: fileEntry.type,
        originalName: fileEntry.name,
      };
    }

    return {
      text: (formData.get('text') as string | null) || undefined,
      url: (formData.get('url') as string | null) || undefined,
      clientSource: (formData.get('source') as string | null)?.trim() || undefined,
      idempotencyKey: ((request.headers.get('idempotency-key')) || (formData.get('idempotencyKey') as string | null)) || null,
      currentDate: (formData.get('currentDate') as string | null) || request.headers.get('x-client-date') || undefined,
      userTimezone: request.headers.get('x-user-timezone') || (formData.get('timezone') as string | null) || (formData.get('userTimezone') as string | null) || undefined,
      image,
    };
  }

  const body = (request.method === 'GET' ? {} : await request.json().catch(() => ({}))) as Record<string, unknown>;
  return {
    text: typeof body.text === 'string' ? body.text : undefined,
    url: typeof body.url === 'string' ? body.url : undefined,
    clientSource: typeof body.source === 'string' ? body.source.trim() || undefined : undefined,
    idempotencyKey: (request.headers.get('idempotency-key') || (typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null)),
    currentDate: (typeof body.currentDate === 'string' ? body.currentDate : request.headers.get('x-client-date') || undefined),
    userTimezone: request.headers.get('x-user-timezone') || (typeof body.timezone === 'string' ? body.timezone : typeof body.userTimezone === 'string' ? body.userTimezone : undefined),
    image: null,
  };
}

async function processExtraction(options: {
  userId: string;
  userTier: UserTier;
  text?: string;
  url?: string;
  image: ExtractionImage | null;
  idempotencyKey?: string | null;
  quota: QuotaInfo;
  requestId: string;
  currentDate?: string;
  userTimezone?: string;
  clientSource?: string;
}): Promise<ExtractionResponse> {
  const startTime = Date.now();
  const { userId, userTier, text, image, idempotencyKey, quota, requestId } = options;

  let explicitUrl = options.url?.trim();
  const rawText = text?.trim() || '';
  const detectedUrls = extractUrls(rawText);
  if (!explicitUrl && detectedUrls.length > 0) {
    explicitUrl = detectedUrls[0];
  }

  const hasText = rawText.length > 0;
  const hasImage = Boolean(image && image.buffer.length > 0);
  const hasUrl = Boolean(explicitUrl);

  const persistPremiumCapture = async (payload: ExtractedReminderData): Promise<boolean> => {
    if (userTier !== 'premium') {
      return false;
    }

    const sourceType = hasImage && hasText ? 'multimodal' : hasImage ? 'image' : hasUrl ? 'url' : 'text';
    const inputSnippet = rawText || explicitUrl || image?.originalName || 'Reminder input';
    let sourceDomain: string | null = null;
    if (explicitUrl) {
      try {
        sourceDomain = new URL(explicitUrl).hostname.replace(/^www\./, '');
      } catch {
        sourceDomain = null;
      }
    }

    const saved = await saveExtractedItem(userId, payload, sourceType, inputSnippet, {
      text: rawText || undefined,
      url: explicitUrl,
      clientSource: options.clientSource || null,
      userTimezone: options.userTimezone,
      currentDate: options.currentDate,
      imageMimeType: image?.mimeType,
      imageOriginalName: image?.originalName,
      requestId,
      sourceDomain,
    });
    return saved.persistedSource === 'firestore';
  };

  if (!hasText && !hasImage && !hasUrl) {
    throw new Error('Invalid input: At least one of text, image, or URL must be provided.');
  }

  const idempKey = idempotencyKey ? `${userId}:${idempotencyKey}` : null;
  if (idempKey) {
    const cached = await getCachedEntry(IDEMPOTENCY_CACHE_COLLECTION, idempKey, IDEMPOTENCY_TTL_MS);
    if (cached) {
      return {
        success: true,
        data: { ...cached.data, strategy: 'cached_response' },
        quota,
        metadata: {
          requestId,
          processingTimeMs: Date.now() - startTime,
          hasImage: cached.hasImage,
          hasText: cached.hasText,
          hasUrl: cached.hasUrl,
          clientSource: cached.clientSource,
          userId,
          userTier,
          cached: true,
          persistedToFirebase: false,
          idempotencyKey,
        },
      };
    }
  }

  const payloadHash = computePayloadHash(userId, userTier, rawText, explicitUrl, options.clientSource, image?.buffer);
  const cachedPayload = await getCachedEntry(PAYLOAD_DEDUPE_COLLECTION, payloadHash, PAYLOAD_DEDUPE_WINDOW_MS);
  if (cachedPayload) {
    const persistedToFirebase = userTier === 'premium' ? await persistPremiumCapture(cachedPayload.data) : false;
    return {
      success: true,
      data: { ...cachedPayload.data, strategy: 'cached_response' },
      quota,
      metadata: {
        requestId,
        processingTimeMs: Date.now() - startTime,
        hasImage: cachedPayload.hasImage,
        hasText: cachedPayload.hasText,
        hasUrl: cachedPayload.hasUrl,
        clientSource: cachedPayload.clientSource,
        userId,
        userTier,
        cached: true,
        persistedToFirebase,
        idempotencyKey,
      },
    };
  }

  const dedupeKey = idempKey || payloadHash;
  let extractionPromise = inFlightRequests.get(dedupeKey);
  if (!extractionPromise) {
    extractionPromise = (async () => {
      let resolvedUrlContent: Awaited<ReturnType<typeof fetchUrlContent>> | null = null;
      if (explicitUrl) {
        const textDetailed = hasSufficientTextDetail(rawText);
        if (!textDetailed || !hasText) {
          resolvedUrlContent = await fetchUrlContent(explicitUrl);
        } else {
          resolvedUrlContent = {
            url: explicitUrl,
            title: null,
            description: null,
            bodySnippet: `Reference link: ${explicitUrl}`,
            sourceDomain: new URL(explicitUrl).hostname.replace(/^www\./, ''),
            success: true,
          };
        }
      }

      const extracted = await extractWithGemini({
        text: rawText || undefined,
        urlContent: resolvedUrlContent,
        image: image ? { buffer: image.buffer, mimeType: image.mimeType } : null,
        userTier,
        currentDate: options.currentDate,
        userTimezone: options.userTimezone,
      });

      if (explicitUrl && !extracted.url) {
        extracted.url = explicitUrl;
      }

      return extracted;
    })();
    inFlightRequests.set(dedupeKey, extractionPromise);
  }

  let finalData: ExtractedReminderData;
  try {
    finalData = await extractionPromise;
  } finally {
    inFlightRequests.delete(dedupeKey);
  }

  const cacheEntry: CachedEntry = {
    data: finalData,
    timestamp: Date.now(),
    hasImage,
    hasText,
    hasUrl,
    clientSource: options.clientSource || null,
  };
  if (idempKey) {
    await saveCachedEntry(IDEMPOTENCY_CACHE_COLLECTION, idempKey, cacheEntry);
  }
  await saveCachedEntry(PAYLOAD_DEDUPE_COLLECTION, payloadHash, cacheEntry);

  let persistedToFirebase = false;
  if (userTier === 'premium') {
    persistedToFirebase = await persistPremiumCapture(finalData);
    if (!persistedToFirebase) {
      throw new Error('Capture was not persisted to Firestore for premium user.');
    }
  }

  return {
    success: true,
    data: finalData,
    quota,
    metadata: {
      requestId,
      processingTimeMs: Date.now() - startTime,
      hasImage,
      hasText,
      hasUrl,
      userId,
      userTier,
      cached: false,
      persistedToFirebase,
      idempotencyKey: idempotencyKey || null,
    },
  };
}

function setRateLimitHeaders(headers: Headers, quota: QuotaInfo, tier: UserTier): void {
  headers.set('X-RateLimit-Limit', quota.limit.toString());
  headers.set('X-RateLimit-Remaining', quota.remaining.toString());
  headers.set('X-RateLimit-Reset', quota.resetInSeconds.toString());
  headers.set('X-RateLimit-Tier', tier);
}

function toSyncItem(item: StoredReminderItem): Record<string, unknown> {
  return {
    id: item.id,
    userId: item.userId,
    title: item.data.title,
    summary: item.data.summary,
    category: item.data.category,
    deadline: item.data.deadline,
    eventDate: item.data.eventDate,
    organization: item.data.organization,
    source: item.source?.clientSource || null,
    sourceUrl: item.source?.sourceUrl || item.data.url || null,
    state: item.state === 'OPEN' ? 'READY' : 'DONE',
    checklist: item.data.actionableItems || [],
    createdAt: item.createdAt || item.extractedAt,
    updatedAt: item.updatedAt || item.extractedAt,
  };
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: WorkerExecutionContext): Promise<Response> {
    setRuntimeConfig(env);

    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: 204, headers: corsHeaders() }));
    }

    const url = new URL(request.url);
    const pathname = url.pathname;
    const requestId = createRequestId();

    try {
      if (pathname === '/v1/health' || pathname === '/api/health') {
        return jsonResponse({
          status: 'ok',
          service: 'Remindly AI Backend Proxy',
          version: '1.2.0',
          timestamp: new Date().toISOString(),
        });
      }

      if (pathname === '/v1/ai-status' && request.method === 'GET') {
        if (!env.ANALYTICS_ADMIN_KEY || request.headers.get('x-analytics-key') !== env.ANALYTICS_ADMIN_KEY) {
          return jsonResponse({ success: false, error: 'Admin access is unauthorized.' }, { status: 401 });
        }
        return jsonResponse({ success: true, data: await getAiServiceStatus() });
      }

      if (pathname === '/v1/analytics/summary' && request.method === 'GET') {
        if (!env.ANALYTICS_ADMIN_KEY || request.headers.get('x-analytics-key') !== env.ANALYTICS_ADMIN_KEY) {
          return jsonResponse({ success: false, error: 'Analytics access is unauthorized.' }, { status: 401 });
        }
        const since = url.searchParams.get('since')?.trim() || undefined;
        if (since && Number.isNaN(Date.parse(since))) {
          return jsonResponse({ success: false, error: 'Invalid since timestamp. Use an ISO 8601 timestamp.' }, { status: 400 });
        }
        return jsonResponse({ success: true, data: await getAnalyticsSummary(since) });
      }

      if (pathname === '/v1/auth/mint-token' && request.method === 'POST') {
        if (getRuntimeConfig().ALLOW_DEV_AUTH !== 'true') {
          return jsonResponse({ success: false, error: 'Not found.' }, { status: 404 });
        }
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const tier: UserTier = body.tier === 'premium' ? 'premium' : 'free';
        const userId = typeof body.userId === 'string' ? body.userId : undefined;
        const minted = mintDevToken(tier, userId);
        return jsonResponse({
          success: true,
          token: minted.token,
          user: minted.user,
          instructions: `Pass as header 'Authorization: Bearer ${minted.token}' or 'X-User-Tier: ${tier}'`,
        });
      }

      if (pathname === '/v1/billing/rtdn' && request.method === 'POST') {
        if (env.RTDN_EXPECTED_AUDIENCE) {
          try {
            await verifyPubSubOidcToken(request.headers.get('authorization'), {
              expectedAudience: env.RTDN_EXPECTED_AUDIENCE,
              expectedServiceAccountEmail: env.RTDN_EXPECTED_SERVICE_ACCOUNT_EMAIL,
            });
          } catch (error) {
            return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Pub/Sub token verification failed.' }, { status: 401 });
          }
        } else if (env.RTDN_WEBHOOK_TOKEN) {
          const providedToken = url.searchParams.get('token') || request.headers.get('x-rtdn-token');
          if (providedToken !== env.RTDN_WEBHOOK_TOKEN) {
            return jsonResponse({ success: false, error: 'Unauthorized RTDN webhook call.' }, { status: 401 });
          }
        } else {
          return jsonResponse({ success: false, error: 'RTDN authentication is not configured.' }, { status: 503 });
        }

        const pushBody = await request.json().catch(() => null) as { message?: { data?: string } } | null;
        const rawData = pushBody?.message?.data;
        if (!rawData) {
          // Acknowledge malformed/validation pushes so Pub/Sub does not retry indefinitely.
          return jsonResponse({ success: true, ignored: true });
        }

        let rtdnStage = 'decode';
        try {
          const notification = decodeRtdnMessage(rawData);
          const subNotification = notification.subscriptionNotification;
          if (!subNotification) {
            return jsonResponse({ success: true, ignored: true });
          }

          rtdnStage = 'purchase-token-mapping';
          const mappedUserId = await getUserIdForPurchaseToken(subNotification.purchaseToken);
          if (!mappedUserId) {
            ctx.waitUntil(logOperation({
              requestId,
              userId: 'system',
              userTier: 'free',
              endpoint: '/v1/billing/rtdn',
              method: 'POST',
              statusCode: 200,
              latencyMs: 0,
              hasText: false,
              hasImage: false,
              hasUrl: false,
              cached: false,
              error: `No user mapping for purchaseToken (notificationType=${subNotification.notificationType}).`,
            }));
            return jsonResponse({ success: true, ignored: true });
          }

          rtdnStage = 'google-play-verification';
          const verification = await verifyGooglePlaySubscription(subNotification.purchaseToken, subNotification.subscriptionId);
          const entitlement: SubscriptionEntitlement = {
            userId: mappedUserId,
            tier: verification.isEntitled ? 'premium' : 'free',
            productId: verification.productId,
            purchaseToken: verification.purchaseToken,
            orderId: verification.orderId,
            status: verification.status,
            autoRenewing: verification.autoRenewing,
            expiryTimeMillis: verification.expiryTimeMillis,
            startTimeMillis: verification.startTimeMillis,
            source: 'google_play',
            updatedAt: new Date().toISOString(),
          };
          rtdnStage = 'entitlement-storage';
          await saveUserEntitlement(entitlement);
          return jsonResponse({ success: true });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'RTDN processing failed.';
          console.error(JSON.stringify({
            event: 'rtdn_processing_failed',
            stage: rtdnStage,
            error: errorMessage,
            requestId,
          }));
          return jsonResponse({ success: false, error: errorMessage, stage: rtdnStage, requestId }, { status: 500 });
        }
      }

      let user;
      try {
        user = await verifyFirebaseIdToken(request.headers.get('authorization'));
      } catch (error) {
        return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Authentication failed.' }, { status: 401 });
      }

      try {
        const entitlement = await getUserEntitlement(user.uid);
        user = { ...user, tier: isEntitlementActive(entitlement) ? 'premium' : 'free' as UserTier };
      } catch {
        return jsonResponse({ success: false, error: 'Authentication service unavailable.' }, { status: 503 });
      }

      const auth = { bearerProvided: true };

      if (pathname === '/v1/quota' && request.method === 'GET') {
        const quota = await getQuotaInfo(user.uid, user.tier);
        return jsonResponse({ success: true, quota, user });
      }

      if (pathname === '/v1/quota/reset' && request.method === 'POST') {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const resetAll = body.all === true;
        if (resetAll) {
          if (!env.ANALYTICS_ADMIN_KEY || request.headers.get('x-analytics-key') !== env.ANALYTICS_ADMIN_KEY) {
            return jsonResponse({ success: false, error: 'Admin access is unauthorized.' }, { status: 401 });
          }
          await resetAllQuotas();
        } else {
          await resetUserQuota(user.uid);
        }
        return jsonResponse({ success: true, message: resetAll ? 'All quotas reset' : `Quota reset for user ${user.uid}` });
      }

      if (pathname === '/v1/billing/verify-purchase' && request.method === 'POST') {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const purchaseToken = typeof body.purchaseToken === 'string' ? body.purchaseToken.trim() : '';
        const productId = typeof body.productId === 'string' ? body.productId.trim() : undefined;
        if (!purchaseToken) {
          return jsonResponse({ success: false, error: 'purchaseToken is required.' }, { status: 400 });
        }

        try {
          const verification = await verifyGooglePlaySubscription(purchaseToken, productId);
          const entitlement: SubscriptionEntitlement = {
            userId: user.uid,
            tier: verification.isEntitled ? 'premium' : 'free',
            productId: verification.productId,
            purchaseToken: verification.purchaseToken,
            orderId: verification.orderId,
            status: verification.status,
            autoRenewing: verification.autoRenewing,
            expiryTimeMillis: verification.expiryTimeMillis,
            startTimeMillis: verification.startTimeMillis,
            source: 'google_play',
            updatedAt: new Date().toISOString(),
          };
          await Promise.all([
            saveUserEntitlement(entitlement),
            mapPurchaseTokenToUser(purchaseToken, user.uid, verification.productId),
          ]);
          return jsonResponse({ success: true, entitlement });
        } catch (error) {
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Purchase verification failed.' }, { status: 502 });
        }
      }

      if (pathname === '/v1/billing/entitlement' && request.method === 'GET') {
        const entitlement = await getUserEntitlement(user.uid).catch(() => null);
        return jsonResponse({ success: true, userId: user.uid, tier: user.tier, entitlement });
      }

      if (pathname === '/v1/logs' && request.method === 'GET') {
        if (!env.ANALYTICS_ADMIN_KEY || request.headers.get('x-analytics-key') !== env.ANALYTICS_ADMIN_KEY) {
          return jsonResponse({ success: false, error: 'Admin access is unauthorized.' }, { status: 401 });
        }
        const limit = Number.parseInt(url.searchParams.get('limit') || '100', 10) || 100;
        const tier = (url.searchParams.get('tier') || undefined) as UserTier | undefined;
        const endpoint = url.searchParams.get('endpoint') || undefined;
        const logs = await getRecentLogs(limit, tier, endpoint);
        return jsonResponse({ success: true, count: logs.length, logs });
      }

      if (pathname === '/v1/logs/clear' && request.method === 'POST') {
        if (!env.ANALYTICS_ADMIN_KEY || request.headers.get('x-analytics-key') !== env.ANALYTICS_ADMIN_KEY) {
          return jsonResponse({ success: false, error: 'Admin access is unauthorized.' }, { status: 401 });
        }
        await clearLogs();
        return jsonResponse({ success: true, message: 'Logs cleared' });
      }

      if (pathname === '/v1/items' && request.method === 'GET') {
        if (user.tier !== 'premium') {
          return jsonResponse({ success: false, error: 'Stored captures are available for premium users only.', userId: user.uid, userTier: user.tier }, { status: 403 });
        }
        const limit = Number.parseInt(url.searchParams.get('limit') || '50', 10) || 50;
        const items = await getUserItems(user.uid, limit);
        return jsonResponse({ success: true, userId: user.uid, userTier: user.tier, count: items.length, items });
      }

      if (pathname === '/v1/items/sync' && request.method === 'GET') {
        if (!auth.bearerProvided) {
          return jsonResponse({ success: false, error: 'Authorization: Bearer <token> is required.' }, { status: 401 });
        }
        if (user.tier !== 'premium') {
          return jsonResponse({ success: false, error: 'Stored captures are available for premium users only.', userId: user.uid, userTier: user.tier }, { status: 403 });
        }

        const sinceParam = url.searchParams.get('since')?.trim() || undefined;
        if (sinceParam && Number.isNaN(Date.parse(sinceParam))) {
          return jsonResponse({ success: false, error: 'Invalid since timestamp. Use an ISO 8601 timestamp.' }, { status: 400 });
        }

        const syncTimestamp = new Date().toISOString();
        const delta = await getUserItemsDelta(user.uid, sinceParam);
        return jsonResponse({
          success: true,
          syncTimestamp,
          updatedItems: delta.updatedItems.map(toSyncItem),
          deletedItemIds: delta.deletedItemIds,
        });
      }

      const itemMatch = pathname.match(/^\/v1\/items\/([^/]+)$/);
      if (itemMatch && request.method === 'PATCH') {
        if (!auth.bearerProvided) {
          return jsonResponse({ success: false, error: 'Authorization: Bearer <token> is required.' }, { status: 401 });
        }
        if (user.tier !== 'premium') {
          return jsonResponse({ success: false, error: 'Premium access required for item updates.', userId: user.uid, userTier: user.tier }, { status: 403 });
        }
        const updated = await updateUserItem(user.uid, decodeURIComponent(itemMatch[1]), await request.json().catch(() => ({})) as Record<string, unknown>);
        return jsonResponse(updated);
      }

      if (itemMatch && request.method === 'DELETE') {
        if (!auth.bearerProvided) {
          return jsonResponse({ success: false, error: 'Authorization: Bearer <token> is required.' }, { status: 401 });
        }
        if (user.tier !== 'premium') {
          return jsonResponse({ success: false, error: 'Premium access required for item deletion.', userId: user.uid, userTier: user.tier }, { status: 403 });
        }
        const deleted = await deleteUserItem(user.uid, decodeURIComponent(itemMatch[1]));
        if (!deleted) {
          return jsonResponse({ success: false, error: 'Item not found.' }, { status: 404 });
        }
        return jsonResponse({ success: true });
      }

      if (pathname === '/v1/account/request-password-reset' && request.method === 'POST') {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const email = typeof body.email === 'string' ? body.email : 'user@example.com';
        const result = await requestPasswordReset(email);
        return jsonResponse({ success: true, email, message: result.message });
      }

      if (pathname === '/v1/account/delete' && request.method === 'POST') {
        const result = await deleteUserData(user.uid);
        return jsonResponse({
          success: true,
          userId: user.uid,
          deletedItemsCount: result.deletedCount,
          message: `Account data for user ${user.uid} has been permanently purged.`,
        });
      }

      if (pathname === '/v1/extract-data' && request.method === 'POST') {
        const parsed = await parseExtractionRequest(request);
        let quotaResult: Awaited<ReturnType<typeof consumeQuota>>;
        try {
          quotaResult = await consumeQuota(user.uid, user.tier);
        } catch (error) {
          return jsonResponse({ success: false, error: error instanceof Error ? error.message : 'Quota service unavailable.' }, { status: 503 });
        }

        const rateHeaders = corsHeaders();
        setRateLimitHeaders(rateHeaders, quotaResult.quota, user.tier);

        if (!quotaResult.allowed) {
          rateHeaders.set('Retry-After', quotaResult.quota.resetInSeconds.toString());
          return withCors(new Response(JSON.stringify({
            success: false,
            error: `Rate limit exceeded for ${user.tier} tier. Quota resets in ${quotaResult.quota.resetInSeconds} seconds.`,
            quota: quotaResult.quota,
          }), { status: 429, headers: rateHeaders }));
        }

        const hasText = Boolean(parsed.text && parsed.text.trim().length > 0);
        const hasImage = Boolean(parsed.image && parsed.image.buffer.length > 0);
        const hasUrl = Boolean(parsed.url && parsed.url.trim().length > 0);
        const startTime = Date.now();

        try {
          const result = await processExtraction({
            userId: user.uid,
            userTier: user.tier,
            text: parsed.text,
            url: parsed.url,
            clientSource: parsed.clientSource,
            currentDate: parsed.currentDate || new Date().toISOString(),
            userTimezone: parsed.userTimezone || 'UTC',
            image: parsed.image,
            idempotencyKey: parsed.idempotencyKey,
            quota: quotaResult.quota,
            requestId,
          });

          ctx.waitUntil(logOperation({
            requestId: result.metadata.requestId,
            userId: user.uid,
            userTier: user.tier,
            endpoint: '/v1/extract-data',
            method: 'POST',
            statusCode: 200,
            latencyMs: Date.now() - startTime,
            strategy: result.data.strategy,
            hasText,
            hasImage,
            hasUrl,
            cached: result.metadata.cached,
            categoryExtracted: result.data.category,
            titleExtracted: result.data.title,
          }));

          return withCors(new Response(JSON.stringify(result), { status: 200, headers: rateHeaders }));
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Extraction failed';
          ctx.waitUntil(logOperation({
            requestId,
            userId: user.uid,
            userTier: user.tier,
            endpoint: '/v1/extract-data',
            method: 'POST',
            statusCode: 400,
            latencyMs: Date.now() - startTime,
            hasText,
            hasImage,
            hasUrl,
            cached: false,
            error: errorMessage,
          }));
          return withCors(new Response(JSON.stringify({
            success: false,
            error: errorMessage,
            quota: quotaResult.quota,
            metadata: {
              requestId,
              processingTimeMs: Date.now() - startTime,
              hasImage,
              hasText,
              hasUrl,
              userId: user.uid,
              userTier: user.tier,
              cached: false,
              persistedToFirebase: false,
            },
          }), { status: 400, headers: rateHeaders }));
        }
      }

      if (env.ASSETS) {
        return withCors(await env.ASSETS.fetch(request));
      }

      return jsonResponse({ success: false, error: 'Not found' }, { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal server error';
      ctx.waitUntil(logOperation({
        requestId,
        userId: 'system',
        userTier: 'free',
        endpoint: pathname,
        method: request.method,
        statusCode: 500,
        latencyMs: 0,
        hasText: false,
        hasImage: false,
        hasUrl: false,
        cached: false,
        error: message,
      }));
      return jsonResponse({ success: false, error: message }, { status: 500 });
    }
  },
};
