import { TodayRelevanceCandidate } from '../types';

export interface EphemeralCallSession {
  recipientName: string;
  role?: string;
  actionType: 'call';
  launchedAt: number;
  hasLeftForeground: boolean;
}

/**
 * In-memory client-side bridge for Ezzy-assisted call -> OS yield -> return capture.
 * Purely ephemeral: never persisted to localStorage, sessionStorage, or database.
 * Does not survive page reload.
 */
export class EphemeralCallBridge {
  private activeSession: EphemeralCallSession | null = null;
  private currentCandidate: TodayRelevanceCandidate | null = null;

  /**
   * Called when Ezzy successfully launches a call device action (tel:).
   */
  recordCallLaunch(recipientName: string, role?: string): void {
    const person = (recipientName || role || 'Contact').trim();
    this.activeSession = {
      recipientName: person,
      role,
      actionType: 'call',
      launchedAt: Date.now(),
      hasLeftForeground: false,
    };
  }

  /**
   * Called when the PWA yields to OS / leaves the foreground (visibilitychange hidden, blur, pagehide).
   */
  handleAppBackground(): void {
    if (this.activeSession && !this.activeSession.hasLeftForeground) {
      this.activeSession.hasLeftForeground = true;
    }
  }

  /**
   * Called when the PWA returns to the foreground (visibilitychange visible, focus, pageshow).
   * Invariant: surfaces candidate ONLY IF the app previously left the foreground after call launch.
   */
  handleAppForeground(): TodayRelevanceCandidate | null {
    if (!this.activeSession) {
      return this.currentCandidate;
    }

    // Invariant: launch without actual background transition -> no candidate
    if (!this.activeSession.hasLeftForeground) {
      return null;
    }

    const person = this.activeSession.recipientName;
    const launchedAt = this.activeSession.launchedAt;

    const candidate: TodayRelevanceCandidate = {
      source_type: 'calendar',
      source_id: `ephemeral_call:${person}:${launchedAt}`,
      occurrence_id: `ephemeral_call:${person}:${launchedAt}`,
      relevance_reason: 'Post-call follow-up',
      display_text: `Call with ${person} — anything you want Ezzy to remember or remind you about?`,
      priority: 0,
      is_anticipatory: true,
      anticipatory_stage: 'reflect',
      event_title: `Call with ${person}`,
      ticker_headlines: [`Call with ${person} — anything you want Ezzy to remember or remind you about?`],
    };

    // Consume active session and set current candidate
    this.activeSession = null;
    this.currentCandidate = candidate;
    return candidate;
  }

  getCandidate(): TodayRelevanceCandidate | null {
    return this.currentCandidate;
  }

  getActiveSession(): EphemeralCallSession | null {
    return this.activeSession;
  }

  dismissCandidate(): void {
    this.currentCandidate = null;
    this.activeSession = null;
  }

  /**
   * Reset all in-memory state (simulating page reload or component unmount).
   */
  reset(): void {
    this.activeSession = null;
    this.currentCandidate = null;
  }
}

export const ephemeralCallBridge = new EphemeralCallBridge();
