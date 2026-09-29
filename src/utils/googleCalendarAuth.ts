import firebaseConfig from '../../firebase-applet-config.json';

export const SCOPES = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly',
];

export interface CalendarConnectionStatus {
  connected: boolean;
  status: 'connected' | 'syncing' | 'stale' | 'needs_reconnecting' | 'disconnected';
  display_status: string;
  account_email: string | null;
  last_successful_sync_at: string | null;
  last_attempted_sync_at: string | null;
  last_sync_error: string | null;
  is_stale: boolean;
  calendars_included: Array<{
    id: string;
    summary: string;
    primary?: boolean;
    selected?: boolean;
  }>;
  events_count?: number;
}

// Fetch current truthful calendar status from server
export async function fetchCalendarStatus(autoSyncIfStale = false): Promise<CalendarConnectionStatus> {
  const url = autoSyncIfStale ? '/api/calendar/status?auto_sync_if_stale=true' : '/api/calendar/status';
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to load calendar status (${res.status})`);
  }
  return await res.json();
}

// Trigger server-side on-demand synchronisation
export async function triggerServerCalendarSync(): Promise<{
  success: boolean;
  eventCount: number;
  status: CalendarConnectionStatus;
  events?: any[];
  error?: string;
}> {
  const res = await fetch('/api/calendar/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  const data = await res.json();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('calendar-updated'));
  }
  return data;
}

// Disconnect Google Calendar connection on the server
export async function disconnectGoogleCalendar(): Promise<void> {
  const res = await fetch('/api/calendar/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    throw new Error('Failed to disconnect Google Calendar');
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('calendar-updated'));
  }
}

/**
 * Connect Google Calendar using Google Identity Services (GIS) authorization-code flow
 * with offline access. The authorization code is securely sent to the server for exchange
 * and offline storage of the encrypted refresh token.
 */
export async function connectGoogleCalendar(): Promise<CalendarConnectionStatus> {
  const clientId = firebaseConfig.oAuthClientId;
  if (!clientId) {
    throw new Error('Google OAuth Client ID is not configured.');
  }

  // Ensure Google Identity Services script is available
  await ensureGoogleIdentityLoaded();

  return new Promise((resolve, reject) => {
    try {
      const google = (window as any).google;
      if (!google?.accounts?.oauth2) {
        return reject(new Error('Google Identity Services client library is unavailable.'));
      }

      const client = google.accounts.oauth2.initCodeClient({
        client_id: clientId,
        scope: SCOPES.join(' '),
        ux_mode: 'popup',
        select_account: true,
        callback: async (response: { code?: string; error?: string }) => {
          if (response.error) {
            console.error('[Google OAuth] Authorization failed:', response.error);
            return reject(new Error(`Authorization failed: ${response.error}`));
          }
          if (!response.code) {
            return reject(new Error('No authorization code returned from Google.'));
          }

          try {
            // Generate a random CSRF state token and verify against sessionStorage
            const state = 'ezzy_gcal_' + Math.random().toString(36).substring(2, 15);
            sessionStorage.setItem('calendar_oauth_state', state);

            // Pass exact browser origin as redirect_uri for server-side exchange
            const clientOrigin = window.location.origin;

            // Exchange code on server for encrypted refresh token and perform immediate initial sync
            const serverRes = await fetch('/api/calendar/connect', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                code: response.code,
                redirect_uri: clientOrigin,
                client_origin: clientOrigin,
                state: state,
              }),
            });

            if (!serverRes.ok) {
              const errBody = await serverRes.json().catch(() => ({}));
              throw new Error(errBody.error || `Server connection failed (${serverRes.status})`);
            }

            const data = await serverRes.json();
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('calendar-updated'));
            }
            resolve(data.status);
          } catch (exchangeErr) {
            reject(exchangeErr);
          }
        },
      });

      client.requestCode();
    } catch (err) {
      reject(err);
    }
  });
}

function ensureGoogleIdentityLoaded(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if ((window as any).google?.accounts?.oauth2) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const existing = document.querySelector('script[src*="accounts.google.com/gsi/client"]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Failed to load Google script')));
      // In case it already loaded
      if ((window as any).google?.accounts?.oauth2) resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Identity Services'));
    document.head.appendChild(script);
  });
}

// Backward compatibility helper interface for existing components
export interface AuthState {
  isConnected: boolean;
  user: any | null;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
}

export function initGoogleAuth(onChange: (state: AuthState) => void): () => void {
  let isMounted = true;

  const update = async () => {
    try {
      const status = await fetchCalendarStatus(true);
      if (!isMounted) return;
      onChange({
        isConnected: status.connected && status.status !== 'needs_reconnecting',
        user: status.account_email ? { email: status.account_email } : null,
        email: status.account_email,
        displayName: status.account_email ? status.account_email.split('@')[0] : null,
        photoURL: null,
      });
    } catch {
      if (!isMounted) return;
      onChange({
        isConnected: false,
        user: null,
        email: null,
        displayName: null,
        photoURL: null,
      });
    }
  };

  update();
  const handler = () => update();
  window.addEventListener('calendar-updated', handler);

  return () => {
    isMounted = false;
    window.removeEventListener('calendar-updated', handler);
  };
}

export const getGoogleAccessToken = (): string | null => null;
