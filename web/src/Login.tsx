import { useEffect, useRef, useState } from "react";
import { signInWithGoogle, type User } from "./api";

/** Minimal typing for the Google Identity Services script (https://accounts.google.com/gsi/client). */
interface GoogleId {
  initialize(opts: {
    client_id: string;
    callback: (r: { credential: string }) => void;
    ux_mode?: "popup" | "redirect";
    auto_select?: boolean;
    use_fedcm_for_prompt?: boolean;
  }): void;
  renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
  disableAutoSelect(): void;
}
declare global {
  interface Window {
    google?: { accounts: { id: GoogleId } };
  }
}

const GSI_SRC = "https://accounts.google.com/gsi/client";
let gsiLoading: Promise<void> | null = null;

function loadGsi(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  gsiLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = GSI_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      gsiLoading = null;
      reject(new Error("Couldn't load Google sign-in. Check your connection or ad blocker."));
    };
    document.head.appendChild(s);
  });
  return gsiLoading;
}

/** After sign-out, stop Google from silently signing the same account back in. */
export function disableGoogleAutoSelect(): void {
  window.google?.accounts?.id?.disableAutoSelect();
}

export function Login({ clientId, notice, onSignedIn }: { clientId: string; notice?: string; onSignedIn: (u: User) => void }) {
  const buttonRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadGsi()
      .then(() => {
        if (cancelled || !buttonRef.current || !window.google) return;
        const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        window.google.accounts.id.initialize({
          client_id: clientId,
          ux_mode: "popup",
          callback: async ({ credential }) => {
            setBusy(true);
            setError(null);
            try {
              onSignedIn(await signInWithGoogle(credential));
            } catch (err) {
              setError((err as Error).message);
              setBusy(false);
            }
          },
        });
        window.google.accounts.id.renderButton(buttonRef.current, {
          type: "standard",
          theme: dark ? "filled_black" : "outline",
          size: "large",
          shape: "pill",
          text: "continue_with",
          logo_alignment: "left",
          width: 280,
        });
      })
      .catch((err) => !cancelled && setError((err as Error).message));
    return () => {
      cancelled = true;
    };
  }, [clientId, onSignedIn]);

  return (
    <div className="login">
      <div className="login-card">
        <span className="logo big" aria-hidden>
          K
        </span>
        <h1>Kalvora HR Assistant</h1>
        <p className="login-sub">Sign in with your Google account to ask questions about Kalvora's HR policies.</p>
        {notice && <div className="login-notice">{notice}</div>}
        <div className="gsi-slot" ref={buttonRef} aria-busy={busy} />
        {busy && <p className="login-sub">Signing you in…</p>}
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
