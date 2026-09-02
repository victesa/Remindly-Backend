import { Request, Response, NextFunction } from 'express';
import { QuotaInfo, UserTier } from '../types.js';
import { getFirestoreDb, sanitizeForFirestore } from './firestoreClient.js';

interface RateLimitRecord {
  timestamps: number[];
  customLimit?: number;
}

const TIER_LIMITS: Record<UserTier, { limit: number; windowMs: number }> = {
  free: {
    limit: 25, // 25 extractions per 15-minute window for free
    windowMs: 15 * 60 * 1000,
  },
  premium: {
    limit: 250, // 250 extractions per 15-minute window for premium
    windowMs: 15 * 60 * 1000,
  },
};

const RATE_LIMITS_COLLECTION = 'rateLimits';

async function getOrCreateRecord(userId: string): Promise<RateLimitRecord> {
  const db = getFirestoreDb();
  const ref = db.collection(RATE_LIMITS_COLLECTION).doc(userId);
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    const initial: RateLimitRecord = { timestamps: [] };
    await ref.set(initial);
    return initial;
  }

  const data = snapshot.data() as RateLimitRecord | undefined;
  return {
    timestamps: Array.isArray(data?.timestamps) ? data!.timestamps : [],
    customLimit: data?.customLimit,
  };
}

async function saveRecord(userId: string, record: RateLimitRecord): Promise<void> {
  const db = getFirestoreDb();
  await db.collection(RATE_LIMITS_COLLECTION).doc(userId).set(sanitizeForFirestore(record), { merge: true });
}

/**
 * Returns current quota information for a given user & tier.
 */
export async function getQuotaInfo(userId: string, tier: UserTier): Promise<QuotaInfo> {
  const now = Date.now();
  const config = TIER_LIMITS[tier] || TIER_LIMITS.free;
  const windowStart = now - config.windowMs;

  const record = await getOrCreateRecord(userId);

  // Filter timestamps within window
  record.timestamps = record.timestamps.filter((ts) => ts > windowStart);
  await saveRecord(userId, record);

  const limit = record.customLimit ?? config.limit;
  const count = record.timestamps.length;
  const remaining = Math.max(0, limit - count);

  // Oldest timestamp determines reset time
  const oldest = record.timestamps[0];
  const resetInMs = oldest ? Math.max(0, oldest + config.windowMs - now) : config.windowMs;
  const resetInSeconds = Math.ceil(resetInMs / 1000);

  return {
    limit,
    remaining,
    resetInSeconds,
    tier,
    windowSizeSeconds: Math.floor(config.windowMs / 1000),
  };
}

/**
 * Consumes 1 request from the quota if available.
 */
export async function consumeQuota(userId: string, tier: UserTier): Promise<{ allowed: boolean; quota: QuotaInfo }> {
  const now = Date.now();
  const quota = await getQuotaInfo(userId, tier);

  if (quota.remaining <= 0) {
    return { allowed: false, quota };
  }

  const record = await getOrCreateRecord(userId);
  record.timestamps.push(now);
  await saveRecord(userId, record);

  const updatedQuota = {
    ...quota,
    remaining: quota.remaining - 1,
  };

  return { allowed: true, quota: updatedQuota };
}

/**
 * Resets quota for a given user.
 */
export async function resetUserQuota(userId: string): Promise<boolean> {
  const db = getFirestoreDb();
  await db.collection(RATE_LIMITS_COLLECTION).doc(userId).delete();
  return true;
}

/**
 * Resets all user quotas.
 */
export async function resetAllQuotas(): Promise<void> {
  const db = getFirestoreDb();
  const snapshot = await db.collection(RATE_LIMITS_COLLECTION).get();
  if (snapshot.empty) return;

  const docs = snapshot.docs;
  for (let i = 0; i < docs.length; i += 400) {
    const chunk = docs.slice(i, i + 400);
    const batch = db.batch();
    for (const doc of chunk) {
      batch.delete(doc.ref);
    }
    await batch.commit();
  }
}

/**
 * Express middleware for enforcing rate limits on endpoints.
 */
export async function rateLimiterMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = req.user?.uid || 'anonymous';
  const tier = req.user?.tier || 'free';

  let allowed: boolean;
  let quota: QuotaInfo;
  try {
    const result = await consumeQuota(userId, tier);
    allowed = result.allowed;
    quota = result.quota;
  } catch (error: any) {
    res.status(503).json({
      success: false,
      error: error?.message || 'Quota service unavailable.',
    });
    return;
  }

  // Set HTTP RateLimit headers
  res.setHeader('X-RateLimit-Limit', quota.limit.toString());
  res.setHeader('X-RateLimit-Remaining', quota.remaining.toString());
  res.setHeader('X-RateLimit-Reset', quota.resetInSeconds.toString());
  res.setHeader('X-RateLimit-Tier', tier);

  if (!allowed) {
    res.setHeader('Retry-After', quota.resetInSeconds.toString());
    res.status(429).json({
      success: false,
      error: `Rate limit exceeded for ${tier} tier. Quota resets in ${quota.resetInSeconds} seconds.`,
      quota,
    });
    return;
  }

  next();
}
