import { encryptToken, decryptToken } from './crypto';
import {
  CalendarConnectionRecord,
  getCalendarConnection,
  saveCalendarConnection,
  listAllActiveCalendarConnections,
  upsertCalendarEvents,
  deleteCalendarEventFromDb,
} from './store';
import firebaseConfig from '../../firebase-applet-config.json';
import { invalidateEzzyCaches } from '../attention/freshness';

export const MINIMUM_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
];

export const CALENDAR_STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
export const DEFAULT_CALENDAR_DAYS_AHEAD = 60;

export interface DiscoveredCalendarItem {
  id: string;
  summary: string;
  primary?: boolean;
  selected?: boolean;
}

export interface TruthfulCalendarStatus {
  connected: boolean;
  status: 'connected' | 'syncing' | 'stale' | 'needs_reconnecting' | 'disconnected';
  display_status: string;
  account_email: string | null;
  last_successful_sync_at: string | null;
  last_attempted_sync_at: string | null;
  last_sync_error: string | null;
  is_stale: boolean;
  calendars_included: DiscoveredCalendarItem[];
  events_count?: number;
}

export function getOAuthClientId(): string {
  return (
    process.env.GOOGLE_CLIENT_ID ||
    firebaseConfig.oAuthClientId ||
    ''
  ).trim();
}

export function getOAuthClientSecret(): string {
  return (
    process.env.GOOGLE_CLIENT_SECRET ||
    process.env.GOOGLE_OAUTH_CLIENT_SECRET ||
    ''
  ).trim();
}

/**
 * Exchange an OAuth authorization code obtained from the frontend popup (offline access)
 * for an offline refresh token and initial access token.
 */
