/**
 * Remembers whether this browser has already seen the pre-login splash.
 *
 * Tied to localStorage rather than the session or any user record, so signing
 * out and back in -- even as a different user -- never brings it back on the
 * same browser. A new browser or a cleared profile sees it again, which is
 * the intended scope: "first time on this device", not "first time ever".
 */
const SPLASH_SEEN_KEY = 'pp360_splash_seen';

export function hasSeenSplash(): boolean {
  try {
    return localStorage.getItem(SPLASH_SEEN_KEY) === 'true';
  } catch {
    // Storage unavailable (private browsing, disabled site data, etc.) --
    // default to skipping rather than showing a screen that could never be
    // permanently dismissed.
    return true;
  }
}

export function markSplashSeen(): void {
  try {
    localStorage.setItem(SPLASH_SEEN_KEY, 'true');
  } catch {
    // Best-effort only; worst case the splash reappears next visit.
  }
}
