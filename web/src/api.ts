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
