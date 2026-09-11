import { GoogleGenAI } from '@google/genai';

// Lazy Gemini client helper
export function getGeminiClient(): GoogleGenAI | null {
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
