export interface ResurfacingInfo {
  mode: string;
  timing: string;
}

export interface StructuredInterpretation {
  content: string;
  kind: string;
  intent?: string;
  status: 'active' | 'done' | string;
  people: string[];
  places: string[];
  topics: string[];
  contexts?: string[];
  retrieval_cues?: string[];
  original_time_expression?: string | null;
  resolved_datetime?: string | null;
  event_time_expression?: string | null;
  event_datetime?: string | null;
  reminder_time_expression?: string | null;
  reminder_datetime?: string | null;
  resurfacing: ResurfacingInfo;
}

export interface MemoryItem {
  id: string;
  originalText: string;
  createdAt: string;
  isDone: boolean;
  interpretation: StructuredInterpretation;
}
