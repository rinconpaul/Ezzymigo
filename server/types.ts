// Shared TypeScript definitions for Ezzymigo Server Architecture

export interface SqlStatement {
  sql: string;
  args?: any[];
}

export interface SqlRow {
  [key: string]: any;
}

export interface SqlResultBlock {
  rows: SqlRow[];
  affected_rows: number;
}

export interface DbMemoryRow {
  id: string;
  originalText: string;
  createdAt: string;
  isDone: number | boolean;
  content: string;
  kind: string;
  status: string;
  people: string;
  places: string;
  topics: string;
  resurfacingMode: string;
  resurfacingTiming: string;
}

export interface RelationshipRow {
  id: string;
  person: string;
  role: string;
  normalized_role: string;
  is_active: number | boolean;
  updated_at: string;
}

export interface UserEntityRow {
  id: string;
  name: string;
  entity_type: string;
  role?: string | null;
  normalized_role?: string | null;
  metadata: string;
  updated_at: string;
}

export interface CalendarEventRow {
  id: string;
  source: string;
  sourceEventId: string;
  title: string;
  description?: string | null;
  location?: string | null;
  attendees: string;
  startDatetime: string;
  endDatetime: string;
  isAllDay: number | boolean;
  status: string;
  updatedAt: string;
}

export interface ScheduledReminderRow {
  id: string;
  memoryId: string;
  title: string;
  body: string;
  remindAt: string;
  notified: number | boolean;
  createdAt: string;
}

export interface VapidConfigRow {
  id: string;
  publicKey: string;
  privateKey: string;
  createdAt: string;
}

export interface LocalContextInfo {
  nowLocal: string;
  todayYMD: string;
  dayOfWeek: string;
  timeStr: string;
  userTimezone: string;
}

export interface MemoryTodayLifecycleBounds {
  isApplicableToday: boolean;
  phase: 'upcoming' | 'current' | 'past' | 'reflection_due' | 'undated' | 'none';
  todayStatusHeadline: string;
  startLocal?: string;
  endLocal?: string;
  isRecurringInstance?: boolean;
}
