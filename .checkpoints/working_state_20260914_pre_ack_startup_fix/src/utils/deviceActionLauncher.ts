import { ImmediateDeviceActionPayload } from '../types';

export interface DeviceActionLauncher {
  launch(action: ImmediateDeviceActionPayload): Promise<{ success: boolean; uri?: string }>;
}

/**
 * Web / PWA implementation of DeviceActionLauncher.
 * Directly invokes device dialer or SMS composer via tel: or sms: URI schemes.
 * The operating system retains final user authority over dialing or sending.
 * When ported to Flutter, this interface is backed by platform channels.
 */
export class WebDeviceActionLauncher implements DeviceActionLauncher {
  async launch(action: ImmediateDeviceActionPayload): Promise<{ success: boolean; uri?: string }> {
    if (action.status !== 'ready' || !action.sanitizedPhone) {
      return { success: false };
    }

    let uri = '';
    if (action.action === 'call') {
      uri = `tel:${action.sanitizedPhone}`;
    } else if (action.action === 'sms') {
      if (action.prefilledMessage) {
        uri = `sms:${action.sanitizedPhone}?body=${encodeURIComponent(action.prefilledMessage)}`;
      } else {
        uri = `sms:${action.sanitizedPhone}`;
      }
    } else {
      return { success: false };
    }

    try {
      // Direct anchor click with _top target is the most reliable way across iOS Safari,
      // Android Chrome, and iframes to invoke native tel: or sms: URI schemes.
      const link = document.createElement('a');
      link.href = uri;
      link.target = '_top';
      link.rel = 'noopener noreferrer';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      return { success: true, uri };
    } catch (err) {
      console.warn('[DeviceActionLauncher] Anchor click failed, attempting window.location fallback:', err);
      try {
        window.location.href = uri;
        return { success: true, uri };
      } catch (innerErr) {
        try {
          window.location.assign(uri);
          return { success: true, uri };
        } catch (assignErr) {
          console.error('[DeviceActionLauncher] All launch methods failed:', assignErr);
          return { success: false, uri };
        }
      }
    }
  }
}

export const defaultDeviceActionLauncher = new WebDeviceActionLauncher();
