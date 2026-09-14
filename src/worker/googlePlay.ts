import { getRuntimeConfig } from '../runtimeConfig.js';
import type { SubscriptionStatus } from '../types.js';
import { ANDROID_PUBLISHER_SCOPE, getScopedAccessToken } from './firestoreRest.js';

export interface PlaySubscriptionResult {
  productId: string;
  purchaseToken: string;
  orderId: string | null;
  status: SubscriptionStatus;
  autoRenewing: boolean;
  expiryTimeMillis: number | null;
  startTimeMillis: number | null;
  isEntitled: boolean;
}

interface SubscriptionPurchaseV2 {
  subscriptionState?: string;
  latestOrderId?: string;
  startTime?: string;
  lineItems?: Array<{
    productId?: string;
    expiryTime?: string;
    autoRenewingPlan?: { autoRenewEnabled?: boolean };
  }>;
}

function mapSubscriptionState(state: string | undefined, expiryTimeMillis: number | null): { status: SubscriptionStatus; isEntitled: boolean } {
  const notExpired = expiryTimeMillis !== null && expiryTimeMillis > Date.now();
  switch (state) {
    case 'SUBSCRIPTION_STATE_ACTIVE':
      return { status: 'active', isEntitled: true };
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
      return { status: 'in_grace_period', isEntitled: true };
    case 'SUBSCRIPTION_STATE_ON_HOLD':
      return { status: 'on_hold', isEntitled: false };
    case 'SUBSCRIPTION_STATE_PAUSED':
      return { status: 'paused', isEntitled: false };
    case 'SUBSCRIPTION_STATE_CANCELED':
      return { status: 'canceled', isEntitled: notExpired };
    case 'SUBSCRIPTION_STATE_EXPIRED':
      return { status: 'expired', isEntitled: false };
    case 'SUBSCRIPTION_STATE_REVOKED':
      return { status: 'revoked', isEntitled: false };
    default:
      return { status: 'unknown', isEntitled: false };
  }
}

/** Verifies a subscription purchase token directly against Google Play (never trust client-reported status). */
export async function verifyGooglePlaySubscription(purchaseToken: string, expectedProductId?: string): Promise<PlaySubscriptionResult> {
  const packageName = getRuntimeConfig().GOOGLE_PLAY_PACKAGE_NAME;
  if (!packageName) {
    throw new Error('GOOGLE_PLAY_PACKAGE_NAME is not configured.');
  }
  if (!purchaseToken || typeof purchaseToken !== 'string') {
    throw new Error('purchaseToken is required.');
  }

  const token = await getScopedAccessToken(ANDROID_PUBLISHER_SCOPE);
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Google Play verification failed: HTTP ${response.status} ${errText.slice(0, 200)}`);
  }

  const json = await response.json() as SubscriptionPurchaseV2;
  const lineItem = expectedProductId
    ? json.lineItems?.find((item) => item.productId === expectedProductId) || json.lineItems?.[0]
    : json.lineItems?.[0];

  const expiryTimeMillis = lineItem?.expiryTime ? new Date(lineItem.expiryTime).getTime() : null;
  const { status, isEntitled } = mapSubscriptionState(json.subscriptionState, expiryTimeMillis);

  return {
    productId: lineItem?.productId || expectedProductId || 'unknown',
    purchaseToken,
    orderId: json.latestOrderId || null,
    status,
    autoRenewing: Boolean(lineItem?.autoRenewingPlan?.autoRenewEnabled),
    expiryTimeMillis,
    startTimeMillis: json.startTime ? new Date(json.startTime).getTime() : null,
    isEntitled,
  };
}

export interface DeveloperNotification {
  version: string;
  packageName: string;
  eventTimeMillis: string;
  subscriptionNotification?: {
    version: string;
    notificationType: number;
    purchaseToken: string;
    subscriptionId: string;
  };
  testNotification?: { version: string };
}

/** Decodes a base64-encoded Real-Time Developer Notification (RTDN) Pub/Sub message payload. */
export function decodeRtdnMessage(base64Data: string): DeveloperNotification {
  const json = Buffer.from(base64Data, 'base64').toString('utf-8');
  return JSON.parse(json) as DeveloperNotification;
}