export async function exchangeOAuthCodeForTokens(params: {
  code: string;
  redirectUri?: string;
}): Promise<{
  refresh_token: string;
  access_token: string;
  expires_in: number;
  scope?: string;
}> {
  const clientId = getOAuthClientId();
  const clientSecret = getOAuthClientSecret();

  if (!clientId) {
    throw new Error('Google OAuth Client ID is not configured.');
  }

  const tokenUrl = 'https://oauth2.googleapis.com/token';
  const bodyParams = new URLSearchParams({
    code: params.code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: params.redirectUri || 'postmessage',
    grant_type: 'authorization_code',
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: bodyParams,
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('[Google OAuth] Token exchange failed:', response.status, errText);
    throw new Error(`Google OAuth token exchange failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  if (!data.refresh_token) {
    // If user has already authorized, Google may not return refresh_token unless prompt=consent was used
    console.warn('[Google OAuth] No refresh_token returned in exchange. Ensure prompt=consent and access_type=offline.');
  }

  return {
    refresh_token: data.refresh_token || '',
    access_token: data.access_token,
    expires_in: data.expires_in || 3600,
    scope: data.scope,
  };
}

/**
 * Request a short-lived access token using the stored refresh token.
 */
export async function refreshGoogleAccessToken(refreshToken: string): Promise<{
  access_token: string;
  expires_in: number;
}> {
  const clientId = getOAuthClientId();
  const clientSecret = getOAuthClientSecret();

  const tokenUrl = 'https://oauth2.googleapis.com/token';
  const bodyParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: bodyParams,
  });

  if (!response.ok) {
    const errText = await response.text();
    let isRevoked = response.status === 400 && (errText.includes('invalid_grant') || errText.includes('revoked'));
    if (response.status === 401) isRevoked = true;
    const error: any = new Error(`Google token refresh failed (${response.status}): ${errText}`);
    error.isAuthExpired = isRevoked;
    throw error;
  }

  const data = await response.json();
  return {
    access_token: data.access_token,
    expires_in: data.expires_in || 3600,
  };
}

/**
 * Retrieve a valid, unexpired access token for a given connection,
 * automatically refreshing and encrypting new access tokens if expired.
 */
export async function getValidAccessTokenForConnection(
  connection: CalendarConnectionRecord
): Promise<string> {
  const nowMs = Date.now();
  // Check if existing access token is still valid (with 5 minute safety cushion)
  if (connection.encrypted_access_token && connection.token_expiry) {
    const expiryMs = new Date(connection.token_expiry).getTime();
    if (expiryMs > nowMs + 5 * 60 * 1000) {
      try {
        const decrypted = decryptToken(connection.encrypted_access_token);
        if (decrypted) return decrypted;
      } catch (err) {
        console.warn('[Calendar Auth] Failed to decrypt cached access token, will refresh:', err);
      }
    }
  }

  if (!connection.encrypted_refresh_token) {
    throw new Error('Google Calendar needs reconnecting. No refresh token available.');
  }

  const refreshToken = decryptToken(connection.encrypted_refresh_token);
  if (!refreshToken) {
    throw new Error('Google Calendar needs reconnecting. Invalid refresh token.');
  }

  try {
    const { access_token, expires_in } = await refreshGoogleAccessToken(refreshToken);
    const encryptedAccess = encryptToken(access_token);
    const newExpiry = new Date(nowMs + expires_in * 1000).toISOString();

    await saveCalendarConnection({
      id: connection.id,
      ezzy_id: connection.ezzy_id,
      user_id: connection.user_id,
      encrypted_access_token: encryptedAccess,
      token_expiry: newExpiry,
      connection_status: 'connected',
      last_sync_error: null,
    });

    return access_token;
  } catch (err: any) {
    if (err.isAuthExpired) {
      await saveCalendarConnection({
        id: connection.id,
        ezzy_id: connection.ezzy_id,
        user_id: connection.user_id,
        connection_status: 'needs_reconnecting',
        last_sync_error: 'Google Calendar authorization expired or was revoked. Please reconnect.',
      });
    }
    throw err;
  }
}

/**
 * Server-side calendar discovery using Google Calendar API.
 * Ensures primary calendar and birthdays virtual calendar are always identified.
 */
export async function discoverGoogleCalendarsServer(
  accessToken: string
): Promise<DiscoveredCalendarItem[]> {
  try {
    const visibleCalendars: DiscoveredCalendarItem[] = [];
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
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        const errBody = await response.text();
        console.warn(`[Google Calendar] calendarList.list failed (${response.status}):`, errBody);
        break;
      }

      const data = await response.json();
      const rawList: any[] = data.items || [];

      for (const cal of rawList) {
        if (cal.deleted === true || cal.hidden === true) continue;
        visibleCalendars.push({
          id: cal.id,
          summary: cal.summary || cal.id,
          primary: Boolean(cal.primary),
          selected: cal.selected !== false,
        });
      }

      pageToken = data.nextPageToken || null;
    } while (pageToken && pageCount < 5);

    // Guaranteed primary calendar
    if (!visibleCalendars.some((c) => c.primary || c.id === 'primary')) {
      visibleCalendars.unshift({ id: 'primary', summary: 'Primary Calendar', primary: true, selected: true });
    }

    // Guaranteed Google Contacts / Birthdays calendar
    const hasBirthdays = visibleCalendars.some((c) => c.id.includes('contacts@group.v.calendar.google.com'));
    if (!hasBirthdays) {
      visibleCalendars.push({
        id: 'addressbook#contacts@group.v.calendar.google.com',
        summary: 'Birthdays',
        selected: true,
      });
    }

    return visibleCalendars;
  } catch (err) {
    console.warn('[Google Calendar] Server discovery failed, using fallback list:', err);
    return [
      { id: 'primary', summary: 'Primary Calendar', primary: true, selected: true },
      { id: 'addressbook#contacts@group.v.calendar.google.com', summary: 'Birthdays', selected: true },
    ];
  }
}

/**
 * Execute server-side synchronisation of Google Calendar events for a connection.
 * - Resolves Australia/Sydney timezone
 * - Rolling window: -2 days to +60 days
 * - Discovers primary and selected calendars
 * - Idempotently upserts events into calendar_events under the connection's ezzy_id
 */
export async function syncCalendarForConnection(
  connection: CalendarConnectionRecord,
  options: { daysAhead?: number; force?: boolean } = {}
): Promise<{ success: boolean; eventCount: number; error?: string }> {
  const ezzyId = connection.ezzy_id;
  const daysAhead = options.daysAhead || DEFAULT_CALENDAR_DAYS_AHEAD;
  const now = new Date();
  const nowIso = now.toISOString();

  // Mark status as syncing
  await saveCalendarConnection({
    id: connection.id,
    ezzy_id: ezzyId,
    user_id: connection.user_id,
    connection_status: 'syncing',
    last_attempted_sync_at: nowIso,
  });

  try {
    const accessToken = await getValidAccessTokenForConnection(connection);

    // 1. Discover all active calendars
    const calendars = await discoverGoogleCalendarsServer(accessToken);
    const selectedIds = calendars.filter((c) => c.selected !== false).map((c) => c.id);

    // 2. Compute date boundaries in Australia/Sydney
    const startWindow = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const timeMin = startWindow.toISOString();
    const endWindow = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
    const timeMax = endWindow.toISOString();

    const allEventsMap = new Map<string, any>();

    for (const cal of calendars) {
      const isGoogleContacts =
        cal.id === 'addressbook#contacts@group.v.calendar.google.com' ||
        cal.id.startsWith('addressbook#contacts');

      const targetCalendarId = cal.primary || cal.id === 'primary' ? 'primary' : cal.id;

      let pageToken: string | null = null;
      let pageCount = 0;

      do {
        pageCount++;
        const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targetCalendarId)}/events`);
        url.searchParams.set('timeMin', timeMin);
        url.searchParams.set('timeMax', timeMax);
        url.searchParams.set('singleEvents', 'true');
        url.searchParams.set('orderBy', 'startTime');
        url.searchParams.set('maxResults', '250');
        url.searchParams.set('timeZone', 'Australia/Sydney');

        if (isGoogleContacts) {
          url.searchParams.set('eventTypes', 'birthday');
        }
        if (pageToken) {
          url.searchParams.set('pageToken', pageToken);
        }

        const response = await fetch(url.toString(), {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/json',
          },
        });

        if (response.status === 401 || response.status === 403) {
          const errText = await response.text();
          const err: any = new Error(`Google Calendar access denied (${response.status}): ${errText}`);
          err.isAuthExpired = true;
          throw err;
        }

        if (!response.ok) {
          const errText = await response.text();
          console.warn(`[Google Calendar Sync] Failed to fetch events for "${cal.summary}":`, errText);
          break;
        }

        const data = await response.json();
        const rawItems: any[] = data.items || [];

        for (const item of rawItems) {
          if (item.status === 'cancelled') {
            // Remove cancelled event or mark cancelled
            const calSlug = cal.primary || cal.id === 'primary' ? 'primary' : cal.id.replace(/[^a-zA-Z0-9_-]/g, '_');
            const canonicalId = `cal_google_${calSlug}_${item.id}`;
            await deleteCalendarEventFromDb(canonicalId, ezzyId).catch(() => {});
            continue;
          }

          const isAllDay = Boolean(item.start?.date && !item.start?.dateTime);
          const startDatetime = isAllDay
            ? item.start?.date || nowIso.slice(0, 10)
            : item.start?.dateTime || nowIso;
          const endDatetime = isAllDay
            ? item.end?.date || item.start?.date || startDatetime
            : item.end?.dateTime || startDatetime;

          const attendees = Array.isArray(item.attendees)
            ? item.attendees.map((a: any) => a.displayName || a.email).filter(Boolean)
            : [];

          const calSlug = cal.primary || cal.id === 'primary' ? 'primary' : cal.id.replace(/[^a-zA-Z0-9_-]/g, '_');
          const compositeId = `cal_google_${calSlug}_${item.id}`;
          const sourceEventId = `${cal.primary ? 'primary' : cal.id}#${item.id}`;

          let description = item.description || null;
          if (item.eventType === 'birthday' || item.birthdayProperties) {
            const birthdayMeta = {
              eventType: item.eventType || 'birthday',
              birthdayProperties: item.birthdayProperties || null,
              calendar: cal.summary,
            };
            description = description ? `${description}\n${JSON.stringify(birthdayMeta)}` : JSON.stringify(birthdayMeta);
          }

          allEventsMap.set(compositeId, {
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
            updated_at: item.updated || nowIso,
          });
        }

        pageToken = data.nextPageToken || null;
      } while (pageToken && pageCount < 10);
    }

    const eventsList = Array.from(allEventsMap.values());

    // 3. Upsert into database
    await upsertCalendarEvents(eventsList, ezzyId);

    // 4. Update connection state
    await saveCalendarConnection({
      id: connection.id,
      ezzy_id: ezzyId,
      user_id: connection.user_id,
      connection_status: 'connected',
      last_successful_sync_at: nowIso,
      last_attempted_sync_at: nowIso,
      last_sync_error: null,
      selected_calendar_ids: selectedIds,
    });

    invalidateEzzyCaches(ezzyId);
    console.log(`[Google Calendar Sync] Successfully synced ${eventsList.length} events for ezzy_id: ${ezzyId}`);
    return { success: true, eventCount: eventsList.length };
  } catch (err: any) {
    console.error(`[Google Calendar Sync] Error syncing ezzy_id ${ezzyId}:`, err);
    const isAuth = err.isAuthExpired || String(err?.message || '').includes('reconnecting');
    const newStatus = isAuth ? 'needs_reconnecting' : 'stale';
    const errMsg = err?.message || 'Sync failed';

    await saveCalendarConnection({
      id: connection.id,
      ezzy_id: ezzyId,
      user_id: connection.user_id,
      connection_status: newStatus,
      last_attempted_sync_at: nowIso,
      last_sync_error: errMsg,
    });

    return { success: false, eventCount: 0, error: errMsg };
  }
}

