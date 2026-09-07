export type CandidateResolutionStatus =
  | 'ACTIVE'
  | 'SATISFIED'
  | 'SUPERSEDED'
  | 'STALE'
  | 'RESTRAINED'
  | 'DISMISSED';

export interface CandidateCommunication {
  id: string;
  evaluationId: string;
  opportunity: string;
  mode: 'SPEAK' | 'PROMPT';
  headline: string | null;
  body: string | null;
  question: string | null;
  citedMemoryIds: string[];
  citedCalendarIds: string[];
  generatedAt: string;
  rationale: string;
}

export interface ChannelInteraction {
  id: string;
  ezzyId: string;
  communicationId: string;
  evaluationId?: string | null;
  opportunity?: string | null;
  promptHeadline?: string | null;
  promptQuestion?: string | null;
  userResponse: string;
  capturedMemoryId?: string | null;
  createdAt: string;
}

export interface CandidateResolution {
  candidateId: string;
  status: CandidateResolutionStatus;
  reason: string;
}

export interface CuratedChannelCommunication {
  id: string;
  mode: 'SPEAK' | 'PROMPT';
  headline: string | null;
  body: string | null;
  question: string | null;
  sourceCandidateIds: string[];
  linkedEventId?: string | null;
  priorityRationale: string;
}

export interface AttentionReviewDecision {
  curatedCommunications: CuratedChannelCommunication[];
  candidateResolutions: CandidateResolution[];
  overallRationale: string;
  silencePreferred: boolean;
}

export interface AttentionReviewInput {
  ezzyId: string;
  civilTime: {
    iso: string;
    timeZone: string;
    dateYMD: string;
    timeStr: string;
    dayOfWeek: string;
  };
  candidatePool: CandidateCommunication[];
  recentInteractions: ChannelInteraction[];
  recentlyPresentedItems: Array<{
    communicationId: string;
    headline?: string | null;
    question?: string | null;
    presentedAt: string;
  }>;
  relevantCalendarContext: Array<{
    id: string;
    title: string;
    start: string;
    end: string;
    status: 'upcoming' | 'current' | 'recently_ended';
  }>;
  explicitDismissals?: Array<{
    communicationId: string;
    dismissedAt: string;
    reason?: string;
  }>;
}

export interface ShadowAttentionReviewRecord {
  id: string;
  ezzy_id: string;
  timestamp: string;
  trigger_name: string;
  active_channel: CuratedChannelCommunication[];
  candidate_resolutions: CandidateResolution[];
  overall_rationale: string;
  model_name: string;
  latency_ms: number;
  prompt_tokens: number;
  output_tokens: number;
  created_at: string;
}
