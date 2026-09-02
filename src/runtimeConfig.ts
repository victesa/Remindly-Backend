export interface RuntimeConfig {
  GEMINI_API_KEY?: string;
  FIREBASE_SERVICE_ACCOUNT_JSON?: string;
  FIREBASE_PROJECT_ID?: string;
  NODE_ENV?: string;
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
