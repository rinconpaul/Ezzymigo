import {
  canonicalizeCalendarEvent,
  upsertCalendarEvents,
  readCalendarEvents,
  queryCalendarEvents,
  deleteCalendarEventFromDb,
  QueryCalendarEventsOptions,
} from './store';

// -------------------------------------------------------------
// Provider-Independent Calendar Adapter Contract (Pre-Flutter Gate 3)
// -------------------------------------------------------------

export interface NormalizedCalendarEvent {
  id: string;
  source: string;              // 'google_calendar' | 'apple_calendar' | 'device_calendar' | etc.
  sourceEventId: string;       // External provider ID
  source_event_id?: string;    // Compatibility alias
  title: string;
  description?: string | null;
  location?: string | null;
  attendees?: string[];
  start_datetime: string;      // ISO 8601 string or YYYY-MM-DD for all-day events
  end_datetime?: string | null;// ISO 8601 string or YYYY-MM-DD for all-day events
  is_all_day: boolean;
  status: string;             // 'confirmed' | 'tentative' | 'cancelled'
  ezzy_id?: string;
  updated_at?: string;
}

export interface CalendarSyncResult {
  success: boolean;
  count: number;
  ezzy_id: string;
  provider: string;
}

export interface CalendarAdapter {
  readonly provider: string;
  normalize(rawEvent: Record<string, any>): NormalizedCalendarEvent;
  syncEvents(events: Record<string, any>[], ezzyId: string): Promise<CalendarSyncResult>;
  queryEvents(options: QueryCalendarEventsOptions, ezzyId?: string): Promise<NormalizedCalendarEvent[]>;
  readEvents(options?: { startAfter?: string; startBefore?: string; limit?: number }, ezzyId?: string): Promise<NormalizedCalendarEvent[]>;
  deleteEvent(id: string, ezzyId?: string): Promise<void>;
}

export class DefaultCalendarAdapter implements CalendarAdapter {
  constructor(public readonly provider: string = 'google_calendar') {}

  normalize(rawEvent: Record<string, any>): NormalizedCalendarEvent {
    const source = rawEvent.source || this.provider;
    const { id, sourceEventId } = canonicalizeCalendarEvent({ ...rawEvent, source });
    const isAllDay = Boolean(rawEvent.is_all_day || rawEvent.isAllDay);
    const start = rawEvent.start_datetime || rawEvent.startDatetime || new Date().toISOString();
    const end = rawEvent.end_datetime || rawEvent.endDatetime || null;
    return {
      id,
      source,
      sourceEventId,
      source_event_id: sourceEventId,
      title: rawEvent.title || 'Untitled Event',
      description: rawEvent.description || null,
      location: rawEvent.location || null,
      attendees: Array.isArray(rawEvent.attendees) ? rawEvent.attendees : [],
      start_datetime: isAllDay ? String(start).slice(0, 10) : start,
      end_datetime: isAllDay && end ? String(end).slice(0, 10) : end,
      is_all_day: isAllDay,
      status: rawEvent.status || 'confirmed',
      ezzy_id: rawEvent.ezzy_id,
      updated_at: rawEvent.updated_at || rawEvent.updatedAt || new Date().toISOString(),
    };
  }

  async syncEvents(events: Record<string, any>[], ezzyId: string): Promise<CalendarSyncResult> {
    const normalized = events.map(e => this.normalize(e));
    await upsertCalendarEvents(normalized, ezzyId);
    return {
      success: true,
      count: normalized.length,
      ezzy_id: ezzyId,
      provider: this.provider,
    };
  }

  async queryEvents(options: QueryCalendarEventsOptions, ezzyId?: string): Promise<NormalizedCalendarEvent[]> {
    return queryCalendarEvents(options, ezzyId);
  }

  async readEvents(
    options: { startAfter?: string; startBefore?: string; limit?: number } = {},
    ezzyId?: string
  ): Promise<NormalizedCalendarEvent[]> {
    return readCalendarEvents(options, ezzyId);
  }

  async deleteEvent(id: string, ezzyId?: string): Promise<void> {
    return deleteCalendarEventFromDb(id, ezzyId);
  }
}

export const googleCalendarAdapter = new DefaultCalendarAdapter('google_calendar');
export const appleCalendarAdapter = new DefaultCalendarAdapter('apple_calendar');
export const deviceCalendarAdapter = new DefaultCalendarAdapter('device_calendar');

export function getCalendarAdapter(provider: string = 'google_calendar'): CalendarAdapter {
  const norm = provider.toLowerCase();
  if (norm.includes('apple')) return appleCalendarAdapter;
  if (norm.includes('device')) return deviceCalendarAdapter;
  return googleCalendarAdapter;
}
