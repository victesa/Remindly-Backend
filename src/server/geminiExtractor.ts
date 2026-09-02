import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import { ExtractedReminderData, ReminderCategory, UserTier } from '../types.js';
import { getRuntimeConfig } from '../runtimeConfig.js';

let geminiClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  if (!geminiClient) {
    const apiKey = getRuntimeConfig().GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not configured in the environment.');
    }
    geminiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return geminiClient;
}

export interface GeminiExtractionInput {
  text?: string;
  urlContent?: {
    url: string;
    title: string | null;
    description: string | null;
    bodySnippet: string;
    sourceDomain: string;
  } | null;
  image?: {
    buffer: Buffer;
    mimeType: string;
  } | null;
  userTier?: UserTier;
  currentDate?: string;
  userTimezone?: string;
}

/**
 * Validates whether a returned string is a valid ISO 8601 date.
 * If invalid or empty, returns null. No regex guesswork is performed.
 */
function validateIsoString(val: any): string | null {
  if (!val || typeof val !== 'string') return null;
  const trimmed = val.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null' || trimmed.toLowerCase() === 'undefined' || trimmed.toLowerCase() === 'none') {
    return null;
  }
  const parsed = new Date(trimmed);
  if (!isNaN(parsed.getTime()) && trimmed.length >= 10 && (trimmed.includes('-') || trimmed.includes(':'))) {
    return parsed.toISOString();
  }
  return null;
}

/**
 * Helper to clean and parse JSON response even if wrapped in markdown code blocks.
 */
function cleanAndParseJson(text: string): any {
  if (!text) return {};
  let cleaned = text.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.replace(/^```json\s*/, '').replace(/```\s*$/, '');
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```\s*/, '').replace(/```\s*$/, '');
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    // If strict parse fails, try extracting first JSON object match
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const slice = cleaned.slice(firstBrace, lastBrace + 1);
      return JSON.parse(slice);
    }
    throw new Error(`Failed to parse AI JSON response: ${text.slice(0, 150)}`);
  }
}

/**
 * Utility for asynchronous delay with random jitter.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ALLOWED_CATEGORIES: ReminderCategory[] = [
  'JOB',
  'EVENT',
  'SCHOLARSHIP',
  'MEETING',
  'EXAM',
  'ASSIGNMENT',
  'BILL',
  'PAYMENT',
  'APPOINTMENT',
  'SUBSCRIPTION',
  'TRAVEL',
  'HEALTH',
  'SHOPPING',
  'DOCUMENT',
  'PERSONAL',
  'OTHER',
];

function normalizeCategory(rawCategory: unknown, contentHint?: string): ReminderCategory {
  if (typeof rawCategory === 'string') {
    const upper = rawCategory.trim().toUpperCase();
    if (ALLOWED_CATEGORIES.includes(upper as ReminderCategory)) {
      return upper as ReminderCategory;
    }

    // Backward-compat aliases from older category schema.
    if (upper === 'BILL_PAYMENT') {
      return 'BILL';
    }
    if (upper === 'DEADLINE') {
      return 'ASSIGNMENT';
    }
    if (upper === 'TASK') {
      return 'PERSONAL';
    }
  }

  // Soft lexical fallback when model returns unexpected labels.
  const hint = (contentHint || '').toLowerCase();
  if (hint.includes('interview') || hint.includes('job') || hint.includes('hiring')) return 'JOB';
  if (hint.includes('scholarship') || hint.includes('grant')) return 'SCHOLARSHIP';
  if (hint.includes('exam') || hint.includes('test') || hint.includes('quiz')) return 'EXAM';
  if (hint.includes('assignment') || hint.includes('homework') || hint.includes('submission')) return 'ASSIGNMENT';
  if (hint.includes('bill') || hint.includes('invoice') || hint.includes('utility')) return 'BILL';
  if (hint.includes('payment') || hint.includes('pay ') || hint.includes('paid')) return 'PAYMENT';
  if (hint.includes('doctor') || hint.includes('clinic') || hint.includes('hospital') || hint.includes('medic')) return 'HEALTH';
  if (hint.includes('flight') || hint.includes('trip') || hint.includes('travel') || hint.includes('hotel')) return 'TRAVEL';
  if (hint.includes('shopping') || hint.includes('grocery') || hint.includes('buy ')) return 'SHOPPING';
  if (hint.includes('document') || hint.includes('passport') || hint.includes('id card')) return 'DOCUMENT';
  if (hint.includes('meeting') || hint.includes('sync') || hint.includes('standup')) return 'MEETING';
  if (hint.includes('appointment')) return 'APPOINTMENT';
  if (hint.includes('subscription') || hint.includes('renewal')) return 'SUBSCRIPTION';
  if (hint.includes('event') || hint.includes('conference') || hint.includes('webinar')) return 'EVENT';

  return 'OTHER';
}

/**
 * Pure Context-Aware AI Extraction Engine with Multi-Model Fallback & Auto-Retry.
 * Gracefully handles 503 (High Demand / Spikes) and 429 (Rate Limits) by:
 * 1. Using ultra-fast `gemini-3.1-flash-lite` with `ThinkingLevel.MINIMAL` (sub-second latency).
 * 2. Cascading automatically to `gemini-3.7-flash` if lite experiences heavy load.
 * 3. Providing full premium features (Executive summary, actionable items) in both tiers.
 */
