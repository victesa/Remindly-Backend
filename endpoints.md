# Remindly Backend — Client-Facing API Reference

Base URL: `https://<your-worker-domain>`

All endpoints below (except `GET /v1/health`) require:

```
Authorization: Bearer <firebase-id-token>
```

The token is cryptographically verified against Firebase's public keys. `X-User-Id` and `X-User-Tier` headers are **not trusted** — the server resolves the account's tier itself from the Firestore entitlement record (`users/{uid}/billing/current`), never from client-supplied headers.

Every JSON response includes a `success: boolean` field. On failure, an `error: string` field is included.

---

## GET /v1/health

Liveness check. No authentication required.

**Request**
```
GET /v1/health
```

**Response 200**
```json
{
  "status": "ok",
  "service": "Remindly AI Backend Proxy",
  "version": "1.2.0",
  "timestamp": "2026-09-21T12:00:00.000Z"
}
```

---

## GET /v1/me  (alias: GET /v1/user/profile)

Canonical unified endpoint. Returns identity, subscription, and quota in one call. Use this instead of any separate quota/entitlement call.

**Request**
```
GET /v1/me
Authorization: Bearer <firebase-id-token>
```

**Response 200**
```json
{
  "success": true,
  "user": {
    "uid": "firebase-uid",
    "email": "user@example.com",
    "name": "Display Name"
  },
  "subscription": {
    "tier": "free",
    "status": "none",
    "productId": null,
    "expiryTimeMillis": null
  },
  "quota": {
    "limit": 5,
    "remaining": 5,
    "imageLimit": 5,
    "imageRemaining": 5,
    "resetInSeconds": 2592000,
    "tier": "free",
    "windowSizeSeconds": 2592000
  }
}
```

For a premium account with an active subscription, `subscription.tier` is `"premium"`, `status` reflects the Google Play state (`active`, `in_grace_period`, `canceled`, etc.), and `quota.limit`/`imageLimit` are `250`.

**Errors**
- `401` — missing/invalid/expired Firebase token.
- `503` — Firestore entitlement lookup failed.

---

## POST /v1/extract-data

Submits text, a URL, and/or an image/PDF for AI extraction.

**Request headers**
```
Authorization: Bearer <firebase-id-token>
Idempotency-Key: <optional-client-generated-key>
X-Client-Date: <ISO 8601, optional>
X-User-Timezone: <IANA timezone, optional>
Content-Type: multipart/form-data OR application/json
```

**Multipart fields** (use when sending an image/PDF)
| Field | Required | Notes |
|---|---|---|
| `text` | no | free-form text |
| `url` | no | reference URL |
| `image` | no | file; JPEG/PNG/WEBP/GIF/PDF; 10MB max (Free), 25MB max (Pro) |
| `source` | no | client provenance string, e.g. `"In-App Capture"`, `"WhatsApp"`, `"Web Extension"`. Not sent to the AI; saved as-is only after a successful, persisted (premium) extraction, and returned later in `source` via `GET /v1/items/sync`. |
| `idempotencyKey` | no | alternative to the header |
| `currentDate` | no | ISO 8601; falls back to `X-Client-Date` |
| `timezone` / `userTimezone` | no | falls back to `X-User-Timezone` |

**JSON body** (use when there is no file)
```json
{
  "text": "Submit report by Friday 5pm",
  "url": "https://example.com/event",
  "source": "WhatsApp",
  "idempotencyKey": "unique-client-id",
  "currentDate": "2026-09-21T12:00:00.000Z",
  "timezone": "Africa/Nairobi"
}
```

At least one of `text`, `url`, or `image` is required.

**Text size limits**: Free 10,000 characters, Pro 100,000 characters.

**Response 200**
```json
{
  "success": true,
  "data": {
    "title": "Submit quarterly report",
    "summary": "Executive summary text or null on Free tier",
    "category": "ASSIGNMENT",
    "deadline": "2026-09-25T17:00:00.000Z",
    "eventDate": null,
    "organization": "Acme Corp",
    "url": null,
    "strategy": "gemini_cloud_ai",
    "tier": "premium",
    "confidenceScore": 0.92,
    "actionableItems": ["Prepare summary slides", "Send to manager"]
  },
  "quota": {
    "limit": 250,
    "remaining": 249,
    "imageLimit": 250,
    "imageRemaining": 250,
    "resetInSeconds": 2591000,
    "tier": "premium",
    "windowSizeSeconds": 2592000
  },
  "metadata": {
    "requestId": "req_...",
    "processingTimeMs": 812,
    "hasImage": false,
    "hasText": true,
    "hasUrl": false,
    "userId": "firebase-uid",
    "userTier": "premium",
    "cached": false,
    "persistedToFirebase": true,
    "idempotencyKey": null
  }
}
```

