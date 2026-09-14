import React, { useState, useEffect, useRef } from 'react';
import { Brain, Bell, BellRing, CheckCircle2, Loader2, Calendar, LogOut, Check, ChevronDown, Filter } from 'lucide-react';
import { checkPushSubscriptionStatus, subscribeToPushNotifications, sendTestNotification } from '../utils/pushManager';
import { initGoogleAuth, connectGoogleCalendar, disconnectGoogleCalendar, AuthState } from '../utils/googleCalendarAuth';
import { fetchGoogleCalendarEvents } from '../utils/googleCalendarSync';
import { InboxFilterType } from '../types';

interface HeaderProps {
  inboxFilter?: InboxFilterType;
  onInboxFilterChange?: (filter: InboxFilterType) => void;
  counts?: {
    all: number;
    reminders: number;
    facts: number;
    not_sure: number;
  };
}

export const Header: React.FC<HeaderProps> = ({
  inboxFilter = 'all',
  onInboxFilterChange,
  counts,
}) => {
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const filterDropdownRef = useRef<HTMLDivElement>(null);

  const [pushStatus, setPushStatus] = useState<{
    isSupported: boolean;
    permission: NotificationPermission;
    isSubscribed: boolean;
  }>({
    isSupported: false,
    permission: 'default',
    isSubscribed: false,
  });
  const [isEnabling, setIsEnabling] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Google Calendar Auth State
  const [authState, setAuthState] = useState<AuthState>({
    isConnected: false,
    user: null,
    email: null,
    displayName: null,
    photoURL: null,
  });
  const [isConnectingGoogle, setIsConnectingGoogle] = useState(false);

  useEffect(() => {
    checkPushSubscriptionStatus().then(setPushStatus);
    const unsubscribe = initGoogleAuth(setAuthState);
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);

  // Close filter dropdown on outside click or Escape
  useEffect(() => {
    if (!isFilterOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (filterDropdownRef.current && !filterDropdownRef.current.contains(e.target as Node)) {
        setIsFilterOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isFilterOpen]);

  const filterOptions: Array<{ id: InboxFilterType; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'reminders', label: 'Reminders' },
    { id: 'facts', label: 'Facts' },
    { id: 'not_sure', label: 'Not Sure' },
  ];

  const currentFilterLabel = filterOptions.find((opt) => opt.id === inboxFilter)?.label || 'All';

  const handleConnectGoogle = async () => {
    setIsConnectingGoogle(true);
    setFeedback(null);
    try {
      const res = await connectGoogleCalendar();
      try {
        await fetchGoogleCalendarEvents();
        setFeedback('Google Calendar connected and synced.');
        setTimeout(() => setFeedback(null), 5000);
      } catch (syncErr: any) {
        console.error('Google sync error after connect:', syncErr);
        setFeedback(`Connected as ${res.user.email || 'User'}, but sync encountered an issue: ${syncErr?.message || 'Failed to fetch events'}`);
        setTimeout(() => setFeedback(null), 6000);
      }
    } catch (err: any) {
      console.error('Google connect error:', err);
      setFeedback(err?.message || 'Could not connect Google Calendar.');
      setTimeout(() => setFeedback(null), 6000);
    } finally {
      setIsConnectingGoogle(false);
    }
  };

  const handleDisconnectGoogle = async () => {
    try {
      await disconnectGoogleCalendar();
      setFeedback('Disconnected from Google Calendar.');
      setTimeout(() => setFeedback(null), 4000);
    } catch (err: any) {
      console.error('Google disconnect error:', err);
    }
  };

  const handleEnablePush = async () => {
    setIsEnabling(true);
    setFeedback(null);
    try {
      const result = await subscribeToPushNotifications();
      const updated = await checkPushSubscriptionStatus();
      setPushStatus(updated);
      if (result.success) {
        setFeedback('Notifications enabled! You will receive reminders even when closed.');
        setTimeout(() => setFeedback(null), 5000);
      } else if (result.error) {
        setFeedback(result.error);
        setTimeout(() => setFeedback(null), 6000);
      }
    } catch (e: any) {
      setFeedback(e?.message || 'Failed to enable notifications');
      setTimeout(() => setFeedback(null), 5000);
    } finally {
      setIsEnabling(false);
    }
  };

  const handleTestNotification = async () => {
    const res = await sendTestNotification();
    setFeedback(res.message);
    setTimeout(() => setFeedback(null), 4000);
  };

  return (
    <header className="border-b border-zinc-200 bg-white py-2.5 sm:py-3.5 px-3.5 sm:px-6 shadow-xs">
      <div className="max-w-4xl mx-auto flex items-center justify-between gap-2.5">
        {/* Brand */}
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg bg-zinc-900 flex items-center justify-center text-white shadow-xs shrink-0">
            <Brain className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <h1 className="text-base sm:text-lg font-bold text-zinc-900 tracking-tight leading-tight">
                Ezzymigo
              </h1>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-zinc-100 text-zinc-600 font-medium border border-zinc-200">
                Prototype
              </span>
            </div>
            <p className="hidden sm:block text-[11px] text-zinc-500 leading-tight">
              Personal Intention Memory Assistant
            </p>
          </div>
        </div>

        {/* Status & Action Badges */}
        <div className="flex items-center gap-1.5 sm:gap-2">
          {/* Inbox Filter ▾ Button immediately to the left of Connect Calendar */}
          <div className="relative" ref={filterDropdownRef}>
            <button
              type="button"
              id="inbox-filter-btn"
              onClick={() => setIsFilterOpen((prev) => !prev)}
              className={`inline-flex items-center gap-1 text-[11px] sm:text-xs font-medium px-2 py-1 sm:px-2.5 sm:py-1 rounded-md border transition-all cursor-pointer shadow-2xs ${
                inboxFilter !== 'all'
                  ? 'bg-zinc-900 text-white border-zinc-900 hover:bg-zinc-800'
                  : 'text-zinc-700 hover:text-zinc-900 bg-zinc-100 hover:bg-zinc-200 border-zinc-300'
              }`}
              title="Filter Inbox memories"
              aria-expanded={isFilterOpen}
              aria-haspopup="true"
            >
              <Filter className="w-3 h-3 shrink-0 opacity-80" />
              <span>{inboxFilter === 'all' ? 'Filter' : `Filter: ${currentFilterLabel}`}</span>
              <ChevronDown className={`w-3 h-3 text-current transition-transform duration-150 ${isFilterOpen ? 'rotate-180' : ''}`} />
            </button>

            {isFilterOpen && (
              <div
                id="inbox-filter-dropdown-menu"
                className="absolute right-0 mt-1.5 w-44 rounded-lg bg-white border border-zinc-200 shadow-lg py-1 z-50 animate-in fade-in slide-in-from-top-1 duration-100"
                role="menu"
              >
                <div className="px-3 py-1.5 text-[10px] font-semibold text-zinc-600 uppercase tracking-wider border-b border-zinc-100">
                  Inbox Filter
                </div>
                {filterOptions.map((opt) => {
                  const isSelected = inboxFilter === opt.id;
                  const count = counts ? counts[opt.id] : undefined;
                  return (
                    <button
                      key={opt.id}
                      id={`filter-opt-${opt.id}`}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        if (onInboxFilterChange) onInboxFilterChange(opt.id);
                        setIsFilterOpen(false);
                      }}
                      className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium transition-colors cursor-pointer text-left ${
                        isSelected
                          ? 'bg-zinc-100 text-zinc-900 font-semibold'
                          : 'text-zinc-700 hover:bg-zinc-50 hover:text-zinc-900'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {isSelected ? (
                          <Check className="w-3.5 h-3.5 text-zinc-900 shrink-0" />
                        ) : (
                          <span className="w-3.5 h-3.5" />
                        )}
                        <span>{opt.label}</span>
                      </div>
                      {typeof count === 'number' && (
                        <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-mono ${
                          isSelected ? 'bg-zinc-200 text-zinc-800' : 'bg-zinc-100 text-zinc-500'
                        }`}>
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Google Calendar Connection Status / Button */}
          {authState.isConnected ? (
            <div className="inline-flex items-center gap-1 text-[11px] sm:text-xs font-medium text-blue-900 bg-blue-50 px-2 py-1 sm:px-2.5 sm:py-1 rounded-md border border-blue-200">
              <Check className="w-3 h-3 text-blue-600 shrink-0" />
              <span>Calendar</span>
              <button
                type="button"
                onClick={handleDisconnectGoogle}
                title={`Disconnect ${authState.email || 'Google Calendar'}`}
                className="ml-0.5 text-blue-400 hover:text-blue-700 p-0.5 rounded transition-colors cursor-pointer"
              >
                <LogOut className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              id="connect-google-calendar-btn"
              onClick={handleConnectGoogle}
              disabled={isConnectingGoogle}
              className="inline-flex items-center gap-1 text-[11px] sm:text-xs font-medium text-zinc-700 hover:text-zinc-900 bg-zinc-100 hover:bg-zinc-200 disabled:opacity-50 px-2 py-1 sm:px-2.5 sm:py-1 rounded-md border border-zinc-300 transition-all cursor-pointer shadow-2xs"
              title="Connect Google Calendar for read-only event access"
            >
              {isConnectingGoogle ? (
                <Loader2 className="w-3 h-3 animate-spin text-zinc-600" />
              ) : (
                <Calendar className="w-3 h-3 text-blue-600 shrink-0" />
              )}
              <span className="hidden sm:inline">
                {isConnectingGoogle ? 'Connecting...' : 'Connect Calendar'}
              </span>
              <span className="sm:hidden">
                {isConnectingGoogle ? '...' : '+ Calendar'}
              </span>
            </button>
          )}

          {/* Reminders / Push Notification Status */}
          {pushStatus.isSupported &&
            (pushStatus.isSubscribed ? (
              <button
                type="button"
                onClick={handleTestNotification}
                title="Test background reminder push notification"
                className="inline-flex items-center gap-1 text-[11px] sm:text-xs font-medium text-emerald-800 bg-emerald-50 hover:bg-emerald-100 px-2 py-1 sm:px-2.5 sm:py-1 rounded-md border border-emerald-200 transition-colors cursor-pointer"
              >
                <Check className="w-3 h-3 text-emerald-600 shrink-0" />
                <span>Reminders</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleEnablePush}
                disabled={isEnabling}
                className="inline-flex items-center gap-1 text-[11px] sm:text-xs font-medium text-zinc-700 hover:text-zinc-900 bg-zinc-100 hover:bg-zinc-200 disabled:opacity-50 px-2 py-1 sm:px-2.5 sm:py-1 rounded-md border border-zinc-300 transition-all cursor-pointer shadow-2xs"
                title="Enable background reminders on your phone"
              >
                {isEnabling ? (
                  <Loader2 className="w-3 h-3 animate-spin text-zinc-600" />
                ) : (
                  <Bell className="w-3 h-3 text-amber-600 shrink-0" />
                )}
                <span className="hidden sm:inline">
                  {isEnabling ? 'Enabling...' : 'Enable Reminders'}
                </span>
                <span className="sm:hidden">
                  {isEnabling ? '...' : '+ Reminders'}
                </span>
              </button>
            ))}
        </div>
      </div>

      {feedback && (
        <div className="max-w-4xl mx-auto mt-2">
          <div className="text-xs py-1.5 px-3 rounded-md bg-zinc-900 text-white flex items-center gap-2 animate-in fade-in">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>{feedback}</span>
          </div>
        </div>
      )}
    </header>
  );
};
