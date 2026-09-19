export interface ContentPrecheckResult {
  allowed: boolean;
  reason?: 'input_too_large';
}

export function precheckText(text: string | undefined, tier: 'free' | 'premium'): ContentPrecheckResult {
  if (!text) {
    return { allowed: true };
  }
  const maxChars = tier === 'premium' ? 100_000 : 10_000;
  if (text.length > maxChars) {
    return { allowed: false, reason: 'input_too_large' };
  }
  return { allowed: true };
}
