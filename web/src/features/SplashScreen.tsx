/**
 * The screen that sits in front of the login form, once per session.
 *
 * Mounted over an already-rendered LoginPage rather than in place of it, so
 * dismissing it is a reveal: the panel slides up and off, and the sign-in form
 * is already sitting there underneath rather than mounting into the gap it
 * leaves. Whether it should appear at all is the caller's business -- see
 * lib/splash.ts.
 *
 * Any key dismisses it, which is what was asked for. A click or tap does too:
 * "press any key" is not an instruction a phone can follow, and a screen that
 * only a keyboard can get past is a screen some people cannot get past. The
 * hint names the keyboard, because that is the gesture most people will reach
 * for on the device this is usually shown on.
 */
import { useEffect, useRef, useState } from 'react';

type Props = {
  onContinue: () => void;
};

/** Matches the CSS transition, and stands in if transitionend never fires. */
const LEAVE_MS = 700;

export function SplashScreen({ onContinue }: Props) {
  const [leaving, setLeaving] = useState(false);
  const finished = useRef(false);
  const surface = useRef<HTMLDivElement>(null);

  const finish = (): void => {
    if (finished.current) return;
    finished.current = true;
    onContinue();
  };

  useEffect(() => {
    // Focus the panel so the keydown lands here rather than in the login form
    // sitting underneath -- otherwise the first keystroke both dismisses the
    // splash and types a character into the email field.
    surface.current?.focus();

    const dismiss = (): void => {
      setLeaving((already) => {
        if (already) return already;
        window.setTimeout(finish, LEAVE_MS);
        return true;
      });
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      // Modifier-only presses are not "a key" in the sense anyone means, and
      // swallowing a browser shortcut on the way past would be rude.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab'].includes(event.key)) return;
      event.preventDefault();
      dismiss();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const dismissByPointer = (): void => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(finish, LEAVE_MS);
  };

  return (
    <div
      ref={surface}
      className={`splash${leaving ? ' splash--leaving' : ''}`}
      onClick={dismissByPointer}
      onTransitionEnd={(event) => {
        if (event.propertyName === 'transform') finish();
      }}
      role="button"
      tabIndex={0}
      aria-label="Continue to sign in"
    >
      <div className="splash__content">
        <span className="splash__mark" aria-hidden="true">PP</span>
        <h1 className="splash__name">PeoplePay360</h1>
        <p className="splash__quote">
          Pay is not stored. It is derived.
        </p>
        <p className="splash__hint" aria-hidden="true">Press any key to continue</p>
      </div>
    </div>
  );
}
