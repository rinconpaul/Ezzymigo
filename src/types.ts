export type InboxFilterType = 'all' | 'reminders' | 'facts' | 'not_sure';

export interface UserPreferences {
  language: string; // BCP-47 language tag, e.g. "en-AU", "vi-VN", "es-ES"
  region: string;   // ISO 3166-1 alpha-2 country code, e.g. "AU", "US", "PT", "VN"
  timezone: string; // IANA timezone, e.g. "Australia/Sydney", "Europe/Lisbon"
  currency: string; // ISO 4217 currency code, e.g. "AUD", "USD", "EUR", "VND"
}

export interface I18nContextPayload {
  language: string;
  region: string;
  timezone: string;
  currency?: string;
  now?: string;
}

export interface ResurfacingInfo {
  mode: string;
  timing: string;
}

export interface SuggestedAction {
  type: 'web_search' | string;
  label: string;
  query: string;
}

export interface LookupCorrection {
  field?: string;
  current_value?: string;
  suggested_value?: string;
  full_corrected_text: string;
  explanation?: string;
}

export interface LookupActionResult {
  title: string;
  source_name: string;
  url: string;
  price?: string | null;
  availability?: string | null;
  action_type?: string;
}

export interface LookupResult {
  item_title?: string | null;
  creator?: string | null;
  category?: string | null;
  summary: string;
  actionable_results?: LookupActionResult[];
  sources?: Array<{ title: string; url: string }>;
  verified: boolean;
  correction?: LookupCorrection | null;
}

export interface UserRelationship {
  id: string;
  person: string;
  role: string;
  normalized_role: string;
  is_active: boolean;
  updated_at: string;
}

export interface UserEntity {
  id: string;
  name: string;
  entity_type: 'person' | 'place' | 'organization' | string;
  role?: string | null;
  normalized_role?: string | null;
  metadata?: Record<string, any>;
  updated_at: string;
}

export interface PhoneOffer {
  person: string;
  role: string;
  memoryId?: string;
}

export interface ClarificationPrompt {
  id: string;
  question: string;
  entityName: string;
  entityType: 'person' | 'relationship' | 'place' | 'time_meridiem' | 'phone_offer' | string;
  candidateOptions?: string[];
  memoryId?: string;
  context?: string;
  metadata?: Record<string, any>;
}

export type AnticipatoryMode = 'NONE' | 'POST_ONLY' | 'PRE_AND_POST';

export interface AnticipationOffer {
  memoryId: string;
  mode: AnticipatoryMode;
  question: string;
  eventTitle?: string;
  person?: string;
}

export interface RelationshipEntity {
  person: string;
  role: string;
  is_active?: boolean;
}

export interface PrerequisiteInfo {
  condition: string;
  status: 'pending' | 'resolved' | string;
  expected_time_expression?: string | null;
  expected_datetime?: string | null;
}

export interface StructuredInterpretation {
  content: string;
  kind: string;
  intent?: string;
  status: 'active' | 'done' | string;
  subject?: string | null;
  subject_resolved_date?: string | null;
  people: string[];
  places: string[];
  topics: string[];
  contexts?: string[];
  retrieval_cues?: string[];
  items?: string[];
  relationships?: RelationshipEntity[];
  prerequisite?: PrerequisiteInfo | null;
  original_time_expression?: string | null;
  resolved_datetime?: string | null;
  event_time_expression?: string | null;
  event_datetime?: string | null;
  reminder_time_expression?: string | null;
  reminder_datetime?: string | null;
  resurfacing: ResurfacingInfo;
  suggested_action?: SuggestedAction | null;
  linked_event_id?: string | null;
  anticipatory_mode?: AnticipatoryMode;
  anticipatory_opted_in?: boolean;
}

export interface MemoryItem {
  id: string;
  originalText: string;
  createdAt: string;
  isDone: boolean;
  interpretation: StructuredInterpretation;
  anticipatory_mode?: AnticipatoryMode;
  anticipatory_opted_in?: boolean;
}

export interface CalendarEvent {
  id: string;
  source: 'google_calendar' | 'ics' | string;
  source_event_id: string;
  title: string;
  description?: string | null;
  location?: string | null;
  attendees: string[];
  start_datetime: string;
  end_datetime: string;
  is_all_day: boolean;
  status: 'confirmed' | 'cancelled' | string;
  updated_at: string;
  anticipatory_mode?: AnticipatoryMode;
  anticipatory_opted_in?: boolean;
}

export interface AskResponse {
  answer: string;
  memory_ids?: string[];
  calendar_event_ids?: string[];
  confirmation_required?: boolean;
  pending_action?: {
    type: string;
    entityName: string;
  };
}

export interface TodayRelevanceCandidate {
  source_type: 'memory' | 'calendar';
  source_id: string;
  occurrence_id?: string;
  relevance_reason: string;
  display_text: string;
  priority: number;
  is_anticipatory?: boolean;
  anticipatory_stage?: 'prepare' | 'remind' | 'reflect';
  event_title?: string;
  event_time?: string;
  preparation_items?: string[];
  ticker_headlines?: string[];
  prep_memory_ids?: string[];
  anticipatory_mode?: AnticipatoryMode;
}

export interface TodayRelevanceResponse {
  candidates: TodayRelevanceCandidate[];
  reference_time?: string;
  timezone?: string;
}

export interface ImmediateDeviceActionPayload {
  status: 'ready' | 'missing_number' | 'ambiguous' | 'unknown_person';
  action: 'call' | 'sms' | 'none';
  recipientName?: string;
  role?: string;
  phoneNumber?: string;
  sanitizedPhone?: string;
  prefilledMessage?: string;
  feedbackMessage: string;
  candidates?: Array<{ name: string; role?: string }>;
}