/**
 * Produce the truthful user-facing status for the calendar connection according to strict UI rules.
 */
export async function getTruthfulCalendarStatus(
  ezzyId: string,
  userId: string
): Promise<TruthfulCalendarStatus> {
  const connection = await getCalendarConnection(ezzyId, userId);

  if (!connection || connection.connection_status === 'disconnected') {
    return {
      connected: false,
      status: 'disconnected',
      display_status: 'Connect Calendar',
      account_email: null,
      last_successful_sync_at: null,
      last_attempted_sync_at: null,
      last_sync_error: null,
      is_stale: true,
      calendars_included: [],
    };
  }

  const now = Date.now();
  const lastSyncMs = connection.last_successful_sync_at
    ? new Date(connection.last_successful_sync_at).getTime()
    : 0;
  const isStale = !lastSyncMs || now - lastSyncMs > CALENDAR_STALE_THRESHOLD_MS;

  // Format relative or absolute time
  function formatSyncTime(isoStr: string | null): string {
    if (!isoStr) return 'never';
    const d = new Date(isoStr);
    const diffSec = Math.floor((now - d.getTime()) / 1000);
    if (diffSec < 60) return 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin === 1) return '1 minute ago';
    if (diffMin < 60) return `${diffMin} minutes ago`;
    const diffHours = Math.floor(diffMin / 60);
    if (diffHours === 1) return '1 hour ago';
    if (diffHours < 24) return `${diffHours} hours ago`;
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }

  let displayStatus = '';
  let effectiveStatus: 'connected' | 'syncing' | 'stale' | 'needs_reconnecting' | 'disconnected' =
    connection.connection_status;

  if (connection.connection_status === 'needs_reconnecting') {
    effectiveStatus = 'needs_reconnecting';
    displayStatus = connection.last_successful_sync_at
      ? `Calendar needs reconnecting · Last synced ${formatSyncTime(connection.last_successful_sync_at)}`
      : 'Calendar needs reconnecting';
  } else if (connection.connection_status === 'syncing') {
    effectiveStatus = 'syncing';
    displayStatus = 'Calendar syncing…';
  } else if (isStale) {
    effectiveStatus = 'stale';
    displayStatus = connection.last_successful_sync_at
      ? `Calendar stale · Last synced ${formatSyncTime(connection.last_successful_sync_at)}`
      : 'Calendar stale · Never successfully synced';
  } else {
    effectiveStatus = 'connected';
    displayStatus = `Calendar connected · Synced ${formatSyncTime(connection.last_successful_sync_at)}`;
  }

  const calendarsIncluded: DiscoveredCalendarItem[] = (connection.selected_calendar_ids || []).map((id) => ({
    id,
    summary: id === 'primary' ? 'Primary Calendar' : id.includes('contacts') ? 'Birthdays' : id,
    primary: id === 'primary',
    selected: true,
  }));

  return {
    connected: true,
    status: effectiveStatus,
    display_status: displayStatus,
    account_email: connection.account_email,
    last_successful_sync_at: connection.last_successful_sync_at,
    last_attempted_sync_at: connection.last_attempted_sync_at,
    last_sync_error: connection.last_sync_error,
    is_stale: isStale,
    calendars_included: calendarsIncluded,
  };
}

