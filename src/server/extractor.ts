import crypto from 'crypto';
import {
  ExtractedReminderData,
  ExtractionMetadata,
  ExtractionResponse,
  QuotaInfo,
  UserTier,
} from '../types.js';
import { extractUrls, fetchUrlContent, FetchedUrlContent, hasSufficientTextDetail } from './urlFetcher.js';
import { extractWithGemini } from './geminiExtractor.js';
import { saveExtractedItem } from './firebaseStore.js';
import { getFirestoreDb, sanitizeForFirestore } from './firestoreClient.js';

interface ExtractionRequestOptions {
  userId: string;
  userTier: UserTier;
  text?: string;
  url?: string;
  image?: {
    buffer: Buffer;
    mimeType: string;
    originalName?: string;
  } | null;
  idempotencyKey?: string | null;
  quota: QuotaInfo;
  requestId: string;
  currentDate?: string;
  userTimezone?: string;
}

interface CachedEntry {
  data: ExtractedReminderData;
  timestamp: number;
  hasImage: boolean;
  hasText: boolean;
  hasUrl: boolean;
}

const IDEMPOTENCY_CACHE_COLLECTION = 'idempotencyCache';
const PAYLOAD_DEDUPE_COLLECTION = 'payloadDedupeCache';
const inFlightRequests = new Map<string, Promise<ExtractedReminderData>>();

// TTL Configuration - 15 minutes cache for repeated queries to save 100% token usage
const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;
const PAYLOAD_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

async function getCachedEntry(
  collection: string,
  docId: string,
  ttlMs: number
): Promise<CachedEntry | null> {
  const db = getFirestoreDb();
  const snapshot = await db.collection(collection).doc(docId).get();
  if (!snapshot.exists) return null;

  const data = snapshot.data() as CachedEntry | undefined;
  if (!data || typeof data.timestamp !== 'number') return null;
  if (Date.now() - data.timestamp >= ttlMs) return null;
  return data;
}

async function saveCachedEntry(collection: string, docId: string, entry: CachedEntry): Promise<void> {
  const db = getFirestoreDb();
  await db.collection(collection).doc(docId).set(sanitizeForFirestore(entry));
}

/**
 * Computes deterministic hash of request payload.
 */
function computePayloadHash(
  userId: string,
  userTier: UserTier,
  text?: string,
  url?: string,
  imageBuffer?: Buffer
): string {
  const hash = crypto.createHash('sha256');
  hash.update(`${userId}:`);
  hash.update(`${userTier}:`);
  hash.update(text ? text.trim().toLowerCase() : '');
  hash.update(url ? url.trim().toLowerCase() : '');
  if (imageBuffer && imageBuffer.length > 0) {
    hash.update(imageBuffer.slice(0, 2048)); // First 2KB of image
  }
  return hash.digest('hex');
}

/**
 * Main orchestrator function for processing reminder extractions.
 */
export async function processExtraction(options: ExtractionRequestOptions): Promise<ExtractionResponse> {
  const startTime = Date.now();
  const { userId, userTier, text, image, idempotencyKey, quota, requestId } = options;

  let explicitUrl = options.url?.trim();
  const rawText = text?.trim() || '';

  // 1. Detect URLs embedded in text
  const detectedUrls = extractUrls(rawText);
  if (!explicitUrl && detectedUrls.length > 0) {
    explicitUrl = detectedUrls[0];
  }

  const hasText = rawText.length > 0;
  const hasImage = Boolean(image && image.buffer && image.buffer.length > 0);
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

    const saveRes = await saveExtractedItem(userId, payload, sourceType, inputSnippet, {
      text: rawText || undefined,
      url: explicitUrl,
      userTimezone: options.userTimezone,
      currentDate: options.currentDate,
      imageMimeType: image?.mimeType,
      imageOriginalName: image?.originalName,
      requestId,
      sourceDomain,
    });

    return saveRes.persistedSource === 'firestore';
  };

  // 2. Validate input requirement: at least one of text, image, or url must be present
  if (!hasText && !hasImage && !hasUrl) {
    throw new Error('Invalid input: At least one of text, image, or URL must be provided.');
  }

  // 3. Check Idempotency Key cache
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
          userId,
          userTier,
          cached: true,
          persistedToFirebase: false,
          idempotencyKey,
        },
      };
    }
  }

  // 4. Check Semantic Payload Deduplication cache (0 tokens consumed on duplicate inputs)
  const payloadHash = computePayloadHash(userId, userTier, rawText, explicitUrl, image?.buffer);
  const cachedPayload = await getCachedEntry(PAYLOAD_DEDUPE_COLLECTION, payloadHash, PAYLOAD_DEDUPE_WINDOW_MS);
  if (cachedPayload) {
    let persistedToFirebase = false;
    if (userTier === 'premium') {
      persistedToFirebase = await persistPremiumCapture(cachedPayload.data);
    }

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
        userId,
        userTier,
        cached: true,
        persistedToFirebase,
        idempotencyKey,
      },
    };
  }

  // 5. In-flight Promise Deduplication
  const dedupeKey = idempKey || payloadHash;
  let extractionPromise = inFlightRequests.get(dedupeKey);

  if (!extractionPromise) {
    extractionPromise = (async () => {
      // Step A: Scenario handling for URLs
      let resolvedUrlContent: FetchedUrlContent | null = null;

      if (explicitUrl) {
        const textDetailed = hasSufficientTextDetail(rawText);
        if (!textDetailed || !hasText) {
          resolvedUrlContent = await fetchUrlContent(explicitUrl);
        } else {
          // Preserve URL as reference without blocking network crawl
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

      // Step B: Pure Context-Aware Gemini AI Extraction for both Free and Premium tiers
      const extracted = await extractWithGemini({
        text: rawText || undefined,
        urlContent: resolvedUrlContent,
        image: image ? { buffer: image.buffer, mimeType: image.mimeType } : null,
        userTier,
        currentDate: options.currentDate,
        userTimezone: options.userTimezone,
      });

      // Attach URL if available
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

  // 6. Cache the successful result
  const cacheEntry: CachedEntry = {
    data: finalData,
    timestamp: Date.now(),
    hasImage,
    hasText,
    hasUrl,
  };

  if (idempKey) {
    await saveCachedEntry(IDEMPOTENCY_CACHE_COLLECTION, idempKey, cacheEntry);
  }
  await saveCachedEntry(PAYLOAD_DEDUPE_COLLECTION, payloadHash, cacheEntry);

  // 7. Persist to storage for premium users only (must succeed)
  let persistedToFirebase = false;
  if (userTier === 'premium') {
    try {
      persistedToFirebase = await persistPremiumCapture(finalData);
      if (!persistedToFirebase) {
        throw new Error('Capture was not persisted to Firestore for premium user.');
      }
    } catch (err: any) {
      throw new Error(`Premium capture persistence failed: ${err?.message || String(err)}`);
    }
  }

  const processingTimeMs = Date.now() - startTime;

  return {
    success: true,
    data: finalData,
    quota,
    metadata: {
      requestId,
      processingTimeMs,
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
