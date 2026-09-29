import React, { useState, useEffect } from 'react';
import { Calendar, RefreshCw, Clock, MapPin, Users, CheckCircle2, AlertCircle, Loader2, Link2, ShieldCheck } from 'lucide-react';
import { CalendarEvent } from '../types';
import { getStoredCalendarEvents } from '../utils/googleCalendarSync';
import {
  AuthState,
  fetchCalendarStatus,
  triggerServerCalendarSync,
  CalendarConnectionStatus,
} from '../utils/googleCalendarAuth';
import { formatDateTime, getUserPreferences } from '../utils/userPreferences';

interface CalendarInspectorProps {
  authState: AuthState;
}

export const CalendarInspector: React.FC<CalendarInspectorProps> = ({ authState }) => {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [status, setStatus] = useState<CalendarConnectionStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadData = async (retryCount = 0) => {
    setIsLoading(true);
    try {
      const [list, calStatus] = await Promise.all([
        getStoredCalendarEvents(),
        fetchCalendarStatus(false).catch(() => null),
      ]);
      setEvents(list);
      if (calStatus) setStatus(calStatus);
    } catch (err: any) {
      if (retryCount < 3) {
        setTimeout(() => loadData(retryCount + 1), 1500 * (retryCount + 1));
        return;
      }
      console.error('Failed to read calendar events:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const handler = () => loadData();
    window.addEventListener('calendar-updated', handler);
    return () => window.removeEventListener('calendar-updated', handler);
  }, []);

  const handleSyncCalendar = async () => {
    setIsSyncing(true);
    setMessage(null);
    try {
      const res = await triggerServerCalendarSync();
      if (res.status) setStatus(res.status);
      if (res.events) setEvents(res.events);
      if (res.success) {
        setMessage({
          type: 'success',
          text: `Successfully synced ${res.eventCount} event(s) across connected calendars via offline OAuth refresh token.`,
        });
      } else {
        setMessage({
          type: 'error',
          text: res.error || 'Calendar sync encountered an issue.',
        });
      }
      setTimeout(() => setMessage(null), 6000);
    } catch (err: any) {
      console.error('Calendar sync error:', err);
      setMessage({
        type: 'error',
        text: err?.message || 'Failed to sync events from Google Calendar.',
      });
    } finally {
      setIsSyncing(false);
    }
  };

  const formatEventDateTime = (startIso: string, endIso: string, isAllDay: boolean) => {
    try {
      const prefs = getUserPreferences();
      const startDate = new Date(startIso);
      const endDate = new Date(endIso);

      if (isAllDay) {
        const startYMD = startIso.slice(0, 10);
        const [sy, sm, sd] = startYMD.split('-').map(Number);
        const utcDate = new Date(Date.UTC(sy, sm - 1, sd, 12, 0, 0));
        const formatted = new Intl.DateTimeFormat(prefs.language || 'en-AU', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'UTC',
        }).format(utcDate);
        return `${formatted} (All Day)`;
      }

      const sameDay = startDate.toDateString() === endDate.toDateString();
      const datePart = formatDateTime(startDate, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }, prefs);
      const startTimePart = formatDateTime(startDate, {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }, prefs);
      const endTimePart = formatDateTime(endDate, {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }, prefs);

      if (sameDay) {
        return `${datePart} • ${startTimePart} – ${endTimePart}`;
      }
      const endDatePart = formatDateTime(endDate, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }, prefs);
      return `${datePart} ${startTimePart} → ${endDatePart}`;
    } catch {
      return `${startIso} – ${endIso}`;
    }
  };

  return (
    <section id="calendar-inspection-panel" className="bg-white rounded-xl border border-zinc-200 p-4 sm:p-5 shadow-xs space-y-4">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-zinc-100">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-blue-50 text-blue-700">
            <Calendar className="w-4 h-4" />
          </div>
          <div>
            <h3 className="text-sm font-bold text-zinc-900 flex items-center gap-2">
              Google Calendar Synchronization
              <span className="text-2xs font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">
                {events.length}
              </span>
            </h3>
            <p className="text-2xs text-zinc-500">
              Server-side offline OAuth 2.0 with encrypted refresh token at rest
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => loadData()}
            disabled={isLoading || isSyncing}
            title="Refresh local inspection list"
            className="p-1.5 rounded-md bg-zinc-100 hover:bg-zinc-200 text-zinc-600 hover:text-zinc-900 text-xs font-medium transition-colors disabled:opacity-50 cursor-pointer flex items-center gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>

          <button
            type="button"
            id="sync-google-calendar-60days-btn"
            onClick={handleSyncCalendar}
            disabled={isSyncing}
            className="inline-flex items-center gap-1.5 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 px-3 py-1.5 rounded-lg shadow-2xs transition-all cursor-pointer"
          >
            {isSyncing ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Syncing Calendar...</span>
              </>
            ) : (
              <>
                <Calendar className="w-3.5 h-3.5" />
                <span>Sync Now (Server OAuth)</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Truthful Connection Status Panel */}
      {status && (
        <div className="p-3 bg-zinc-50 rounded-lg border border-zinc-200 space-y-2 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span
                className={`w-2.5 h-2.5 rounded-full ${
                  status.status === 'connected'
                    ? 'bg-emerald-500'
                    : status.status === 'stale'
                    ? 'bg-amber-500'
                    : status.status === 'needs_reconnecting'
                    ? 'bg-rose-500'
                    : status.status === 'syncing'
                    ? 'bg-blue-500 animate-pulse'
                    : 'bg-zinc-400'
                }`}
              />
              <span className="font-semibold text-zinc-900">{status.display_status}</span>
            </div>

            {status.account_email && (
              <span className="text-zinc-500 text-2xs font-mono">{status.account_email}</span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1 border-t border-zinc-200/60 text-2xs text-zinc-600">
            <div>
              <span className="text-zinc-400">Last successful sync: </span>
              <span className="font-medium text-zinc-800">
                {status.last_successful_sync_at
                  ? new Date(status.last_successful_sync_at).toLocaleString('en-AU')
                  : 'Never'}
              </span>
            </div>
            <div>
              <span className="text-zinc-400">Last attempted sync: </span>
              <span className="font-medium text-zinc-800">
                {status.last_attempted_sync_at
                  ? new Date(status.last_attempted_sync_at).toLocaleString('en-AU')
                  : 'Never'}
              </span>
            </div>
          </div>

          {status.calendars_included && status.calendars_included.length > 0 && (
            <div className="pt-1.5 border-t border-zinc-200/60 flex items-center gap-2 flex-wrap text-2xs">
              <span className="text-zinc-400 font-medium">Calendars included:</span>
              {status.calendars_included.map((cal) => (
                <span
                  key={cal.id}
                  className={`px-1.5 py-0.5 rounded text-3xs font-medium border ${
                    cal.primary
                      ? 'bg-blue-50 text-blue-800 border-blue-200 font-semibold'
                      : 'bg-zinc-100 text-zinc-700 border-zinc-200'
                  }`}
                >
                  {cal.summary} {cal.primary ? '(Primary)' : ''}
                </span>
              ))}
            </div>
          )}

          {status.last_sync_error && (
            <div className="p-2 rounded bg-rose-50 border border-rose-200 text-rose-800 text-2xs flex items-start gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{status.last_sync_error}</span>
            </div>
          )}
        </div>
      )}

      {/* Feedback Banner */}
      {message && (
        <div
          className={`px-3 py-2 rounded-lg text-xs flex items-center gap-2 ${
            message.type === 'success'
              ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border border-rose-200 text-rose-800'
          }`}
        >
          {message.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-600" />
          ) : (
            <AlertCircle className="w-4 h-4 shrink-0 text-rose-600" />
          )}
          <span>{message.text}</span>
        </div>
      )}

      {/* Event List */}
      {isLoading && events.length === 0 ? (
        <div className="text-center py-6 text-xs text-zinc-500">
          Loading stored calendar events...
        </div>
      ) : events.length === 0 ? (
        <div className="text-center py-6 border border-dashed border-zinc-200 rounded-lg bg-zinc-50/50 space-y-1">
          <p className="text-xs font-medium text-zinc-700">No calendar events imported yet</p>
          <p className="text-2xs text-zinc-500 max-w-md mx-auto">
            Click <strong>Sync Now (Server OAuth)</strong> to pull upcoming events from your connected Google Calendar into the storage table.
          </p>
        </div>
      ) : (
        <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
          {events.map((evt) => (
            <div
              key={evt.id}
              className="p-3 bg-zinc-50 hover:bg-zinc-100/80 rounded-lg border border-zinc-200 transition-colors space-y-1.5"
            >
              <div className="flex items-start justify-between gap-2">
                <h4 className="text-xs font-bold text-zinc-900 leading-snug">
                  {evt.title}
                </h4>
                <span className="text-3xs font-mono uppercase px-1.5 py-0.5 rounded bg-zinc-200 text-zinc-700 shrink-0">
                  {evt.source}
                </span>
              </div>

              <div className="flex items-center gap-1.5 text-2xs text-blue-800 font-medium">
                <Clock className="w-3.5 h-3.5 text-blue-600 shrink-0" />
                <span>{formatEventDateTime(evt.start_datetime, evt.end_datetime, evt.is_all_day)}</span>
              </div>

              {evt.location && (
                <div className="flex items-center gap-1.5 text-2xs text-zinc-600">
                  <MapPin className="w-3 h-3 text-zinc-400 shrink-0" />
                  <span className="truncate">{evt.location}</span>
                </div>
              )}

              {evt.attendees && evt.attendees.length > 0 && (
                <div className="flex items-center gap-1.5 text-2xs text-zinc-500">
                  <Users className="w-3 h-3 text-zinc-400 shrink-0" />
                  <span className="truncate">{evt.attendees.join(', ')}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
};
