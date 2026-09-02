/**
 * Safe URL content fetcher with SSRF prevention and content extraction.
 */

export interface FetchedUrlContent {
  url: string;
  title: string | null;
  description: string | null;
  bodySnippet: string;
  sourceDomain: string;
  success: boolean;
  error?: string;
}

/**
 * Checks if a string contains valid URLs.
 */
export function extractUrls(text: string): string[] {
  if (!text) return [];
  const urlRegex = /(https?:\/\/[^\s<>"'{}|\\^`[\]]+)/gi;
  const matches = text.match(urlRegex);
  return matches ? Array.from(new Set(matches)) : [];
}

/**
 * Checks whether text alone has sufficient detail for a reminder without fetching URL.
 * Criteria: Contains recognizable event dates/times, clear action verbs, or is longer than 50 chars with specific info.
 */
export function hasSufficientTextDetail(text: string): boolean {
  if (!text) return false;
  const cleaned = text.replace(/(https?:\/\/[^\s]+)/gi, '').trim();
  if (cleaned.length > 70) return true;

  // Date or time markers
  const datePatterns = /\b(on|at|by|due|tomorrow|tonight|next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month)|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}[\/\-\.]\d{1,2}|\d{1,2}:\d{2}\s*(am|pm)?)\b/i;
  
  // Specific action verbs or reminder phrases
  const actionPatterns = /\b(meeting|webinar|call|submit|pay|invoice|bill|appointment|register|deadline|event|flight|renew|cancel)\b/i;

  return datePatterns.test(cleaned) && actionPatterns.test(cleaned);
}

/**
 * Fetches content from a URL safely.
 */
export async function fetchUrlContent(rawUrl: string): Promise<FetchedUrlContent> {
  let urlObj: URL;
  try {
    urlObj = new URL(rawUrl);
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      throw new Error('Unsupported protocol. Only HTTP and HTTPS are permitted.');
    }
    // Basic SSRF guard against local network probes
    const hostname = urlObj.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      hostname.endsWith('.internal')
    ) {
      throw new Error('Private/internal network URLs are restricted for safety.');
    }
  } catch (err: any) {
    return {
      url: rawUrl,
      title: null,
      description: null,
      bodySnippet: '',
      sourceDomain: 'unknown',
      success: false,
      error: err.message || 'Invalid URL',
    };
  }

  const domain = urlObj.hostname.replace(/^www\./, '');

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(urlObj.toString(), {
      signal: controller.signal,
      headers: {
        'User-Agent': 'RemindlyBot/1.0 (+https://remindly.internal/bot; reminder-link-resolver)',
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        url: rawUrl,
        title: `${domain} Link`,
        description: null,
        bodySnippet: `Link to ${domain}`,
        sourceDomain: domain,
        success: false,
        error: `HTTP ${response.status}`,
      };
    }

    const contentType = response.headers.get('content-type') || '';
    const htmlText = await response.text();

    // Fast heuristic extraction from HTML
    let title: string | null = null;
    let description: string | null = null;

    // 1. Extract <title>
    const titleMatch = htmlText.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      title = titleMatch[1].trim().replace(/[\r\n\t]+/g, ' ');
    }

    // 2. Extract og:title or twitter:title
    const ogTitleMatch = htmlText.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
      htmlText.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    if (ogTitleMatch && ogTitleMatch[1]) {
      title = ogTitleMatch[1].trim();
    }

    // 3. Extract description
    const descMatch = htmlText.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
      htmlText.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
    if (descMatch && descMatch[1]) {
      description = descMatch[1].trim().replace(/[\r\n\t]+/g, ' ');
    }

    // 4. Strip scripts, styles, tags for clean text body snippet
    let cleanText = htmlText
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();

    const bodySnippet = cleanText.slice(0, 1000);

    return {
      url: rawUrl,
      title: title || `${domain} Event / Reminder`,
      description,
      bodySnippet: bodySnippet || description || title || rawUrl,
      sourceDomain: domain,
      success: true,
    };
  } catch (err: any) {
    return {
      url: rawUrl,
      title: `${domain} Link`,
      description: null,
      bodySnippet: `Link to ${domain}`,
      sourceDomain: domain,
      success: false,
      error: err.message || 'Fetch failed',
    };
  }
}
