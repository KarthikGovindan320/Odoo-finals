/**
 * The handful of icons this interface needs, drawn inline.
 *
 * No icon package. Five glyphs do not justify a dependency, a bundle and a
 * licence, and a hand-drawn set can be built on the same 20px grid with the same
 * stroke weight as the rest of the interface rather than inheriting somebody
 * else's proportions.
 *
 * All of them are stroke-only on currentColor, so they take the colour of
 * whatever they sit inside and need no dark-mode variant. They are marked
 * aria-hidden throughout: every one of them sits beside its own text label, and
 * announcing "document icon, Contracts" reads the same thing twice.
 */
export type IconName =
  | 'contract'
  | 'clock'
  | 'calendar'
  | 'wallet'
  | 'receipt'
  | 'fingerprint';

const PATHS: Record<IconName, React.ReactNode> = {
  // A sheet with ruled lines and a signature stroke: a signed agreement.
  contract: (
    <>
      <path d="M5 2.5h7.5L16 6v11.5H5z" />
      <path d="M12 2.5V6h3.5" />
      <path d="M7.5 9.5h6M7.5 12h6" />
      <path d="M7.5 14.75c1-.9 1.9.9 2.9 0s1.9.9 2.9 0" />
    </>
  ),

  // A clock face. Presence is a question about time of day.
  clock: (
    <>
      <circle cx="10" cy="10" r="7.25" />
      <path d="M10 5.75V10l2.9 1.9" />
    </>
  ),

  // A month grid with one day marked: leave is days taken out of a calendar.
  calendar: (
    <>
      <rect x="3" y="4.25" width="14" height="13" rx="1.5" />
      <path d="M3 8.25h14M7 2.75v3M13 2.75v3" />
      <rect x="8.5" y="11" width="3" height="3" rx="0.5" fill="currentColor" stroke="none" />
    </>
  ),

  // A wallet: the balance granted, before any of it is drawn down.
  wallet: (
    <>
      <rect x="2.75" y="5" width="14.5" height="11" rx="2" />
      <path d="M2.75 8.5h14.5" />
      <circle cx="13.75" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),

  // Concentric ridges: the reader, not a finger.
  fingerprint: (
    <>
      <path d="M10 9.5v3.2" />
      <path d="M7.2 8.6a3 3 0 0 1 5.6 0v3.1a3.4 3.4 0 0 1-.5 1.8" />
      <path d="M4.6 8.1a5.6 5.6 0 0 1 10.8 0v3.4a6 6 0 0 1-.7 2.8" />
      <path d="M5.1 14.9A6 6 0 0 0 5.8 12" />
      <path d="M2.6 6.4a8.6 8.6 0 0 1 14.8 0" />
    </>
  ),

  // A receipt with a torn foot: the document payroll produces.
  receipt: (
    <>
      <path d="M4.5 2.75h11v14.5l-2.2-1.3-2.2 1.3-2.2-1.3-2.2 1.3-2.2-1.3z" />
      <path d="M7.5 6.75h5M7.5 9.5h5M7.5 12.25h3" />
    </>
  ),
};

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
