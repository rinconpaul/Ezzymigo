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
      window.location.assign(uri);
      return { success: true, uri };
    } catch (err) {
      console.warn('[DeviceActionLauncher] Direct assign failed, attempting link click fallback:', err);
      try {
        const link = document.createElement('a');
        link.href = uri;
        link.target = '_top';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        return { success: true, uri };
      } catch (fallbackErr) {
        console.error('[DeviceActionLauncher] Fallback failed:', fallbackErr);
        return { success: false, uri };
      }
    }
  }
}

export const defaultDeviceActionLauncher = new WebDeviceActionLauncher();
