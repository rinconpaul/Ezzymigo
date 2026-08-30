// Client-side Web Push notification manager for Ezzymigo PWA

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) {
    console.warn('[Push] Service workers are not supported in this browser.');
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
    });
    await navigator.serviceWorker.ready;
    return registration;
  } catch (error) {
    console.error('[Push] Service worker registration failed:', error);
    return null;
  }
}

export async function subscribeToPushNotifications(): Promise<{
  success: boolean;
  permission: NotificationPermission;
  error?: string;
}> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return {
      success: false,
      permission: 'denied',
      error: 'Push notifications are not supported by this browser.',
    };
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return {
        success: false,
        permission,
        error: 'Notification permission was not granted.',
      };
    }

    const registration = await registerServiceWorker();
    if (!registration) {
      return {
        success: false,
        permission,
        error: 'Could not activate service worker.',
      };
    }

    // Fetch VAPID public key from backend
    const keyRes = await fetch('/api/push/vapid-public-key');
    if (!keyRes.ok) {
      throw new Error('Failed to retrieve VAPID public key from server');
    }
    const { publicKey } = await keyRes.json();
    if (!publicKey) {
      throw new Error('VAPID public key missing on server');
    }

    const applicationServerKey = urlBase64ToUint8Array(publicKey);

    // Check existing subscription or create new
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    }

    // Send subscription to server
    const subRes = await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription }),
    });

    if (!subRes.ok) {
      throw new Error('Failed to register subscription on server');
    }

    return {
      success: true,
      permission: 'granted',
    };
  } catch (err: any) {
    console.error('[Push] Subscription failed:', err);
    return {
      success: false,
      permission: Notification.permission,
      error: err?.message || 'Failed to subscribe to push notifications.',
    };
  }
}

export async function checkPushSubscriptionStatus(): Promise<{
  isSupported: boolean;
  permission: NotificationPermission;
  isSubscribed: boolean;
}> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return {
      isSupported: false,
      permission: 'denied',
      isSubscribed: false,
    };
  }

  const permission = Notification.permission;
  try {
    const registration = await navigator.serviceWorker.getRegistration('/sw.js');
    if (!registration) {
      return { isSupported: true, permission, isSubscribed: false };
    }
    const subscription = await registration.pushManager.getSubscription();
    return {
      isSupported: true,
      permission,
      isSubscribed: Boolean(subscription),
    };
  } catch {
    return { isSupported: true, permission, isSubscribed: false };
  }
}

export async function sendTestNotification(): Promise<{ success: boolean; message: string }> {
  try {
    const res = await fetch('/api/push/test', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to trigger test push');
    return { success: true, message: data.message || 'Test notification sent!' };
  } catch (err: any) {
    return { success: false, message: err?.message || 'Error sending test push' };
  }
}