`category` is one of: `JOB, EVENT, SCHOLARSHIP, MEETING, EXAM, ASSIGNMENT, BILL, PAYMENT, APPOINTMENT, SUBSCRIPTION, TRAVEL, HEALTH, SHOPPING, DOCUMENT, PERSONAL, OTHER`. `deadline`/`eventDate` are `null` (real JSON null, not a string) whenever no date is stated in the input. Free-tier `summary` is always `null`.

**Response headers** (always set)
```
X-RateLimit-Limit
X-RateLimit-Remaining
X-RateLimit-Reset
X-RateLimit-Tier
```

**Errors**
- `422` — input text exceeds the tier's character limit.
- `429` — quota exceeded. Includes `Retry-After` header and:
  ```json
  { "success": false, "error": "Rate limit exceeded for premium tier. Quota resets in 2591000 seconds.", "quota": { "...": "..." } }
  ```
- `400` — extraction failed (bad file type, oversized file, no input provided, or AI error):
  ```json
  { "success": false, "error": "...", "quota": { "...": "..." }, "metadata": { "...": "..." } }
  ```
- `503` — quota service unavailable.
- `401` — missing/invalid Firebase token.

---

## GET /v1/items

Returns stored captures. **Premium only.**

**Request**
```
GET /v1/items?limit=50
Authorization: Bearer <firebase-id-token>
```

**Response 200**
```json
{
  "success": true,
  "userId": "firebase-uid",
  "userTier": "premium",
  "count": 2,
  "items": [
    {
      "id": "item_...",
      "userId": "firebase-uid",
      "extractedAt": "2026-09-21T12:00:00.000Z",
      "state": "OPEN",
      "sourceType": "image",
      "inputSnippet": "Reminder input",
      "data": { "title": "...", "summary": "...", "category": "JOB", "deadline": null, "eventDate": null, "organization": "...", "url": null, "strategy": "gemini_cloud_ai", "tier": "premium", "confidenceScore": 0.9, "actionableItems": ["..."] },
      "persistedSource": "firestore",
      "isDeleted": false,
      "deletedAt": null,
      "source": { "contentType": "IMAGE", "clientSource": "In-App Capture", "sourceUrl": null, "mimeType": "image/jpeg", "fileName": "flyer.jpg", "sourceDomain": null, "capturedAt": "...", "receivedAt": "...", "extractedTextProvided": false },
      "createdAt": "2026-09-21T12:00:00.000Z",
      "updatedAt": "2026-09-21T12:00:00.000Z"
    }
  ]
}
```

**Errors**
- `403` — account is not premium:
  ```json
  { "success": false, "error": "Stored captures are available for premium users only.", "userId": "...", "userTier": "free" }
  ```

---

## GET /v1/items/sync

Delta sync. **Premium only.**

**Request**
```
GET /v1/items/sync?since=2026-09-19T08:00:00.000Z
Authorization: Bearer <firebase-id-token>
```

Omit `since` for a full sync (first install / fresh state).

**Response 200**
```json
{
  "success": true,
  "syncTimestamp": "2026-09-21T12:00:00.000Z",
  "updatedItems": [
    {
      "id": "item_...",
      "userId": "firebase-uid",
      "title": "Submit quarterly report",
      "summary": "...",
      "category": "ASSIGNMENT",
      "deadline": "2026-09-25T17:00:00.000Z",
      "eventDate": null,
      "organization": "Acme Corp",
      "source": "In-App Capture",
      "sourceUrl": null,
      "state": "READY",
      "checklist": ["Prepare summary slides"],
      "createdAt": "2026-09-21T12:00:00.000Z",
      "updatedAt": "2026-09-21T12:00:00.000Z"
    }
  ],
  "deletedItemIds": ["item_old_1", "item_old_2"]
}
```

`state` here is `"READY"` or `"DONE"` (already remapped from the internal `OPEN`/`DONE` values). Save `syncTimestamp` and send it back as `since` on the next call.

**Errors**
- `400` — `since` is not a valid ISO 8601 timestamp.
- `403` — account is not premium.

---

## PATCH /v1/items/{id}

Updates fields on a stored item. **Premium only.**

