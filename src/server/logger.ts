import { LogEntry, AiServiceStatus, UserTier } from '../types.js';
import { getFirestoreDb, sanitizeForFirestore } from './firestoreClient.js';

const MAX_LOGS = 1000;
const startTime = Date.now();
const LOGS_COLLECTION = 'logs';

export async function logOperation(entry: Omit<LogEntry, 'id' | 'timestamp'>): Promise<LogEntry> {
  const db = getFirestoreDb();
  const fullEntry: LogEntry = {
    id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    timestamp: new Date().toISOString(),
    ...entry,
  };

  await db.collection(LOGS_COLLECTION).doc(fullEntry.id).set(sanitizeForFirestore(fullEntry));

  // Console output for standard server observability
  const statusStr = fullEntry.statusCode >= 400 ? `[ERROR ${fullEntry.statusCode}]` : `[OK ${fullEntry.statusCode}]`;
  const strategyStr = fullEntry.strategy ? `[${fullEntry.strategy}]` : '';
  const tierStr = `[${fullEntry.userTier.toUpperCase()}]`;
  console.log(
    `[${fullEntry.timestamp}] ${statusStr} ${tierStr} ${fullEntry.method} ${fullEntry.endpoint} - ${fullEntry.latencyMs}ms ${strategyStr} ${fullEntry.error || ''}`
  );

  return fullEntry;
}

export async function getRecentLogs(limit = 100, filterTier?: UserTier, filterEndpoint?: string): Promise<LogEntry[]> {
  const db = getFirestoreDb();
  const safeLimit = Math.max(1, Math.min(limit, MAX_LOGS));
  const snapshot = await db.collection(LOGS_COLLECTION).orderBy('timestamp', 'desc').limit(safeLimit * 5).get();
  let logs = snapshot.docs.map((doc) => doc.data() as LogEntry);

  if (filterTier) {
    logs = logs.filter((l) => l.userTier === filterTier);
  }
  if (filterEndpoint) {
    logs = logs.filter((l) => l.endpoint.includes(filterEndpoint));
  }

  return logs.slice(0, safeLimit);
}

export async function clearLogs(): Promise<void> {
  const db = getFirestoreDb();
  const snapshot = await db.collection(LOGS_COLLECTION).get();
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

export async function getAiServiceStatus(): Promise<AiServiceStatus> {
  const now = Date.now();
  const uptimeSeconds = Math.floor((now - startTime) / 1000);
  const geminiConfigured = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.length > 5);

  try {
    const db = getFirestoreDb();

    // Use timestamp-only ordering to avoid composite index requirements.
    const snapshot = await db.collection(LOGS_COLLECTION)
      .orderBy('timestamp', 'desc')
      .limit(1000)
      .get();

    const extractionLogs = snapshot.docs
      .map((doc) => doc.data() as LogEntry)
      .filter((l) => l.endpoint === '/v1/extract-data');

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
      if (log.userTier === 'premium') premiumCount++;
      else freeCount++;
      if (log.cached) cacheHits++;
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
  } catch (error) {
    console.warn('[Logger] Failed to compute AI service status from Firestore:', error);
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
