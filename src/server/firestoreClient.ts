import { App, cert, getApps, initializeApp } from 'firebase-admin/app';
import { Firestore, getFirestore } from 'firebase-admin/firestore';

let firebaseApp: App | null = null;
let firestoreDb: Firestore | null = null;
let firebaseInitError: Error | null = null;

function initializeFirebaseIfNeeded(): void {
  if (firestoreDb || firebaseInitError) {
    return;
  }

  try {
    if (getApps().length > 0) {
      firebaseApp = getApps()[0];
      firestoreDb = getFirestore(firebaseApp);
      return;
    }

    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const projectId = process.env.FIREBASE_PROJECT_ID;

    if (serviceAccountJson) {
      const parsed = JSON.parse(serviceAccountJson);
      if (typeof parsed.private_key === 'string') {
        parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
      }

      firebaseApp = initializeApp({
        credential: cert(parsed),
        projectId: parsed.project_id || projectId,
      });
      firestoreDb = getFirestore(firebaseApp);
      console.log('[Firestore] Initialized using service account credentials.');
      return;
    }

    if (projectId) {
      firebaseApp = initializeApp({ projectId });
      firestoreDb = getFirestore(firebaseApp);
      console.log('[Firestore] Initialized using project ID/application default credentials.');
      return;
    }

    firebaseInitError = new Error('Firebase is not configured. Set FIREBASE_SERVICE_ACCOUNT_JSON or FIREBASE_PROJECT_ID.');
  } catch (err: any) {
    firebaseInitError = new Error(`Firebase initialization failed: ${err?.message || String(err)}`);
  }
}

export function getFirestoreDb(): Firestore {
  initializeFirebaseIfNeeded();
  if (!firestoreDb) {
    throw firebaseInitError || new Error('Firestore is unavailable.');
  }
  return firestoreDb;
}

export function sanitizeForFirestore<T>(value: T): T {
  if (value === undefined) {
    return null as T;
  }

  if (value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForFirestore(item)) as T;
  }

  if (typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (nested === undefined) {
        continue;
      }
      sanitized[key] = sanitizeForFirestore(nested);
    }
    return sanitized as T;
  }

  return value;
}
