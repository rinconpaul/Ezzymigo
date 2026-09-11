export type ThinkingOpportunity =
  | 'TODAY_ORIENT'
  | 'PRE_EVENT'
  | 'POST_EVENT'
  | 'INBOUND_TELL'
  | 'ASK_QUERY'
  | 'POST_CALL';

export interface SnapshotCalendarEvent {
  id: string;
  title: string;
  startDatetime: string;
  endDatetime: string;
  isAllDay: boolean;
  location?: string | null;
  description?: string | null;
  status?: string;
  hoursUntilStart?: number;
  hoursSinceEnd?: number;
}

export interface SnapshotMemoryItem {
  id: string;
  originalText: string;
  content: string;
  kind: string;
  status: string;
  isDone: boolean;
  createdAt: string;
  people: string[];
  places: string[];
  topics: string[];
  timingExpression?: string | null;
  reminderDatetime?: string | null;
  resurfacingTiming?: string | null;
}

export interface SnapshotEntityRelationship {
  person: string;
  role: string;
  normalizedRole?: string;
}

export interface SnapshotOccasion {
  id: string;
  name: string;
  targetYMD: string;
  daysUntil: number;
  temporalDescription: string;
  isToday: boolean;
}

export interface SnapshotRecentInteraction {
  type: 'tell' | 'ask' | 'today_action' | 'reflection';
  summary: string;
  timestamp: string;
  resolved?: boolean;
}

export interface EzzyWorldSnapshot {
  ezzyId: string;
  opportunity: ThinkingOpportunity;
  trigger: string;
  civilTime: {
    iso: string;
    timeZone: string;
    dateYMD: string;
    timeStr: string;
    dayOfWeek: string;
    timePhase: 'morning' | 'afternoon' | 'evening' | 'night';
  };
  calendar: {
    todayEvents: SnapshotCalendarEvent[];
    recentlyCompletedEvents: SnapshotCalendarEvent[];
    upcomingEvents: SnapshotCalendarEvent[];
    tomorrowMorningEvents: SnapshotCalendarEvent[];
  };
  commitments: {
    todayDatedMemories: SnapshotMemoryItem[];
    tomorrowMorningDatedMemories: SnapshotMemoryItem[];
    dueOrOverdueReminders: Array<{
      id: string;
      memoryId: string;
      title: string;
      body?: string;
      remindAt: string;
      isOverdue: boolean;
    }>;
  };
  timedReminders: Array<{
    id: string;
    memoryId: string;
    title: string;
    remindAt: string;
    isOverdue?: boolean;
  }>;
  activeMemories: SnapshotMemoryItem[];
  recentCompletedOrHistoricalMemories: SnapshotMemoryItem[];
  relationships: SnapshotEntityRelationship[];
  occasions: SnapshotOccasion[];
  recentInteractions: SnapshotRecentInteraction[];
  currentScreenContext?: {
    activeTickerItem?: any;
    recentCandidateResolutions?: any[];
    visibleAppointments?: any[];
  };
}

export interface ReasoningDecision {
  communication: {
    mode: 'SPEAK' | 'PROMPT' | 'SILENT';
    headline: string | null;
    body: string | null;
    question: string | null;
    reason?: string | null;
    source?: string | null;
    priority?: string | null;
    eligibleAt?: string | null;
    expiresAt?: string | null;
    suppressionState?: string | null;
  };
  proposedMutations: Array<{
    originalText: string;
    content: string;
    kind: 'fact' | 'task' | 'reminder' | 'note';
    timingExpression?: string | null;
    isDone: boolean;
  }>;
  proposedResolutions: string[];
  citedMemoryIds: string[];
  citedCalendarIds: string[];
  rationale: string;
}

export type FeedbackVerdict =
  | 'OLD_BETTER'
  | 'NEW_BETTER'
  | 'BOTH_OK'
  | 'NEITHER'
  | 'USEFUL'
  | 'NOT_USEFUL';

export interface ShadowEvaluationRecord {
  id: string;
  ezzy_id: string;
  timestamp: string;
  opportunity: ThinkingOpportunity;
  trigger_name: string;
  old_ezzy_outcome: any;
  new_ezzy_decision: ReasoningDecision;
  new_ezzy_rationale: string;
  cited_memory_ids: string[];
  cited_calendar_ids: string[];
  model_name: string;
  latency_ms: number;
  prompt_tokens: number;
  output_tokens: number;
  verdict: FeedbackVerdict | null;
  verdict_comment: string | null;
  created_at: string;
  updated_at: string;
}
