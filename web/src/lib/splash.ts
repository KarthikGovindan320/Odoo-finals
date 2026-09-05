/**
 * Remembers whether the pre-login splash has already been shown.
 *
 * sessionStorage, so it survives signing out and back in -- including as a
 * different user, which is the case that matters: switching from Admin to
 * Payroll Manager should go straight to the form. It clears when the tab
 * closes, so a fresh visit sees the screen again.
 *
 * localStorage would also satisfy that rule, but it hides the screen on this
 * browser permanently after one view, which is the wrong trade for something
 * you may want to show someone. If "once per device, forever" is what you want
 * later, this is the one line to change.
 */
const SPLASH_SEEN_KEY = 'pp360_splash_seen';

export function hasSeenSplash(): boolean {
  try {
    return sessionStorage.getItem(SPLASH_SEEN_KEY) === 'true';
  } catch {
    // Storage unavailable -- private browsing, site data blocked, a thumbnailer.
    // Skip rather than show a screen that could never be dismissed for good.
    return true;
  }
}

export function markSplashSeen(): void {
  try {
    sessionStorage.setItem(SPLASH_SEEN_KEY, 'true');
  } catch {
    // Best effort. Worst case it appears once more.
  }
}
