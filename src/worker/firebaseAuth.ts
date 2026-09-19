import { getRuntimeConfig } from '../runtimeConfig.js';
import type { AuthUser } from '../types.js';

const FIREBASE_CERTS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const CERT_TTL_MS = 60 * 60 * 1000;

interface FirebaseTokenPayload {
  sub?: string;
  user_id?: string;
  email?: string;
  name?: string;
  aud?: string;
  iss?: string;
  exp?: number;
  iat?: number;
  auth_time?: number;
  email_verified?: boolean;
}

interface FirebaseJwk {
  kty: string;
  kid: string;
  n: string;
  e: string;
  alg?: string;
}

let certCache: { keys: FirebaseJwk[]; expiresAt: number } | null = null;

function decodeBase64Url(value: string): Uint8Array {
  return Buffer.from(value, 'base64url');
}

async function getFirebaseCerts(): Promise<FirebaseJwk[]> {
  if (certCache && certCache.expiresAt > Date.now()) {
    return certCache.keys;
  }

  const response = await fetch(FIREBASE_CERTS_URL);
  if (!response.ok) {
    throw new Error(`Firebase certificate lookup failed: HTTP ${response.status}`);
  }
  const json = await response.json() as { keys: FirebaseJwk[] };
  certCache = { keys: json.keys, expiresAt: Date.now() + CERT_TTL_MS };
  return json.keys;
}

export async function verifyFirebaseIdToken(authorizationHeader: string | null): Promise<AuthUser> {
  if (!authorizationHeader?.startsWith('Bearer ')) {
    throw new Error('Authorization: Bearer <Firebase ID token> is required.');
  }

  const token = authorizationHeader.slice(7).trim();
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed Firebase ID token.');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  let header: { alg?: string; kid?: string };
  let payload: FirebaseTokenPayload;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')) as { alg?: string; kid?: string };
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as FirebaseTokenPayload;
  } catch {
    throw new Error('Malformed Firebase ID token payload.');
  }

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Unsupported Firebase ID token.');
  }

  const keys = await getFirebaseCerts();
  const jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    certCache = null;
    throw new Error('Firebase signing key is unavailable.');
  }

  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    decodeBase64Url(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!valid) {
    throw new Error('Firebase ID token signature verification failed.');
  }

  const runtime = getRuntimeConfig();
  const projectId = runtime.FIREBASE_PROJECT_ID;
  const now = Math.floor(Date.now() / 1000);
  if (!projectId || payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}`) {
    throw new Error('Firebase ID token project or issuer mismatch.');
  }
  if (!payload.sub || payload.sub.length > 128) {
    throw new Error('Firebase ID token subject is invalid.');
  }
  if (typeof payload.exp !== 'number' || payload.exp <= now || typeof payload.iat !== 'number' || payload.iat > now + 60) {
    throw new Error('Firebase ID token is expired or not yet valid.');
  }
  if (typeof payload.auth_time === 'number' && payload.auth_time > now + 60) {
    throw new Error('Firebase authentication time is invalid.');
  }

  return {
    uid: payload.sub,
    email: payload.email || `${payload.sub}@firebase.local`,
    tier: 'free',
    name: payload.name || 'Authenticated User',
  };
}