**Request**
```
PATCH /v1/items/item_1789992629550_0da1b1f6
Authorization: Bearer <firebase-id-token>
Content-Type: application/json

{
  "state": "DONE",
  "title": "Updated title",
  "category": "JOB",
  "summary": "Updated summary or null",
  "deadline": "2026-09-30T17:00:00.000Z",
  "eventDate": null,
  "organization": "New org or null",
  "url": null,
  "actionableItems": ["Step 1", "Step 2"],
  "confidenceScore": 0.8
}
```

All fields are optional; only send the ones you want to change. `state` accepts `OPEN` or `DONE`.

**Response 200**

Returns the updated item object directly (same shape as one entry in `GET /v1/items`'s `items` array) — **not** wrapped in `{ success, data }`.

**Errors**
- `403` — account is not premium.
- `500` — item not found, or an invalid field value was supplied (e.g. invalid `category`, invalid `state`). The response body is `{ "success": false, "error": "..." }`; note that a missing item currently surfaces as `500`, not `404`.

---

## DELETE /v1/items/{id}

Soft-deletes a stored item (creates a tombstone, so `GET /v1/items/sync` reports it in `deletedItemIds`). **Premium only.**

**Request**
```
DELETE /v1/items/item_1789992629550_0da1b1f6
Authorization: Bearer <firebase-id-token>
```

**Response 200**
```json
{ "success": true }
```

**Errors**
- `403` — account is not premium.
- `404` — item does not exist:
  ```json
  { "success": false, "error": "Item not found." }
  ```

---

## POST /v1/account/request-password-reset

**Request**
```
POST /v1/account/request-password-reset
Authorization: Bearer <firebase-id-token>
Content-Type: application/json

{ "email": "user@example.com" }
```

**Response 200**
```json
{ "success": true, "email": "user@example.com", "message": "Password reset link dispatched to user@example.com" }
```

---

## POST /v1/account/delete

Permanently purges all captures and internal records for the authenticated user.

**Request**
```
POST /v1/account/delete
Authorization: Bearer <firebase-id-token>
```

**Response 200**
```json
{
  "success": true,
  "userId": "firebase-uid",
  "deletedItemsCount": 12,
  "message": "Account data for user firebase-uid has been permanently purged."
}
```

---

## POST /v1/billing/verify-purchase

Verifies a Google Play purchase token and links it to the authenticated Firebase account.

**Request**
```
POST /v1/billing/verify-purchase
Authorization: Bearer <firebase-id-token>
Content-Type: application/json

{
  "purchaseToken": "google-play-purchase-token",
  "productId": "remindly_premium"
}
```

**Response 200**
```json
{
  "success": true,
  "entitlement": {
    "userId": "firebase-uid",
    "tier": "premium",
    "productId": "remindly_premium",
    "purchaseToken": "google-play-purchase-token",
    "orderId": "GPA.xxxx",
    "status": "active",
    "autoRenewing": true,
    "expiryTimeMillis": 1760000000000,
    "startTimeMillis": 1757000000000,
    "source": "google_play",
    "updatedAt": "2026-09-21T12:00:00.000Z"
  }
}
```

After this call, refresh the Firebase ID token (`getIdToken(true)`) — the backend also attempts to set a `tier` custom claim, which only appears in a freshly issued token.

**Errors**
- `400` — `purchaseToken` missing.
- `502` — Google Play verification failed.

---

## POST /v1/quota/reset

Resets the authenticated user's own extraction quota.

**Request**
```
POST /v1/quota/reset
Authorization: Bearer <firebase-id-token>
Content-Type: application/json

{}
```

**Response 200**
```json
{ "success": true, "message": "Quota reset for user firebase-uid" }
```

Sending `{ "all": true }` resets every user's quota, but that requires an additional `X-Analytics-Key` admin header and is not intended for the app.

---

## Deprecated endpoints (still respond, do not use)

| Endpoint | Response |
|---|---|
| `GET /v1/quota` | `410` — `{ "success": false, "error": "This endpoint is deprecated. Use GET /v1/me instead.", "deprecated": true }` |
| `GET /v1/billing/entitlement` | `410` — same shape, points to `/v1/me` |

---

## Not for the app (admin/internal only)

These exist on the server but require an `X-Analytics-Key` admin header, or are Google-only webhooks, and are not part of the client contract:

- `GET /v1/ai-status`
- `GET /v1/analytics/summary`
- `GET /v1/diagnostics/extraction-anomalies`
- `GET /v1/logs`
- `POST /v1/logs/clear`
- `POST /v1/billing/rtdn` (Google Pub/Sub push only)
- `POST /v1/auth/mint-token` (disabled unless `ALLOW_DEV_AUTH=true`; local development only)
