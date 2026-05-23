/**
 * Web Notifications.
 *
 * The browser's `Notification` API requires:
 * 1. A secure context (HTTPS or localhost).
 * 2. Explicit user permission, granted via a user gesture.
 * 3. The tab/PWA to be backgrounded — we skip the notification when the
 *    document is focused, since the inbox is already updating live via
 *    the realtime channel.
 *
 * iOS Safari additionally requires the PWA to be installed via "Add to
 * Home Screen" for notifications to work; this module's API is the same
 * regardless, the browser handles the install gate.
 */

export type PermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

export function permissionState(): PermissionState {
  if (typeof Notification === 'undefined') return 'unsupported';
  return Notification.permission as PermissionState;
}

/**
 * Ask the browser for notification permission. Must be invoked from a
 * user gesture (button click) — calling it outside of one is a no-op
 * in modern browsers. Returns the resulting permission state.
 */
export async function requestPermission(): Promise<PermissionState> {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const result = await Notification.requestPermission();
    return result as PermissionState;
  } catch {
    return 'denied';
  }
}

interface ShowOpts {
  title: string;
  body?: string;
  tag?: string; // de-dupe identifier
  onClick?: () => void; // invoked on user click
}

/**
 * Fire a notification if we're allowed, the page isn't focused, and the
 * platform supports it. No-ops otherwise. Returns true if a notification
 * was actually shown so callers can fall back to in-app cues if needed.
 */
export function show(opts: ShowOpts): boolean {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission !== 'granted') return false;
  // Suppress when the tab is in the foreground — the inbox updates
  // live via realtime, no need to bother the user with an OS toast.
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
    return false;
  }
  try {
    const n = new Notification(opts.title, {
      body: opts.body,
      tag: opts.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
    });
    if (opts.onClick) {
      n.onclick = () => {
        window.focus();
        opts.onClick?.();
        n.close();
      };
    }
    return true;
  } catch {
    return false;
  }
}
