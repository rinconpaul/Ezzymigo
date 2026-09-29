import { GoogleGenAI } from '@google/genai';

// Helper to detect if execution is within an automated test, benchmark, or verify script
export function isAutomatedTestRunner(): boolean {
  if (process.env.NODE_ENV === 'test') return true;
  if (process.env.IS_TEST_RUN === 'true' || process.env.IS_TEST === 'true' || process.env.VITEST === 'true') return true;
  if (process.env.BLOCK_PRODUCTION_GEMINI === 'true') return true;
  if (typeof process !== 'undefined' && Array.isArray(process.argv)) {
    return process.argv.some((arg) => {
      const a = arg.toLowerCase();
      return (
        a.includes('/scripts/') ||
        a.includes('test-') ||
        a.includes('torture') ||
        a.includes('benchmark') ||
        a.includes('audit') ||
        a.includes('verify') ||
        a.endsWith('.test.ts') ||
        a.endsWith('.test.js')
      );
    });
  }
  return false;
}

// Lazy Gemini client helper
export function getGeminiClient(): GoogleGenAI | null {
  // PERMANENT GUARD: Prevent automated test runners from consuming production Gemini quota
  if (isAutomatedTestRunner() && process.env.ALLOW_LIVE_GEMINI_IN_TESTS !== 'true') {
    console.warn('[PERMANENT GUARD] Automated test runner detected. Live Gemini API calls are blocked to prevent quota consumption. Use mocks/fixtures.');
    return null;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('GEMINI_API_KEY is not set in environment variables');
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

export async function generateWithRetry(
  ai: GoogleGenAI,
  params: {
    model: string;
    contents: string;
    config: any;
  },
  maxRetries: number = 4
): Promise<any> {
  let attempt = 0;
  let lastError: any = null;
  while (attempt < maxRetries) {
    attempt++;
    try {
      return await ai.models.generateContent(params);
    } catch (err: any) {
      lastError = err;
      const status = err?.status || err?.code || 0;
      const msg = String(err?.message || '');
      const isRetryable =
        status === 503 ||
        status === 429 ||
        msg.includes('overloaded') ||
        msg.includes('demand') ||
        msg.includes('UNAVAILABLE');

      if (isRetryable && attempt < maxRetries) {
        const delayMs = attempt * 1200;
        console.warn(`[Gemini Retry] Attempt ${attempt} failed with status ${status} (${msg}). Retrying in ${delayMs}ms...`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}
