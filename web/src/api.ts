/** Client for the chat API in src/server.ts. */

export type Turn = { role: "user" | "assistant"; content: string };

export interface ChatState {
  history: Turn[];
  lastCountries: string[];
  lastQuestion: string;
}

export interface Source {
  label: string;
  title: string;
  country: string;
  section: string;
  distance: number;
  text: string;
}

export type ChatEvent =
  | { type: "meta"; scope: string; countries: string[]; sources: Source[] }
  | { type: "token"; text: string }
  | { type: "done"; answer: string; state: ChatState }
  | { type: "error"; message: string };

export interface Info {
  ok: boolean;
  model?: string;
  embedModel?: string;
  topK?: number;
  countries: string[];
  error?: string;
}

export async function fetchInfo(): Promise<Info> {
  const res = await fetch("/api/info");
  if (res.status === 401) throw new UnauthorizedError();
  return res.json();
}

export interface ChatRequest {
  question: string;
  state: ChatState;
  countries?: string[];
}

/** POST a question and call onEvent for each NDJSON event as it streams in. */
export async function streamChat(req: ChatRequest, onEvent: (e: ChatEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
  if (buf.trim()) onEvent(JSON.parse(buf));
}

// ---------- auth ----------

export interface User {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

/** Thrown when the session is missing or expired; the app goes back to the sign-in screen. */
export class UnauthorizedError extends Error {
  constructor() {
    super("Your session has expired. Please sign in again.");
  }
}

export async function fetchAuthConfig(): Promise<{ enabled: boolean; clientId: string | null }> {
  const res = await fetch("/api/auth/config");
  if (!res.ok) throw new Error(`Auth config failed (${res.status})`);
  return res.json();
}

export async function fetchMe(): Promise<User | null> {
  const res = await fetch("/api/auth/me");
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`Session check failed (${res.status})`);
  return (await res.json()).user;
}

export async function signInWithGoogle(credential: string): Promise<User> {
  const res = await fetch("/api/auth/google", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Sign-in failed (${res.status})`);
  return body.user;
}

export async function signOut(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
}