export async function extractWithGemini(input: GeminiExtractionInput): Promise<ExtractedReminderData> {
  const ai = getGeminiClient();
  const tier: UserTier = input.userTier || 'free';
  const isFreeTier = tier === 'free';

  // Fast production cascade:
  // Primary: gemini-3.1-flash-lite (ultra-fast, lowest latency, high throughput)
  // Fallback: gemini-3.7-flash (deep reasoning capability)
  const candidateModels: string[] = ['gemini-3.1-flash-lite', 'gemini-3.7-flash'];

  // 1. Determine User's Real Timezone
  const timezone = input.userTimezone && input.userTimezone.trim().length > 0 
    ? input.userTimezone.trim() 
    : 'UTC';

  // 2. Parse client timestamp
  const refDate = input.currentDate ? new Date(input.currentDate) : new Date();
  const validRefDate = isNaN(refDate.getTime()) ? new Date() : refDate;
  const clientUtcIso = validRefDate.toISOString();

  // 3. Format temporal anchor according to user's timezone
  let userLocalFormatted = '';
  let userLocalDateOnly = '';
  let userLocalDayOfWeek = '';

  try {
    const dtfFull = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: true,
      timeZoneName: 'short',
    });
    userLocalFormatted = dtfFull.format(validRefDate);

    const dtfDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    userLocalDateOnly = dtfDate.format(validRefDate);

    const dtfDay = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
    });
    userLocalDayOfWeek = dtfDay.format(validRefDate);
  } catch {
    userLocalFormatted = validRefDate.toUTCString();
    userLocalDateOnly = clientUtcIso.split('T')[0];
    userLocalDayOfWeek = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][validRefDate.getUTCDay()];
  }

  const systemInstruction = `You are Remindly AI's context-aware cognitive reminder extraction engine.
Your mission is to understand natural language notes, emails, receipts, bills, flyers, doctor notes, and web captures, and convert them into structured reminder intelligence with high precision.

USER'S EXACT LOCAL TEMPORAL ANCHOR & TIMEZONE:
- User Timezone: ${timezone}
- User Local Time Right Now: ${userLocalFormatted}
- User Current Local Date: ${userLocalDateOnly}
- User Current Day of Week: ${userLocalDayOfWeek}
- Client Reference Instant (UTC): ${clientUtcIso}

TIMEZONE & RELATIVE DATE RESOLUTION RULES:
1. All relative expressions ("today", "tonight", "this morning", "this afternoon", "tomorrow", "this Friday", "next Monday", "in 3 hours", "at 4pm") MUST be calculated relative to the user's LOCAL calendar date and current time (${userLocalFormatted} in ${timezone}).
2. When the user says "meeting at 4pm" without a date:
   - It refers to 4:00 PM in the user's timezone (${timezone}) on the user's local date (${userLocalDateOnly}).
   - Convert this local datetime to the equivalent standard UTC ISO-8601 string (ending in Z).
3. When the user says "tomorrow at 10am":
   - Calculate tomorrow in the user's local timezone (${timezone}), at 10:00 AM local time, and output the UTC ISO-8601 string.

CORE COGNITIVE EXTRACTION RULES:
1. TRUTHFULNESS & ZERO HALLUCINATIONS:
   - If the input does NOT mention a date, day, or time for a deadline, 'deadline' MUST be null.
   - If the input does NOT mention a scheduled event date or time, 'eventDate' MUST be null.
   - NEVER make up or extrapolate dates or years (do NOT guess distant years like 2027, 2028 unless explicitly written in the user input).
   - Phone numbers, invoice numbers, account codes, or reference IDs are NOT dates.
   - If the text has no dates at all, BOTH 'deadline' and 'eventDate' MUST be null.

2. TEMPORAL DISAMBIGUATION (EVENT vs DEADLINE):
   - 'eventDate': The specific scheduled start time when an event, meeting, appointment, sync, flight, concert, webinar, interview, or dinner begins.
     Example: "Dentist appointment this Thursday at 2pm" -> eventDate: "[calculated UTC ISO]", deadline: null.
   - 'deadline': The cutoff, due date, payment date, expiration, or submission cutoff by which a task, bill, assignment, tax, or registration must be completed.
     Example: "Pay electricity bill by Friday 5pm" -> deadline: "[calculated UTC ISO]", eventDate: null.
   - DUAL DATES: If an input has BOTH an event and a separate preparation/submission deadline (e.g., "AI Conference on Nov 15, submit papers by Oct 1"), populate BOTH 'eventDate' and 'deadline' with their respective UTC ISO timestamps.

3. REASONING & OUTPUT:
   - Provide a concise title (max 70 characters).
   ${isFreeTier 
     ? '- Summary: For this tier, provide null for summary.' 
     : '- Summary: Provide a crisp 1-2 sentence executive overview highlighting key details, requirements, and deadlines.'}
  - Category: Select exactly one best-fitting category from: JOB, EVENT, SCHOLARSHIP, MEETING, EXAM, ASSIGNMENT, BILL, PAYMENT, APPOINTMENT, SUBSCRIPTION, TRAVEL, HEALTH, SHOPPING, DOCUMENT, PERSONAL, OTHER.
   - ActionableItems: 1 to 3 clear, practical next steps (or null if none needed).
   - Organization: Name of company, school, clinic, platform, or host (or null).
   - ConfidenceScore: Between 0.50 and 1.00.`;

  const parts: Array<{ text?: string; inlineData?: { data: string; mimeType: string } }> = [];

  // Add image if present
  if (input.image && input.image.buffer) {
    parts.push({
      inlineData: {
        data: input.image.buffer.toString('base64'),
        mimeType: input.image.mimeType || 'image/jpeg',
      },
    });
  }

  // Construct text prompt with explicit timezone anchor
  let promptText = `User Local Reference Time: ${userLocalFormatted} (Timezone: ${timezone})\nClient Reference UTC: ${clientUtcIso}\n\nExtract structured reminder details from this capture:\n\n`;
  if (input.text) {
    promptText += `User Content/Notes:\n"""\n${input.text}\n"""\n\n`;
  }
  if (input.urlContent) {
    promptText += `URL Context (${input.urlContent.url}):\n`;
    if (input.urlContent.title) promptText += `Title: ${input.urlContent.title}\n`;
    if (input.urlContent.description) promptText += `Description: ${input.urlContent.description}\n`;
    promptText += `Snippet: ${input.urlContent.bodySnippet}\n\n`;
  }

  parts.push({ text: promptText });

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: 'Concise reminder title' },
      summary: { type: Type.STRING, description: 'Executive summary or null' },
      category: {
        type: Type.STRING,
        enum: [
          'JOB',
          'EVENT',
          'SCHOLARSHIP',
          'MEETING',
          'EXAM',
          'ASSIGNMENT',
          'BILL',
          'PAYMENT',
          'APPOINTMENT',
          'SUBSCRIPTION',
          'TRAVEL',
          'HEALTH',
          'SHOPPING',
          'DOCUMENT',
          'PERSONAL',
          'OTHER',
        ],
        description: 'Standard reminder category',
      },
      deadline: {
        type: Type.STRING,
        description: 'UTC ISO 8601 string (YYYY-MM-DDTHH:MM:SS.sssZ) for submission/payment due date calculated using the user timezone, or null if not a deadline.',
      },
      eventDate: {
        type: Type.STRING,
        description: 'UTC ISO 8601 string (YYYY-MM-DDTHH:MM:SS.sssZ) for scheduled start time of event/appointment calculated using the user timezone, or null if no event time.',
      },
      organization: {
        type: Type.STRING,
        description: 'Name of company, hospital, doctor, school, or host, or null.',
      },
      actionableItems: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: '1 to 3 actionable next steps or null',
      },
      confidenceScore: {
        type: Type.NUMBER,
        description: 'Confidence score from 0.0 to 1.0',
      },
    },
    required: ['title', 'category'],
  };

  let lastError: any = null;

  // Iterate through candidate models in cascade order
  for (const modelToTry of candidateModels) {
    // Retry up to 2 times for transient 503 / 429 spikes per model
    const maxRetries = 2;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await ai.models.generateContent({
          model: modelToTry,
          contents: { parts },
          config: {
            systemInstruction,
            temperature: 0.1,
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
            responseMimeType: 'application/json',
            responseSchema,
          },
        });

        const rawJson = response.text ? response.text.trim() : '{}';
        const parsed = cleanAndParseJson(rawJson);

        const lexicalHint = [input.text, input.urlContent?.title, input.urlContent?.description, input.urlContent?.bodySnippet]
          .filter(Boolean)
          .join(' ');
        const category: ReminderCategory = normalizeCategory(parsed.category, lexicalHint);

        const validDeadline = validateIsoString(parsed.deadline);
        const validEventDate = validateIsoString(parsed.eventDate);
        const strategy = tier === 'free' ? 'gemini_flash_lite' : 'gemini_cloud_ai';

        return {
          title: parsed.title || 'Reminder',
          summary: isFreeTier ? null : (parsed.summary || null),
          category,
          deadline: validDeadline,
          eventDate: validEventDate,
          organization: parsed.organization && parsed.organization !== 'null' ? parsed.organization : null,
          url: input.urlContent?.url || null,
          strategy,
          tier,
          confidenceScore: typeof parsed.confidenceScore === 'number' ? parsed.confidenceScore : 0.95,
          actionableItems: Array.isArray(parsed.actionableItems) && parsed.actionableItems.length > 0 ? parsed.actionableItems : undefined,
        };
      } catch (err: any) {
        lastError = err;
        const errMsg = err?.message || String(err);
        const isTransient503or429 = errMsg.includes('503') || errMsg.includes('429') || errMsg.includes('UNAVAILABLE') || errMsg.includes('high demand') || errMsg.includes('RESOURCE_EXHAUSTED');

        console.warn(`[GeminiExtractor] Attempt ${attempt}/${maxRetries} with ${modelToTry} failed (${errMsg})`);

        if (isTransient503or429 && attempt < maxRetries) {
          const backoffMs = attempt * 500 + Math.floor(Math.random() * 300);
          console.warn(`[GeminiExtractor] Retrying ${modelToTry} in ${backoffMs}ms...`);
          await sleep(backoffMs);
          continue;
        }

        // Break to cascade to next candidate model
        break;
      }
    }
  }

  // If all candidate models failed, throw a clean, informative error
  console.error('[GeminiExtractor] All fallback models failed.', lastError);
  throw lastError || new Error('All AI model endpoints are temporarily busy. Please try again.');
}
