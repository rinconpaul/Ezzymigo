import React, { useState, useEffect } from 'react';
import { Brain, Sparkles, Bell, BellRing, CheckCircle2, Loader2 } from 'lucide-react';
import { checkPushSubscriptionStatus, subscribeToPushNotifications, sendTestNotification } from '../utils/pushManager';

export const Header: React.FC = () => {
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

  useEffect(() => {
    checkPushSubscriptionStatus().then(setPushStatus);
  }, []);

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
    <header className="border-b border-zinc-200 bg-white py-4 px-4 sm:px-6 shadow-xs">
      <div className="max-w-4xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-zinc-900 flex items-center justify-center text-white shadow-xs shrink-0">
            <Brain className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold text-zinc-900 tracking-tight">Ezzymigo</h1>
              <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600 font-medium border border-zinc-200">
                Prototype
              </span>
            </div>
            <p className="text-xs text-zinc-500">Personal Intention Memory Assistant</p>
          </div>
        </div>

        <div className="flex items-center gap-2 self-end sm:self-auto flex-wrap">
          {pushStatus.isSupported && (
            pushStatus.isSubscribed ? (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleTestNotification}
                  title="Test background reminder push notification"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-800 bg-emerald-50 hover:bg-emerald-100 px-2.5 py-1.5 rounded-md border border-emerald-200 transition-colors cursor-pointer"
                >
                  <BellRing className="w-3.5 h-3.5 text-emerald-600 animate-pulse" />
                  <span>Reminders Active</span>
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleEnablePush}
                disabled={isEnabling}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-700 hover:text-zinc-900 bg-zinc-100 hover:bg-zinc-200 disabled:opacity-50 px-2.5 py-1.5 rounded-md border border-zinc-300 transition-all cursor-pointer shadow-2xs"
                title="Enable background reminders on your phone"
              >
                {isEnabling ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-600" />
                ) : (
                  <Bell className="w-3.5 h-3.5 text-amber-600" />
                )}
                <span>{isEnabling ? 'Enabling...' : 'Enable Reminders'}</span>
              </button>
            )
          )}

          <div className="flex items-center gap-2 text-xs text-zinc-600 bg-zinc-50 px-3 py-1.5 rounded-md border border-zinc-200">
            <Sparkles className="w-3.5 h-3.5 text-zinc-700" />
            <span>Gemini 3.5 Flash Lite</span>
          </div>
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