/**
 * Synchronises all active calendar connections across instances.
 * Designed to be called by an authenticated Google Cloud Scheduler HTTP invocation
 * (e.g. POST /api/calendar/scheduler-sync with Cloud Scheduler auth or bearer secret).
 */
export async function syncAllActiveConnections(): Promise<{
  attempted: number;
  succeeded: number;
  failed: number;
  details: Array<{ ezzy_id: string; success: boolean; eventCount?: number; error?: string }>;
}> {
  const activeConnections = await listAllActiveCalendarConnections();
  const results: Array<{ ezzy_id: string; success: boolean; eventCount?: number; error?: string }> = [];

  let succeeded = 0;
  let failed = 0;

  for (const conn of activeConnections) {
    try {
      const res = await syncCalendarForConnection(conn);
      if (res.success) {
        succeeded++;
        results.push({ ezzy_id: conn.ezzy_id, success: true, eventCount: res.eventCount });
      } else {
        failed++;
        results.push({ ezzy_id: conn.ezzy_id, success: false, error: res.error });
      }
    } catch (err: any) {
      failed++;
      results.push({ ezzy_id: conn.ezzy_id, success: false, error: err?.message || String(err) });
    }
  }

  return {
    attempted: activeConnections.length,
    succeeded,
    failed,
    details: results,
  };
}

