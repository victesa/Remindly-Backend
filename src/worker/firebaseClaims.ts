import { getRuntimeConfig } from '../runtimeConfig.js';
import { getScopedAccessToken, IDENTITY_TOOLKIT_SCOPE } from './firestoreRest.js';

export async function setFirebaseTierClaim(userId: string, tier: 'free' | 'premium'): Promise<void> {
  const projectId = getRuntimeConfig().FIREBASE_PROJECT_ID;
  if (!projectId) {
    throw new Error('FIREBASE_PROJECT_ID is required for Firebase custom claims.');
  }

  const { accessToken } = await getScopedAccessToken(IDENTITY_TOOLKIT_SCOPE);
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/accounts:update`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      localId: userId,
      customAttributes: JSON.stringify({ tier }),
    }),
  });

  if (!response.ok) {
    throw new Error(`Firebase custom claims update failed: HTTP ${response.status}`);
  }
}
