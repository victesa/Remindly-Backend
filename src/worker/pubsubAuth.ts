const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const JWKS_TTL_MS = 60 * 60 * 1000;

interface GoogleJwk {
  kty: string;
  alg?: string;
  kid: string;
  n: string;
  e: string;
}

interface JwksCache {
  keys: GoogleJwk[];
  expiresAt: number;
}

let jwksCache: JwksCache | null = null;

async function getGoogleJwks(): Promise<GoogleJwk[]> {
  if (jwksCache && jwksCache.expiresAt > Date.now()) {
    return jwksCache.keys;
  }
  const response = await fetch(GOOGLE_JWKS_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch Google JWKS: HTTP ${response.status}`);
  }
  const json = await response.json() as { keys: GoogleJwk[] };
  jwksCache = { keys: json.keys, expiresAt: Date.now() + JWKS_TTL_MS };
  return json.keys;
}

interface PubSubTokenPayload {
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  email?: string;
  email_verified?: boolean;
  sub?: string;
}

export interface PubSubVerificationOptions {
  expectedAudience: string;
  expectedServiceAccountEmail?: string;
}

/** Verifies a Cloud Pub/Sub push request's OIDC bearer token against Google's public JWKS. */
export async function verifyPubSubOidcToken(authorizationHeader: string | null, options: PubSubVerificationOptions): Promise<PubSubTokenPayload> {
  if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
    throw new Error('Missing bearer token on Pub/Sub push request.');
  }
  const token = authorizationHeader.slice(7).trim();
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed Pub/Sub OIDC token.');
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf-8')) as { kid?: string; alg?: string };
  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8')) as PubSubTokenPayload;

  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported Pub/Sub token algorithm: ${header.alg}`);
  }

  const jwks = await getGoogleJwks();
  const jwk = jwks.find((key) => key.kid === header.kid);
  if (!jwk) {
    throw new Error('No matching Google signing key found for Pub/Sub token.');
  }

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signedInput = `${headerB64}.${payloadB64}`;
  const signature = Buffer.from(signatureB64, 'base64url');
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, new TextEncoder().encode(signedInput));
  if (!valid) {
    throw new Error('Pub/Sub OIDC token signature verification failed.');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (payload.exp < nowSeconds - 60) {
    throw new Error('Pub/Sub OIDC token has expired.');
  }
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
    throw new Error(`Unexpected Pub/Sub token issuer: ${payload.iss}`);
  }
  if (payload.aud !== options.expectedAudience) {
    throw new Error('Pub/Sub OIDC token audience mismatch.');
  }
  if (options.expectedServiceAccountEmail && payload.email !== options.expectedServiceAccountEmail) {
    throw new Error('Pub/Sub OIDC token was not signed by the expected service account.');
  }

  return payload;
}
