import { LocationSource } from './types';

export interface LocationResolutionInput {
  explicitLocation?: string | null;
  userMemories?: Array<{ content?: string; originalText?: string }>;
  clientRegion?: string | null;
  clientTimeZone?: string | null;
  defaultFallbackLocality?: string;
}

export interface ResolvedLocation {
  location: string;
  source: LocationSource;
  confidence: 'high' | 'medium' | 'low';
  requiresClarification: boolean;
}

/**
 * Privacy-preserving Location Hierarchy Resolver:
 * Rule: Do not silently acquire precise location.
 * Hierarchy:
 * 1. Explicit location if provided in request/event/utterance.
 * 2. Home or general location from user profile / memories.
 * 3. Broad locality from user region or timezone.
 * 4. Ask for clarification if location is ambiguous or unknown.
 */
export function resolveLocationHierarchy(input: LocationResolutionInput): ResolvedLocation {
  // 1. Explicit location
  const explicit = (input.explicitLocation || '').trim();
  if (explicit && explicit.toLowerCase() !== 'unknown' && explicit.toLowerCase() !== 'here') {
    return {
      location: explicit,
      source: 'explicit',
      confidence: 'high',
      requiresClarification: false,
    };
  }

  // 2. Home or general location from user memories
  if (Array.isArray(input.userMemories) && input.userMemories.length > 0) {
    for (const mem of input.userMemories) {
      const text = `${mem.content || ''} ${mem.originalText || ''}`.toLowerCase();
      // Look for home or living location indicators
      const homeMatch = text.match(/(?:live in|lives in|home is in|moved to|house in|based in|resides in)\s+([a-zA-Z\s,]+?)(?:\.|\,|$|\sand\s)/i);
      if (homeMatch && homeMatch[1]) {
        const found = homeMatch[1].trim();
        if (found.length > 2 && found.length < 50) {
          return {
            location: found,
            source: 'user_home',
            confidence: 'high',
            requiresClarification: false,
          };
        }
      }
    }
  }

  // 3. Broad locality from region or timezone
  const region = (input.clientRegion || '').trim().toUpperCase();
  const tz = (input.clientTimeZone || '').trim();

  if (region === 'AU-ACT' || tz.includes('Canberra') || (region.startsWith('AU') && tz.includes('Sydney') && region === 'AU-ACT')) {
    return {
      location: 'Canberra, ACT',
      source: 'locality',
      confidence: 'medium',
      requiresClarification: false,
    };
  }

  if (region === 'AU-NSW' || tz === 'Australia/Sydney') {
    return {
      location: 'Sydney, NSW',
      source: 'locality',
      confidence: 'medium',
      requiresClarification: false,
    };
  }

  if (region === 'AU-VIC' || tz === 'Australia/Melbourne') {
    return {
      location: 'Melbourne, VIC',
      source: 'locality',
      confidence: 'medium',
      requiresClarification: false,
    };
  }

  if (region === 'AU-QLD' || tz === 'Australia/Brisbane') {
    return {
      location: 'Brisbane, QLD',
      source: 'locality',
      confidence: 'medium',
      requiresClarification: false,
    };
  }

  if (region === 'AU-WA' || tz === 'Australia/Perth') {
    return {
      location: 'Perth, WA',
      source: 'locality',
      confidence: 'medium',
      requiresClarification: false,
    };
  }

  if (region === 'AU-SA' || tz === 'Australia/Adelaide') {
    return {
      location: 'Adelaide, SA',
      source: 'locality',
      confidence: 'medium',
      requiresClarification: false,
    };
  }

  if (region === 'AU-TAS' || tz === 'Australia/Hobart') {
    return {
      location: 'Hobart, TAS',
      source: 'locality',
      confidence: 'medium',
      requiresClarification: false,
    };
  }

  if (tz) {
    const parts = tz.split('/');
    if (parts.length > 1) {
      const city = parts[1].replace(/_/g, ' ');
      return {
        location: city,
        source: 'locality',
        confidence: 'low',
        requiresClarification: false,
      };
    }
  }

  if (input.defaultFallbackLocality) {
    return {
      location: input.defaultFallbackLocality,
      source: 'locality',
      confidence: 'low',
      requiresClarification: false,
    };
  }

  // 4. Requires clarification
  return {
    location: '',
    source: 'clarification',
    confidence: 'low',
    requiresClarification: true,
  };
}
