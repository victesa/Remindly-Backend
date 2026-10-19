#!/usr/bin/env node

/**
 * Bulk Promo Code Uploader for Remindly Backend
 *
 * Uploads Google Play subscription promo codes (from CSV or text export) into
 * the Firestore `promoCodes` collection with status: "available".
 *
 * Usage:
 *   node scripts/upload-promo-codes.mjs [path-to-file]
 *
 * Examples:
 *   node scripts/upload-promo-codes.mjs promo-codes
 *   node scripts/upload-promo-codes.mjs ./exports/google_play_promos_q1.csv
 *   npm run upload-promo-codes -- ./promo-codes
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Helper to parse key=value lines from .dev.vars or .env
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, 'utf8');
  const env = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

// Merge configuration: process.env -> .dev.vars -> .env
const devVars = loadEnvFile(path.join(projectRoot, '.dev.vars'));
const dotEnv = loadEnvFile(path.join(projectRoot, '.env'));
const config = {
  ...dotEnv,
  ...devVars,
  ...process.env,
};

function getServiceAccount() {
  const raw = config.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error(
      'FIREBASE_SERVICE_ACCOUNT_JSON is not configured in .dev.vars, .env, or environment variables.'
    );
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      projectId: parsed.project_id || config.FIREBASE_PROJECT_ID,
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key.replace(/\\n/g, '\n'),
    };
  } catch (err) {
    throw new Error(`Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON: ${err.message}`);
  }
}

function base64UrlEncode(strOrBuffer) {
  const buf = Buffer.isBuffer(strOrBuffer) ? strOrBuffer : Buffer.from(strOrBuffer);
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function fetchWithRetry(url, options, retries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

async function getDatastoreAccessToken(serviceAccount) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: serviceAccount.clientEmail,
    scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(serviceAccount.privateKey);
  const assertion = `${signingInput}.${base64UrlEncode(signature)}`;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const res = await fetchWithRetry('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google OAuth token exchange failed: HTTP ${res.status} ${text}`);
  }

  const json = await res.json();
  return json.access_token;
}

function parsePromoCodeFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  // Strip BOM if present
  const content = raw.replace(/^\uFEFF/, '');
  const lines = content.split(/\r?\n/);

  const codes = new Set();
  const headerKeywords = new Set([
    'CODE',
    'PROMOTION CODE',
    'PROMO CODE',
    'PROMO_CODE',
    'SUBSCRIPTION PROMO CODE',
    'STATUS',
    'TYPE',
    'DESCRIPTION',
  ]);

  for (const line of lines) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      continue;
    }

    // Handle CSV or tab-delimited files
    let candidate = trimmed;
    if (trimmed.includes(',') || trimmed.includes('\t')) {
      const parts = trimmed.split(/[,;\t]/).map((p) => p.trim().replace(/^["']|["']$/g, ''));
      // Find the first token that matches a Google Play promo code
      const match = parts.find((p) => /^[A-Z0-9]{8,40}$/i.test(p));
      if (match) {
        candidate = match;
      } else {
        candidate = parts[0];
      }
    } else {
      candidate = trimmed.replace(/^["']|["']$/g, '');
    }

    candidate = candidate.trim().toUpperCase();
    if (headerKeywords.has(candidate)) {
      continue;
    }

    // Validate alphanumeric code format (Google Play codes typically 15-30 chars)
    if (/^[A-Z0-9]{8,40}$/.test(candidate)) {
      codes.add(candidate);
    }
  }

  return Array.from(codes);
}

async function uploadPromoCodes() {
  const args = process.argv.slice(2);
  const targetFile = args[0] || path.join(projectRoot, 'promo-codes');
  const resolvedPath = path.resolve(process.cwd(), targetFile);

  console.log('='.repeat(60));
  console.log('Remindly - Bulk Promo Code Pool Uploader');
  console.log('='.repeat(60));
  console.log(`Source File: ${resolvedPath}`);

  const codes = parsePromoCodeFile(resolvedPath);
  console.log(`Parsed ${codes.length} unique valid promo codes from file.`);

  if (codes.length === 0) {
    console.log('No valid promo codes to upload. Exiting.');
    return;
  }

  console.log('\nAuthenticating with Google Cloud / Firestore...');
  const serviceAccount = getServiceAccount();
  const accessToken = await getDatastoreAccessToken(serviceAccount);
  console.log(`Authenticated as ${serviceAccount.clientEmail} (Project: ${serviceAccount.projectId})`);

  const BATCH_SIZE = 100;
  let addedCount = 0;
  let skippedCount = 0;
  const totalBatches = Math.ceil(codes.length / BATCH_SIZE);

  console.log(`\nUploading in ${totalBatches} batches (batch size: ${BATCH_SIZE})...`);

  for (let i = 0; i < codes.length; i += BATCH_SIZE) {
    const batch = codes.slice(i, i + BATCH_SIZE);
    const batchIndex = Math.floor(i / BATCH_SIZE) + 1;
    const now = new Date().toISOString();

    const writes = batch.map((code) => ({
      update: {
        name: `projects/${serviceAccount.projectId}/databases/(default)/documents/promoCodes/${code}`,
        fields: {
          code: { stringValue: code },
          status: { stringValue: 'available' },
          createdAt: { timestampValue: now },
        },
      },
      currentDocument: { exists: false }, // Prevent overwriting existing codes
    }));

    const url = `https://firestore.googleapis.com/v1/projects/${serviceAccount.projectId}/databases/(default)/documents:commit`;
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ writes }),
    });

    if (res.ok) {
      addedCount += batch.length;
      process.stdout.write(`  [Batch ${batchIndex}/${totalBatches}] +${batch.length} codes added.\n`);
    } else {
      // Some codes already exist in Firestore; use batchGet in a single request to identify missing codes
      const batchGetUrl = `https://firestore.googleapis.com/v1/projects/${serviceAccount.projectId}/databases/(default)/documents:batchGet`;
      const docNames = batch.map((code) => `projects/${serviceAccount.projectId}/databases/(default)/documents/promoCodes/${code}`);
      const batchGetRes = await fetchWithRetry(batchGetUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ documents: docNames }),
      });

      let batchAdded = 0;
      let batchSkipped = 0;

      if (batchGetRes.ok) {
        const entries = await batchGetRes.json();
        const missingDocNames = new Set(
          entries
            .filter((e) => e.missing)
            .map((e) => e.missing)
        );

        const codesToInsert = batch.filter((code) =>
          missingDocNames.has(`projects/${serviceAccount.projectId}/databases/(default)/documents/promoCodes/${code}`)
        );

        batchSkipped = batch.length - codesToInsert.length;

        if (codesToInsert.length > 0) {
          const insertWrites = codesToInsert.map((code) => ({
            update: {
              name: `projects/${serviceAccount.projectId}/databases/(default)/documents/promoCodes/${code}`,
              fields: {
                code: { stringValue: code },
                status: { stringValue: 'available' },
                createdAt: { timestampValue: now },
              },
            },
          }));

          const insertRes = await fetchWithRetry(url, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ writes: insertWrites }),
          });

          if (insertRes.ok) {
            batchAdded = codesToInsert.length;
          } else {
            batchSkipped += codesToInsert.length;
          }
        }
      } else {
        batchSkipped = batch.length;
      }

      addedCount += batchAdded;
      skippedCount += batchSkipped;
      process.stdout.write(
        `  [Batch ${batchIndex}/${totalBatches}] +${batchAdded} added, ${batchSkipped} already in pool.\n`
      );
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('Upload Summary:');
  console.log(`  Total codes in input:     ${codes.length}`);
  console.log(`  Newly added to pool:      ${addedCount}`);
  console.log(`  Already existing/skipped: ${skippedCount}`);
  console.log('='.repeat(60));
}

uploadPromoCodes().catch((err) => {
  console.error('\n[Error] Bulk upload failed:', err.message, err.cause ? `(Cause: ${err.cause.message || err.cause})` : '');
  process.exit(1);
});


