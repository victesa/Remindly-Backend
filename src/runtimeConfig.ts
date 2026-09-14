export interface RuntimeConfig {
  GEMINI_API_KEY?: string;
  FIREBASE_SERVICE_ACCOUNT_JSON?: string;
  FIREBASE_PROJECT_ID?: string;
  NODE_ENV?: string;
  GOOGLE_PLAY_PACKAGE_NAME?: string;
  // Optional: separate service account with Play Console API access. Falls back to FIREBASE_SERVICE_ACCOUNT_JSON.
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON?: string;
  // Shared secret appended to the RTDN Pub/Sub push subscription URL as ?token=... to reject spoofed calls.
  RTDN_WEBHOOK_TOKEN?: string;
  // Audience configured on the Pub/Sub push subscription's OIDC token. When set, RTDN requests are verified
  // via Google's public JWKS instead of (or in addition to) the shared-secret token.
  RTDN_EXPECTED_AUDIENCE?: string;
  // Optional: restrict RTDN OIDC verification to a specific Pub/Sub push service account email.
  RTDN_EXPECTED_SERVICE_ACCOUNT_EMAIL?: string;
}

declare global {
  var __REMINDLY_RUNTIME_CONFIG__: RuntimeConfig | undefined;
}

export function setRuntimeConfig(config: RuntimeConfig): void {
  globalThis.__REMINDLY_RUNTIME_CONFIG__ = config;
}

export function getRuntimeConfig(): RuntimeConfig {
  if (globalThis.__REMINDLY_RUNTIME_CONFIG__) {
    return globalThis.__REMINDLY_RUNTIME_CONFIG__;
  }

  if (typeof process !== 'undefined' && process.env) {
    return process.env as RuntimeConfig;
  }

  return {};
}
