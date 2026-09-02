import { StoredReminderItem, ExtractedReminderData } from '../types.js';
import { getFirestoreDb, sanitizeForFirestore } from './firestoreClient.js';

type EditableItemState = 'OPEN' | 'DONE';

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

function normalizeCategory(raw: unknown): ExtractedReminderData['category'] | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  return CATEGORY_ALIAS_MAP[key] || null;
}

function normalizeState(raw: unknown): EditableItemState | null {
  if (typeof raw !== 'string') return null;
  const upper = raw.trim().toUpperCase();
  if (upper === 'OPEN' || upper === 'DONE') {
    return upper;
  }
  return null;
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

function toStoredItem(userId: string, docId: string, docData: any): StoredReminderItem {
  const extractedAt =
    (typeof docData.extractedAt === 'string' && docData.extractedAt) ||
    (typeof docData.createdAt === 'string' && docData.createdAt) ||
    new Date(0).toISOString();

  const nestedData = docData.data;
  const resolvedData: ExtractedReminderData = nestedData
    ? nestedData
    : {
        title: docData.title || 'Reminder',
        summary: docData.summary ?? null,
        category: normalizeCategory(docData.category) || 'OTHER',
        deadline: docData.deadline ?? null,
        eventDate: docData.eventDate ?? null,
        organization: docData.organization ?? docData?.metadata?.organization ?? null,
        url: docData.url ?? null,
        strategy: 'local_rule_engine',
        tier: 'premium',
        confidenceScore: typeof docData.confidenceScore === 'number' ? docData.confidenceScore : undefined,
        actionableItems: Array.isArray(docData.actionableItems) ? docData.actionableItems : undefined,
      };

  return {
    id: docData.id || docId,
    userId: docData.userId || userId,
    extractedAt,
    state: docData.state === 'DONE' ? 'DONE' : 'OPEN',
    sourceType: docData.sourceType || 'text',
    inputSnippet: typeof docData.inputSnippet === 'string' ? docData.inputSnippet : '',
    data: resolvedData,
    persistedSource: 'firestore',
    source: docData.source,
    createdAt: typeof docData.createdAt === 'string' ? docData.createdAt : extractedAt,
    updatedAt: typeof docData.updatedAt === 'string' ? docData.updatedAt : extractedAt,
    metadata: docData.metadata,
  };
}

async function getItemRefs(userId: string, itemId: string): Promise<{ capturesRef: FirebaseFirestore.DocumentReference; itemsRef: FirebaseFirestore.DocumentReference; capturesExists: boolean; itemsExists: boolean; }> {
  const db = getFirestoreDb();
  const capturesRef = db.collection('users').doc(userId).collection('captures').doc(itemId);
  const itemsRef = db.collection('users').doc(userId).collection('items').doc(itemId);

  const [capturesDoc, itemsDoc] = await Promise.all([capturesRef.get(), itemsRef.get()]);
  return {
    capturesRef,
    itemsRef,
    capturesExists: capturesDoc.exists,
    itemsExists: itemsDoc.exists,
  };
}

/**
 * Persists an extracted item to Firestore.
 */
export async function saveExtractedItem(
  userId: string,
  data: ExtractedReminderData,
  sourceType: 'text' | 'image' | 'url' | 'multimodal',
  inputSnippet: string,
  context?: SaveItemContext
): Promise<{ success: boolean; id: string; persistedSource: 'firestore' | 'memory' }> {
  const db = getFirestoreDb();
  const id = `item_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const nowIso = new Date().toISOString();
  const capturedAt = context?.currentDate || nowIso;
  const sourceContentType: 'TEXT' | 'URL' | 'IMAGE' | 'MULTIMODAL' =
    sourceType === 'multimodal'
      ? 'MULTIMODAL'
      : sourceType === 'text'
        ? 'TEXT'
        : sourceType === 'url'
          ? 'URL'
          : 'IMAGE';
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

  const capturesDoc = sanitizeForFirestore({
    ...item,
    createdAt: nowIso,
  });

  const legacyItemDoc = sanitizeForFirestore({
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
  });

  await db.collection('users').doc(userId).collection('captures').doc(id).set(capturesDoc);
  await db.collection('users').doc(userId).collection('items').doc(id).set(legacyItemDoc);
  await db.collection('users').doc(userId).collection('item_debug').doc(id).set(
    sanitizeForFirestore({
      itemId: id,
      uid: userId,
      source,
      metadata,
      updatedAt: nowIso,
    })
  );

  return {
    success: true,
    id,
    persistedSource: 'firestore',
  };
}

/**
 * Retrieves past items for a user.
 */
export async function getUserItems(userId: string, limit = 50): Promise<StoredReminderItem[]> {
  const db = getFirestoreDb();
  const nestedCapturesRef = db.collection('users').doc(userId).collection('captures');
  const nestedItemsRef = db.collection('users').doc(userId).collection('items');
  const snapshots = [] as FirebaseFirestore.QuerySnapshot[];

  // Preferred query path for current schema.
  try {
    const ordered = await nestedCapturesRef.orderBy('extractedAt', 'desc').limit(limit).get();
    snapshots.push(ordered);
  } catch {
    // Ignore and fallback below.
  }

  // Fallback for legacy items that may not contain extractedAt.
  if (snapshots.length === 0 || snapshots[0].empty) {
    const unordered = await nestedCapturesRef.limit(Math.max(limit * 4, 200)).get();
    snapshots.push(unordered);
  }

  // Legacy/alternate path used by mobile clients.
  try {
    const orderedItems = await nestedItemsRef.orderBy('updatedAt', 'desc').limit(limit).get();
    snapshots.push(orderedItems);
  } catch {
    const unorderedItems = await nestedItemsRef.limit(Math.max(limit * 4, 200)).get();
    snapshots.push(unorderedItems);
  }

  // Additional fallback for legacy top-level collection layout.
  try {
    const legacy = await db.collection('captures').where('userId', '==', userId).limit(Math.max(limit * 4, 200)).get();
    snapshots.push(legacy);
  } catch {
    // Ignore if legacy collection does not exist.
  }

  const deduped = new Map<string, StoredReminderItem>();
  for (const snapshot of snapshots) {
    for (const doc of snapshot.docs) {
      const raw = doc.data();
      const normalized = toStoredItem(userId, doc.id, raw);
      deduped.set(normalized.id, normalized);
    }
  }

  return Array.from(deduped.values())
    .sort((a, b) => new Date(b.extractedAt).getTime() - new Date(a.extractedAt).getTime())
    .slice(0, limit);
}

/**
 * Updates selected fields on a stored capture item.
 */
export async function updateUserItem(userId: string, itemId: string, patch: UpdateItemInput): Promise<StoredReminderItem> {
  const refs = await getItemRefs(userId, itemId);

  if (!refs.capturesExists && !refs.itemsExists) {
    throw new Error('Item not found.');
  }

  const captureUpdates: Record<string, unknown> = {};
  const legacyItemUpdates: Record<string, unknown> = {};

  if (patch.state !== undefined) {
    const normalizedState = normalizeState(patch.state);
    if (!normalizedState) {
      throw new Error('Invalid state. Allowed values: OPEN, DONE.');
    }
    captureUpdates.state = normalizedState;
    legacyItemUpdates.state = normalizedState === 'OPEN' ? 'READY' : normalizedState;
  }

  if (patch.title !== undefined) {
    if (typeof patch.title !== 'string' || patch.title.trim().length === 0) {
      throw new Error('Invalid title.');
    }
    captureUpdates['data.title'] = patch.title.trim();
    legacyItemUpdates.title = patch.title.trim();
  }

  if (patch.category !== undefined) {
    const normalizedCategory = normalizeCategory(patch.category);
    if (!normalizedCategory) {
      throw new Error('Invalid category.');
    }
    captureUpdates['data.category'] = normalizedCategory;
    legacyItemUpdates.category = normalizedCategory;
  }

  if (patch.summary !== undefined) {
    if (patch.summary !== null && typeof patch.summary !== 'string') {
      throw new Error('Invalid summary. Must be string or null.');
    }
    captureUpdates['data.summary'] = patch.summary === null ? null : patch.summary.trim();
    legacyItemUpdates.summary = patch.summary === null ? null : patch.summary.trim();
  }

  if (patch.deadline !== undefined) {
    if (patch.deadline !== null && typeof patch.deadline !== 'string') {
      throw new Error('Invalid deadline. Must be string or null.');
    }
    captureUpdates['data.deadline'] = patch.deadline;
    legacyItemUpdates.deadline = patch.deadline;
  }

  if (patch.eventDate !== undefined) {
    if (patch.eventDate !== null && typeof patch.eventDate !== 'string') {
      throw new Error('Invalid eventDate. Must be string or null.');
    }
    captureUpdates['data.eventDate'] = patch.eventDate;
    legacyItemUpdates.eventDate = patch.eventDate;
  }

  if (patch.organization !== undefined) {
    if (patch.organization !== null && typeof patch.organization !== 'string') {
      throw new Error('Invalid organization. Must be string or null.');
    }
    captureUpdates['data.organization'] = patch.organization === null ? null : patch.organization.trim();
    legacyItemUpdates.organization = patch.organization === null ? null : patch.organization.trim();
  }

  if (patch.url !== undefined) {
    if (patch.url !== null && typeof patch.url !== 'string') {
      throw new Error('Invalid url. Must be string or null.');
    }
    captureUpdates['data.url'] = patch.url;
    legacyItemUpdates.url = patch.url;
  }

  if (patch.actionableItems !== undefined) {
    if (!Array.isArray(patch.actionableItems) || patch.actionableItems.some((v) => typeof v !== 'string')) {
      throw new Error('Invalid actionableItems. Must be string array.');
    }
    captureUpdates['data.actionableItems'] = patch.actionableItems;
    legacyItemUpdates.actionableItems = patch.actionableItems;
  }

  if (patch.confidenceScore !== undefined) {
    if (typeof patch.confidenceScore !== 'number' || patch.confidenceScore < 0 || patch.confidenceScore > 1) {
      throw new Error('Invalid confidenceScore. Must be between 0 and 1.');
    }
    captureUpdates['data.confidenceScore'] = patch.confidenceScore;
    legacyItemUpdates.confidenceScore = patch.confidenceScore;
  }

  if (Object.keys(captureUpdates).length === 0 && Object.keys(legacyItemUpdates).length === 0) {
    throw new Error('No valid fields provided for update.');
  }

  if (refs.capturesExists && Object.keys(captureUpdates).length > 0) {
    await refs.capturesRef.update(sanitizeForFirestore(captureUpdates));
  }
  if (refs.itemsExists && Object.keys(legacyItemUpdates).length > 0) {
    legacyItemUpdates.updatedAt = new Date().toISOString();
    await refs.itemsRef.update(sanitizeForFirestore(legacyItemUpdates));
  }

  const updatedSnapshot = refs.capturesExists ? await refs.capturesRef.get() : await refs.itemsRef.get();
  const updatedItem = updatedSnapshot.data();
  if (!updatedItem) {
    throw new Error('Item not found after update.');
  }

  return toStoredItem(userId, itemId, updatedItem);
}

/**
 * Deletes a single stored capture by ID.
 */
export async function deleteUserItem(userId: string, itemId: string): Promise<boolean> {
  const db = getFirestoreDb();
  const refs = await getItemRefs(userId, itemId);
  if (!refs.capturesExists && !refs.itemsExists) {
    return false;
  }

  const deletes: Promise<FirebaseFirestore.WriteResult>[] = [];
  if (refs.capturesExists) {
    deletes.push(refs.capturesRef.delete());
  }
  if (refs.itemsExists) {
    deletes.push(refs.itemsRef.delete());
  }

  const debugRef = db.collection('users').doc(userId).collection('item_debug').doc(itemId);
  const debugDoc = await debugRef.get();
  if (debugDoc.exists) {
    deletes.push(debugRef.delete());
  }

  await Promise.all(deletes);
  return true;
}

/**
 * Deletes all data for an account.
 */
export async function deleteUserData(userId: string): Promise<{ deletedCount: number }> {
  const db = getFirestoreDb();
  const userRef = db.collection('users').doc(userId);
  const collections = ['captures', 'items', 'item_debug'];
  let deletedCount = 0;

  for (const collectionName of collections) {
    const snapshot = await userRef.collection(collectionName).get();
    if (snapshot.empty) continue;

    const docs = snapshot.docs;
    deletedCount += docs.length;
    for (let i = 0; i < docs.length; i += 400) {
      const chunk = docs.slice(i, i + 400);
      const batch = db.batch();
      for (const doc of chunk) {
        batch.delete(doc.ref);
      }
      await batch.commit();
    }
  }

  return { deletedCount };
}

/**
 * Simulates requesting password reset.
 */
export async function requestPasswordReset(email: string): Promise<{ sent: boolean; message: string }> {
  console.log(`[Account] Password reset email triggered for ${email}`);
  return {
    sent: true,
    message: `Password reset link dispatched to ${email}`,
  };
}
