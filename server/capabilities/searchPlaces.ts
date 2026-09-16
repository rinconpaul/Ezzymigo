import { GoogleGenAI } from '@google/genai';
import { getGeminiClient, generateWithRetry } from '../config/gemini';
import { resolveLocationHierarchy } from './location';
import {
  SearchPlacesRequest,
  SearchPlacesResult,
  NormalizedPlace,
} from './types';

export interface ExecuteSearchPlacesOptions {
  request: SearchPlacesRequest;
  userMemories?: Array<{ content?: string; originalText?: string }>;
  clientTimeZone?: string;
  clientRegion?: string;
  aiClient?: GoogleGenAI | null;
}

export async function executeSearchPlaces(
  options: ExecuteSearchPlacesOptions
): Promise<SearchPlacesResult> {
  const { request, userMemories, clientTimeZone, clientRegion } = options;
  const ai = options.aiClient || getGeminiClient();
  if (!ai) {
    throw new Error('Gemini client unavailable: GEMINI_API_KEY is not configured');
  }

  // 1. Resolve location using strict privacy hierarchy
  const resolvedLoc = resolveLocationHierarchy({
    explicitLocation: request.location,
    userMemories,
    clientRegion,
    clientTimeZone,
  });

  if (resolvedLoc.requiresClarification || !resolvedLoc.location) {
    return {
      success: false,
      query: request.query,
      locationUsed: '',
      locationSource: 'clarification',
      places: [],
      summary: 'Location could not be determined. Please ask the user which area or suburb they prefer.',
    };
  }

  const locationUsed = resolvedLoc.location;
  const criteriaList = Array.isArray(request.criteria) ? request.criteria.join(', ') : '';
  const limit = request.limit || 3;

  const prompt = `You are the Grounded Places & Venue Researcher for Ezzymigo.
TASK: Research real, verified places or venues matching the user's specific request.

SEARCH QUERY: "${request.query}"
LOCATION: "${locationUsed}"
${criteriaList ? `CRITERIA / PREFERENCES: ${criteriaList}\n` : ''}
${request.placeType ? `PLACE TYPE: ${request.placeType}\n` : ''}
NUMBER OF OPTIONS REQUESTED: ${limit}

STRICT GROUNDING & ACCURACY INSTRUCTIONS:
1. You MUST find REAL, existing places in or near "${locationUsed}".
2. Do NOT invent fake addresses or fictional restaurants/businesses.
3. For each place, verify and extract:
   - "name": Official venue/business name
   - "address": Real full street address including suburb and state
   - "locality": Suburb/city
   - "rating": Actual Google or public review rating (number, e.g. 4.4, or null if unknown)
   - "userRatingCount": Number of reviews (number or null)
   - "priceLevel": e.g. "$$", "$$$", or null
   - "features": List of confirmed attributes matching the criteria (e.g. "Wheelchair accessible entrance and restrooms", "Quiet private dining area", "Good for milestone family birthdays", "Free visitor parking")
   - "phoneNumber": Official contact phone number if available, or null
   - "websiteUrl": Official website URL if available, or null
   - "actionableSummary": 1-2 sentence description explaining why this option suits the user's need.

SAFETY INVARIANT:
You are strictly an informational and research capability. Never claim to make bookings, place calls, or send messages.

Return ONLY a valid JSON object matching this structure:
{
  "places": [
    {
      "name": "...",
      "address": "...",
      "locality": "...",
      "rating": 4.5,
      "userRatingCount": 120,
      "priceLevel": "$$",
      "features": ["..."],
      "phoneNumber": "...",
      "websiteUrl": "...",
      "actionableSummary": "..."
    }
  ],
  "summary": "Brief 1-sentence overview of the research results for the user."
}`;

  try {
    const response = await generateWithRetry(ai, {
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: {
        tools: [{ googleSearch: {} }],
        temperature: 0.1,
      },
    });

    const rawText = response.text || '';
    let parsed: any;
    try {
      const jsonMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, rawText];
      parsed = JSON.parse(jsonMatch[1] || rawText);
    } catch {
      // Fallback extraction if model output had conversational wrapper
      const firstBrace = rawText.indexOf('{');
      const lastBrace = rawText.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace > firstBrace) {
        parsed = JSON.parse(rawText.slice(firstBrace, lastBrace + 1));
      } else {
        throw new Error('Failed to parse search_places response as JSON');
      }
    }

    const rawPlaces = Array.isArray(parsed.places) ? parsed.places : [];
    const places: NormalizedPlace[] = rawPlaces.map((p: any, idx: number) => ({
      id: `place_${Date.now()}_${idx}`,
      name: p.name || 'Unnamed venue',
      address: p.address || locationUsed,
      locality: p.locality || locationUsed,
      rating: typeof p.rating === 'number' ? p.rating : null,
      userRatingCount: typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
      priceLevel: p.priceLevel || null,
      features: Array.isArray(p.features) ? p.features : [],
      summary: p.summary || p.actionableSummary || '',
      phoneNumber: p.phoneNumber || null,
      websiteUrl: p.websiteUrl || null,
      googleMapsUri: p.googleMapsUri || (p.name && p.address ? `https://maps.google.com/?q=${encodeURIComponent(`${p.name}, ${p.address}`)}` : null),
      actionableSummary: p.actionableSummary || p.summary || '',
    }));

    return {
      success: true,
      query: request.query,
      locationUsed,
      locationSource: resolvedLoc.source,
      places,
      summary: parsed.summary || `Found ${places.length} suitable options in ${locationUsed}.`,
    };
  } catch (err: any) {
    console.error('[Search Places Capability] Execution error:', err);
    return {
      success: false,
      query: request.query,
      locationUsed,
      locationSource: resolvedLoc.source,
      places: [],
      summary: `Could not complete places search for "${request.query}" in ${locationUsed}.`,
      rawError: err?.message || String(err),
    };
  }
}
