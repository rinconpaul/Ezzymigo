import React, { useState, useEffect } from 'react';
import { Calendar, RefreshCw, Clock, MapPin, Users, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { CalendarEvent } from '../types';
import { fetchGoogleCalendarEvents, getStoredCalendarEvents } from '../utils/googleCalendarSync';
import { AuthState } from '../utils/googleCalendarAuth';
import { formatDateTime, getUserPreferences } from '../utils/userPreferences';

interface CalendarInspectorProps {
  authState: AuthState;
}

export const CalendarInspector: React.FC<CalendarInspectorProps> = ({ authState }) => {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadStoredEvents = async () => {
    setIsLoading(true);
    try {
      const list = await getStoredCalendarEvents();
      setEvents(list);
    } catch (err: any) {
      console.error('Failed to read calendar events:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadStoredEvents();
  }, []);

  const handleSyncCalendar = async () => {
    setIsSyncing(true);
    setMessage(null);
    try {
      const synced = await fetchGoogleCalendarEvents(60);
      setEvents(synced);
      setMessage({
        type: 'success',
        text: `Successfully imported ${synced.length} event(s) for the next 60 days from Google Calendar.`,
      });
      setTimeout(() => setMessage(null), 6000);
    } catch (err: any) {
      console.error('Calendar sync error:', err);
      setMessage({
        type: 'error',
        text: err?.message || 'Failed to fetch events from Google Calendar.',
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
        return formatDateTime(startDate, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }, prefs) + ' (All Day)';
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
              Imported Calendar Events (Inspection)
              <span className="text-2xs font-semibold px-2 py-0.5 rounded-full bg-blue-100 text-blue-800">
                {events.length}
              </span>
            </h3>
            <p className="text-2xs text-zinc-500">
              Isolated <code className="font-mono text-zinc-600">calendar_events</code> storage for manual acceptance testing
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={loadStoredEvents}
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
                <span>Fetching 60 Days...</span>
              </>
            ) : (
              <>
                <Calendar className="w-3.5 h-3.5" />
                <span>Fetch Google Calendar (Upcoming 60 Days)</span>
              </>
            )}
          </button>
        </div>
      </div>

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
            Click <strong>Fetch Google Calendar (Next 7 Days)</strong> to pull upcoming events from your connected Google Calendar into the storage table.
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
