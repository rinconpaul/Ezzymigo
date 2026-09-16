export type CapabilityName = 'search_places';

export interface SearchPlacesRequest {
  query: string;
  location?: string;
  category?: string;
  placeType?: string;
  criteria?: string[];
  limit?: number;
}

export interface NormalizedPlace {
  id?: string;
  name: string;
  address: string;
  locality?: string;
  rating?: number | null;
  userRatingCount?: number | null;
  priceLevel?: string | null;
  features?: string[];
  summary?: string;
  phoneNumber?: string | null;
  websiteUrl?: string | null;
  googleMapsUri?: string | null;
  actionableSummary?: string;
}

export type LocationSource = 'explicit' | 'user_home' | 'locality' | 'clarification';

export interface SearchPlacesResult {
  success: boolean;
  query: string;
  locationUsed: string;
  locationSource: LocationSource;
  places: NormalizedPlace[];
  summary: string;
  rawError?: string;
}

export interface CapabilityExecutionRequest {
  ezzyId: string;
  capability: CapabilityName;
  parameters: Record<string, any>;
  clientNow?: string;
  clientTimeZone?: string;
  clientRegion?: string;
  userMemories?: Array<{ content?: string; originalText?: string }>;
}

export interface CapabilityExecutionResult<T = any> {
  capability: CapabilityName;
  success: boolean;
  data: T;
  executedAt: string;
  latencyMs: number;
}
