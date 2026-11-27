import { useCallback, useEffect, useState } from "react";
import { fetchAuthConfig, fetchMe, signOut, type User } from "./api";
import { App } from "./App";
import { Login, disableGoogleAutoSelect } from "./Login";

type AuthState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "signedOut"; clientId: string; notice?: string }
  | { status: "signedIn"; user: User; authEnabled: boolean; clientId: string | null };

/** Decides between the sign-in screen and the chat, based on the server's auth config and session cookie. */
export function Root() {
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [clientId, setClientId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const cfg = await fetchAuthConfig();
        setClientId(cfg.clientId);
        const user = await fetchMe();
        if (user) setAuth({ status: "signedIn", user, authEnabled: cfg.enabled, clientId: cfg.clientId });
        else if (cfg.clientId) setAuth({ status: "signedOut", clientId: cfg.clientId });
        else setAuth({ status: "error", message: "Sign-in is required but the server has no Google client id." });
      } catch {
        setAuth({ status: "error", message: "Can't reach the API server. Start it with `npm run server`." });
      }
    })();
  }, []);

  const onSignedIn = useCallback((user: User) => setAuth({ status: "signedIn", user, authEnabled: true, clientId }), [clientId]);

  const onSignOut = useCallback(async () => {
    await signOut().catch(() => {});
    disableGoogleAutoSelect();
    if (clientId) setAuth({ status: "signedOut", clientId });
  }, [clientId]);

  const onSessionExpired = useCallback(() => {
    if (clientId) setAuth({ status: "signedOut", clientId, notice: "Your session expired. Please sign in again." });
  }, [clientId]);

  if (auth.status === "loading") return <div className="center-msg">Loading…</div>;
  if (auth.status === "error") return <div className="center-msg error-text">{auth.message}</div>;
  if (auth.status === "signedOut") return <Login clientId={auth.clientId} notice={auth.notice} onSignedIn={onSignedIn} />;
  return <App user={auth.user} onSignOut={auth.authEnabled ? onSignOut : undefined} onSessionExpired={onSessionExpired} />;
}
