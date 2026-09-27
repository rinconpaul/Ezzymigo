import { getGoogleAccessToken, connectGoogleCalendar } from './googleCalendarAuth';
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
  let token = getGoogleAccessToken();
  if (!token) {
    // If not in memory, trigger connection popup
    const authResult = await connectGoogleCalendar();
    token = authResult.accessToken;
  }

  if (!token) {
    throw new Error('No Google Calendar authorization token available. Please connect Google Calendar.');
  }

  // Query date boundaries anchored in Australia/Sydney
  const now = new Date();
  const startWindow = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const timeMin = startWindow.toISOString();
  const end = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const timeMax = end.toISOString();

  // 1. Discover all active, visible, and selected calendars (primary, birthdays, secondary, family)
  const calendars = await discoverGoogleCalendars(token);

  // 2. Fetch events from each discovered calendar in parallel with pagination and Sydney timezone
  const allEventsMap = new Map<string, CalendarEvent>();

  const fetchPromises = calendars.map(async (cal) => {
    // PROTECTED REGRESSION REQUIREMENT: eventTypes=birthday is strictly mandatory ONLY for the
    // Google Contacts/Birthdays virtual calendar. It MUST NEVER be added to primary or user calendars
    // where it would filter out normal doctor/consultation/personal appointments!
    const isGoogleContactsVirtualCalendar =
      cal.id === 'addressbook#contacts@group.v.calendar.google.com' ||
      cal.id.startsWith('addressbook#contacts');

    // Use canonical 'primary' identifier when primary is targeted to prevent email alias mismatches
    const targetCalendarId = (cal.primary || cal.id === 'primary') ? 'primary' : cal.id;

    const calendarEvents: CalendarEvent[] = [];
    let pageToken: string | null = null;
    let pageCount = 0;

    try {
      do {
        pageCount++;
        const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId)}/events`);
        url.searchParams.set('timeMin', timeMin);
        url.searchParams.set('timeMax', timeMax);
        url.searchParams.set('singleEvents', 'true');
        url.searchParams.set('orderBy', 'startTime');
        url.searchParams.set('maxResults', '250');
        url.searchParams.set('timeZone', 'Australia/Sydney');

        if (isGoogleContactsVirtualCalendar) {
          url.searchParams.set('eventTypes', 'birthday');
        }

        if (pageToken) {
          url.searchParams.set('pageToken', pageToken);
        }

        const response = await fetch(url.toString(), {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
        });

        if (response.status === 401) {
          throw new Error('Google Calendar access token has expired. Please re-authenticate.');
        }

        if (!response.ok) {
          const errorText = await response.text();
          console.warn(`[Google Calendar] Failed to fetch events for calendar "${cal.summary}" (${targetCalendarId}):`, errorText);
          break;
        }

        const data = await response.json();
        const rawItems: any[] = data.items || [];

        for (const item of rawItems) {
          const isAllDay = Boolean(item.start?.date && !item.start?.dateTime);
          const startDatetime = isAllDay
            ? (item.start?.date || new Date().toISOString().slice(0, 10))
            : (item.start?.dateTime || new Date().toISOString());
          const endDatetime = isAllDay
            ? (item.end?.date || item.start?.date || startDatetime)
            : (item.end?.dateTime || startDatetime);

          const attendees = Array.isArray(item.attendees)
            ? item.attendees.map((a: any) => a.displayName || a.email).filter(Boolean)
            : [];

          // Clean composite identity preserving calendar provenance
          const calSlug = (cal.primary || cal.id === 'primary') ? 'primary' : cal.id.replace(/[^a-zA-Z0-9_-]/g, '_');
          const compositeId = `cal_google_${calSlug}_${item.id}`;
          const sourceEventId = `${cal.primary ? 'primary' : cal.id}#${item.id}`;

          // Preserve birthday metadata and event type if present
          let description = item.description || null;
          if (item.eventType === 'birthday' || item.birthdayProperties) {
            const birthdayMeta = {
              eventType: item.eventType || 'birthday',
              birthdayProperties: item.birthdayProperties || null,
              calendar: cal.summary,
            };
            description = description ? `${description}\n${JSON.stringify(birthdayMeta)}` : JSON.stringify(birthdayMeta);
          }

          const calEvent: CalendarEvent = {
            id: compositeId,
            source: 'google_calendar',
            source_event_id: sourceEventId,
            title: item.summary || '(No title)',
            description,
            location: item.location || null,
            attendees,
            start_datetime: startDatetime,
            end_datetime: endDatetime,
            is_all_day: isAllDay,
            status: item.status || 'confirmed',
            updated_at: item.updated || new Date().toISOString(),
          };

          calendarEvents.push(calEvent);
        }

        pageToken = data.nextPageToken || null;
      } while (pageToken && pageCount < 10);

      return calendarEvents;
    } catch (err: any) {
      console.warn(`[Google Calendar] Error fetching events for calendar "${cal.summary}":`, err?.message || err);
      if (err?.message?.includes('expired')) {
        throw err;
      }
      return [];
    }
  });

  const results = await Promise.all(fetchPromises);

  // 3. Deduplicate events across calendars
  for (const eventList of results) {
    for (const ev of eventList) {
      if (!allEventsMap.has(ev.id)) {
        allEventsMap.set(ev.id, ev);
      }
    }
  }

  const parsedEvents = Array.from(allEventsMap.values());
  console.log(`[Google Calendar] Merged and deduplicated ${parsedEvents.length} total event(s) across ${calendars.length} calendar(s).`);

  // 4. Store in Ezzymigo's isolated calendar_events table
  const syncRes = await fetch('/api/calendar-events/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: parsedEvents }),
  });

  if (!syncRes.ok) {
    throw new Error('Failed to save imported events into local calendar database.');
  }

  const syncData = await syncRes.json();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('calendar-updated'));
  }
  return syncData.events || parsedEvents;
}

export async function getStoredCalendarEvents(): Promise<CalendarEvent[]> {
  const res = await fetch('/api/calendar-events');
  if (!res.ok) throw new Error('Failed to load stored calendar events');
  const data = await res.json();
  return data.events || [];
}
