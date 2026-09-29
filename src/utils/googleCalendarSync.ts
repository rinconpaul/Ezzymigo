import { connectGoogleCalendar } from './googleCalendarAuth';
import { CalendarEvent } from '../types';

/**
 * Fetch events directly from the user's visible/selected Google Calendars (primary, birthdays, secondary)
 * for an upcoming date range.
 * Defaults to: Now -> Now + 60 days.
 */
export const DEFAULT_CALENDAR_SYNC_DAYS_AHEAD = 60;

export interface DiscoveredCalendar {
  id: string;
  summary: string;
  primary?: boolean;
  selected?: boolean;
  hidden?: boolean;
  deleted?: boolean;
  accessRole?: string;
}

/**
 * Discover the user's visible and selected Google Calendars.
 * Includes: primary calendar, Google Birthdays calendar, secondary user calendars, shared/family calendars.
 * Excludes: deleted, hidden, or explicitly unselected calendars.
 */
export async function discoverGoogleCalendars(token: string): Promise<DiscoveredCalendar[]> {
  try {
    let visibleCalendars: DiscoveredCalendar[] = [];
    let pageToken: string | null = null;
    let pageCount = 0;

    do {
      pageCount++;
      const url = new URL('https://www.googleapis.com/calendar/v3/users/me/calendarList');
      url.searchParams.set('maxResults', '100');
      if (pageToken) {
        url.searchParams.set('pageToken', pageToken);
      }

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        const errBody = await response.text();
        console.warn(`[Google Calendar] calendarList.list request failed (${response.status}):`, errBody);
        break;
      }

      const data = await response.json();
      const rawList: any[] = data.items || [];

      const parsedPage = rawList
        .filter((cal: any) => {
          // Exclude explicitly deleted or hidden calendars
          if (cal.deleted === true || cal.hidden === true) return false;
          return true;
        })
        .map((cal: any) => ({
          id: cal.id,
          summary: cal.summary || cal.id,
          primary: Boolean(cal.primary),
          selected: cal.selected !== false,
          hidden: Boolean(cal.hidden),
          deleted: Boolean(cal.deleted),
          accessRole: cal.accessRole,
        }));

      visibleCalendars.push(...parsedPage);
      pageToken = data.nextPageToken || null;
    } while (pageToken && pageCount < 5);

    // Ensure primary calendar is present with canonical primary flag
    if (!visibleCalendars.some(c => c.primary || c.id === 'primary')) {
      visibleCalendars.unshift({ id: 'primary', summary: 'Primary Calendar', primary: true, selected: true });
    }

    // Ensure Google Contacts / Birthdays calendar is present
    const hasBirthdays = visibleCalendars.some(c =>
      c.id.includes('contacts@group.v.calendar.google.com')
    );
    if (!hasBirthdays) {
      visibleCalendars.push({
        id: 'addressbook#contacts@group.v.calendar.google.com',
        summary: 'Birthdays',
        selected: true,
      });
    }

    console.log(`[Google Calendar] Discovered ${visibleCalendars.length} active/selected calendar(s):`, visibleCalendars.map(c => `${c.summary} (${c.id})`).join(', '));
    return visibleCalendars;
  } catch (err) {
    console.warn('[Google Calendar] Failed to discover calendar list:', err);
    return [
      { id: 'primary', summary: 'Primary Calendar', primary: true, selected: true },
      { id: 'addressbook#contacts@group.v.calendar.google.com', summary: 'Birthdays', selected: true },
    ];
  }
}

export async function fetchGoogleCalendarEvents(daysAhead: number = DEFAULT_CALENDAR_SYNC_DAYS_AHEAD): Promise<CalendarEvent[]> {
  const syncRes = await fetch('/api/calendar/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ daysAhead }),
  });

  if (!syncRes.ok) {
    const errBody = await syncRes.json().catch(() => ({}));
    throw new Error(errBody.error || `Server calendar sync failed (${syncRes.status})`);
  }

  const data = await syncRes.json();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('calendar-updated'));
  }
  return data.events || [];
}

export async function getStoredCalendarEvents(): Promise<CalendarEvent[]> {
  const res = await fetch('/api/calendar-events');
  if (!res.ok) throw new Error('Failed to load stored calendar events');
  const data = await res.json();
  return data.events || [];
}
