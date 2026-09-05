/**
 * Whether this employee prefers to clock in by biometric reader.
 *
 * A per-person preference on a shared device, so it lives in localStorage
 * rather than on the employee record: it says how *this browser* should present
 * the punch, which is a property of where you are standing, not of your
 * employment. It is also why nothing server-side depends on it -- the attendance
 * record is identical either way.
 */
const BIOMETRIC_KEY = 'pp360_biometric_attendance';

export function readBiometricPreference(): boolean {
  try {
    return localStorage.getItem(BIOMETRIC_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeBiometricPreference(enabled: boolean): void {
  try {
    localStorage.setItem(BIOMETRIC_KEY, String(enabled));
  } catch {
    // Best effort. The toggle still works for this visit.
  }
}
