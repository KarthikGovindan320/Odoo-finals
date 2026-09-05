/**
 * The very first screen a new browser sees, shown once before the login page.
 *
 * It is mounted over an already-rendered LoginPage rather than in place of it,
 * so dismissing it is a reveal -- the screen slides up and off, and the sign-in
 * form is already sitting there underneath. Persistence of "already seen" is
 * the caller's concern (see lib/splash.ts); this component only animates.
 */
import { useRef, useState } from 'react';

type Props = {
  onContinue: () => void;
};

/** Matches the CSS transition duration, as a fallback if transitionend never fires. */
const FALLBACK_MS = 800;

export function SplashScreen({ onContinue }: Props) {
  const [leaving, setLeaving] = useState(false);
  const firedRef = useRef(false);

  const finish = (): void => {
    if (firedRef.current) return;
    firedRef.current = true;
    onContinue();
  };

  const dismiss = (): void => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(finish, FALLBACK_MS);
  };

  return (
    <div
      className={`splash${leaving ? ' splash--leaving' : ''}`}
      onTransitionEnd={(event) => {
        if (event.propertyName === 'transform') finish();
      }}
    >
      <div className="splash__content">
        <div className="splash__mark" aria-hidden="true">PP</div>
        <h1 className="splash__name">PeoplePay360</h1>
        <p className="splash__quote">&ldquo;Payroll you can trust. People you can count on.&rdquo;</p>
        <button
          type="button"
          className="btn btn--primary splash__cta"
          onClick={dismiss}
          disabled={leaving}
          autoFocus
        >
          Continue
        </button>
      </div>
    </div>
  );
}
