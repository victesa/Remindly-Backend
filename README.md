<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/e395d4bd-79d3-4835-8c40-eb034a3693ec

## Run Locally

**Prerequisites:** Node.js


1. Install dependencies:
   `npm install`
2. For Cloudflare Worker local dev, create `.dev.vars` with your local secrets:
   `GEMINI_API_KEY=...`
   `FIREBASE_SERVICE_ACCOUNT_JSON=...`
   `FIREBASE_PROJECT_ID=...`
   (You can start from `.dev.vars.example`.)
   Note: `.env` is not used by `wrangler dev` for Worker bindings.
3. Run the Worker locally:
   `npm run dev`

Optional UI-only mode:
- Run Worker API in one terminal: `npm run dev`
- Run Vite UI in another terminal: `npx vite`
- The Vite dev server proxies `/v1/*` and `/api/*` to `http://127.0.0.1:8787` by default.

## Cloudflare Workers Deployment

This project is configured to deploy as a Cloudflare Worker with static SPA assets.

1. Install dependencies:
   `npm install`
2. Build the frontend assets:
   `npm run build`
3. Add Worker secrets using Wrangler:
   `npx wrangler secret put GEMINI_API_KEY`
   `npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_JSON`
   `npx wrangler secret put FIREBASE_PROJECT_ID`
   `npx wrangler secret put GOOGLE_PLAY_PACKAGE_NAME`
   `npx wrangler secret put GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (optional; falls back to `FIREBASE_SERVICE_ACCOUNT_JSON`)
   `npx wrangler secret put RTDN_WEBHOOK_TOKEN`
4. Generate Worker binding types after config changes:
   `npm run types:worker`
5. Start local Worker dev:
   `npm run dev`
6. Deploy:
   `npm run deploy`

Notes:
- Use `.dev.vars` for local Worker-only secrets. It is gitignored.
- `.env` files remain local-only and are gitignored.

Extraction quotas are tracked per authenticated Firebase user in Firestore under `rateLimits/{uid}`. The free tier allows 5 extractions per UTC calendar month, and the premium tier allows 250. The quota is shared across the user's devices and resets at the start of the next UTC month.

## Google Play Subscription Verification

The Worker verifies Google Play subscriptions server-to-server and stores the resulting entitlement in Firestore under `users/{uid}/billing/current`. Client-supplied `X-User-Tier` headers are ignored for real (non-playground) tokens; the stored entitlement is the source of truth.

Setup:
1. In Play Console, grant your service account (Firebase's or a dedicated one) API access under **Users and permissions**, with **Financial data** view permission.
2. Set `GOOGLE_PLAY_PACKAGE_NAME` to your Android application ID.
3. Configure a Pub/Sub topic for Real-Time Developer Notifications in Play Console > **Monetization setup**, and create a push subscription pointing to:
   `https://<your-worker-domain>/v1/billing/rtdn`
4. Recommended: enable authenticated push on the subscription (assign an invoker service account and set the audience to your webhook URL), then set `RTDN_EXPECTED_AUDIENCE` to that same URL. The Worker verifies the push request's OIDC token against Google's public JWKS (issuer, audience, signature, expiry) instead of relying on a shared secret. Optionally set `RTDN_EXPECTED_SERVICE_ACCOUNT_EMAIL` to pin the exact invoker identity.
5. If you skip authenticated push, set `RTDN_WEBHOOK_TOKEN` and append `?token=<value>` to the subscription URL as a fallback (weaker: a shared secret, not a verified identity).

Endpoints:
- `POST /v1/billing/verify-purchase` — body `{ "purchaseToken": "...", "productId": "..." }`. Verifies with Google Play, persists the entitlement, and maps the purchase token to the authenticated `uid` (call this right after your app receives a purchase token from the Play Billing Library).
- `GET /v1/billing/entitlement` — returns the caller's stored entitlement (used for cross-device sync).
- `POST /v1/billing/rtdn` — Pub/Sub push endpoint. Looks up the `uid` from the purchase-token mapping, re-verifies with Google Play, and updates the stored entitlement automatically on renewal, cancellation, grace period, hold, or expiry.

## Analytics

Set `ANALYTICS_ADMIN_KEY` as a Worker secret, then query:

```text
GET /v1/analytics/summary?since=2026-09-01T00:00:00.000Z
X-Analytics-Key: <ANALYTICS_ADMIN_KEY>
```

The response includes active Pro users, tracked entitlements, churned and reactivated users, capture totals, unique capture users, common client sources, source types, categories, and daily capture counts. Analytics records contain identifiers and aggregate dimensions only; reminder text and purchase tokens are not copied into analytics collections.

## Production Security

- Normal `/v1/*` API routes require a cryptographically verified Firebase ID token. The token audience and issuer must match `FIREBASE_PROJECT_ID`; client `X-User-Id` and `X-User-Tier` values are not identity or entitlement sources.
- The development token minting route is disabled in deployed configuration through `ALLOW_DEV_AUTH=false` and should only be enabled in local `.dev.vars`.
- AI status, logs, quota reset-all, and analytics are protected by `ANALYTICS_ADMIN_KEY`; keep that key only in a private operator environment.
- RTDN is the only unauthenticated application route and must use Pub/Sub OIDC verification or `RTDN_WEBHOOK_TOKEN`; it fails closed when neither is configured.
- Keep Firebase service-account JSON, Google Play service-account JSON, API keys, webhook secrets, `.env`, `.dev.vars`, certificates, and Firebase CLI state out of Git. Rotate any credential that has been exposed.

