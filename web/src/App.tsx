import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { UnauthorizedError, fetchInfo, streamChat, type ChatState, type Info, type Source, type User } from "./api";
import { Markdown } from "./Markdown";

interface Message {
  id: number;
  role: "user" | "assistant";
  content: string;
  scope?: string;
  sources?: Source[];
  error?: string;
  pending?: boolean;
}

const COUNTRY_NAMES: Record<string, string> = {
  IN: "India",
  US: "United States",
  GB: "United Kingdom",
  DE: "Germany",
  NL: "Netherlands",
  SG: "Singapore",
  AU: "Australia",
  CA: "Canada",
  AE: "UAE",
  PH: "Philippines",
};

const SUGGESTIONS = [
  "How much partner leave do UK employees get?",
  "Compare annual leave in Germany and the Netherlands",
  "What is the notice period for employees in India?",
  "Can I work remotely from another country?",
];

const emptyState = (): ChatState => ({ history: [], lastCountries: [], lastQuestion: "" });

let nextId = 1;

interface AppProps {
  user: User;
  /** Undefined when sign-in is disabled (local development). */
  onSignOut?: () => void;
  onSessionExpired: () => void;
}

export function App({ user, onSignOut, onSessionExpired }: AppProps) {
  const [info, setInfo] = useState<Info | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [state, setState] = useState<ChatState>(emptyState);
  const [input, setInput] = useState("");
  const [countries, setCountries] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetchInfo()
      .then(setInfo)
      .catch((err) => {
        if (err instanceof UnauthorizedError) return onSessionExpired();
        setInfo({ ok: false, error: "Can't reach the API server. Start it with `npm run server`.", countries: [] });
      });
  }, [onSessionExpired]);

  // Keep the newest message in view while streaming, unless the user scrolled up.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const patch = (id: number, fn: (m: Message) => Message) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? fn(m) : m)));

  async function send(question: string) {
    question = question.trim();
    if (!question || busy) return;
    setInput("");
    setBusy(true);

    const userMsg: Message = { id: nextId++, role: "user", content: question };
    const botId = nextId++;
    setMessages((ms) => [...ms, userMsg, { id: botId, role: "assistant", content: "", pending: true }]);
    requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    });

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamChat(
        { question, state, countries: countries.length ? countries : undefined },
        (e) => {
          if (e.type === "meta") patch(botId, (m) => ({ ...m, scope: e.scope, sources: e.sources }));
          else if (e.type === "token") patch(botId, (m) => ({ ...m, content: m.content + e.text }));
          else if (e.type === "done") {
            patch(botId, (m) => ({ ...m, content: e.answer, pending: false }));
            setState(e.state);
          } else if (e.type === "error") patch(botId, (m) => ({ ...m, error: e.message, pending: false }));
        },
        ctrl.signal,
      );
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onSessionExpired();
        return;
      }
      const aborted = (err as Error).name === "AbortError";
      patch(botId, (m) => ({ ...m, pending: false, error: aborted ? undefined : (err as Error).message, content: m.content + (aborted ? "\n\n*(stopped)*" : "") }));
    } finally {
      patch(botId, (m) => ({ ...m, pending: false }));
      abortRef.current = null;
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  function newChat() {
    abortRef.current?.abort();
    setMessages([]);
    setState(emptyState());
    inputRef.current?.focus();
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    send(input);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(input);
    }
  }

  const toggleCountry = (c: string) =>
    setCountries((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));

  const allCountries = info?.countries?.length ? info.countries : Object.keys(COUNTRY_NAMES);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>K</span>
          <div>
            <h1>Kalvora HR Assistant</h1>
            <p className="status">
              <span className={`dot ${info === null ? "wait" : info.ok ? "ok" : "bad"}`} />
              {info === null ? "Connecting…" : info.ok ? `${info.model} · top-${info.topK}` : "Offline"}
            </p>
          </div>
        </div>
        <div className="top-actions">
          <button className="ghost" onClick={newChat} disabled={!messages.length}>
            New chat
          </button>
          <UserMenu user={user} onSignOut={onSignOut} />
        </div>
      </header>

      {info && !info.ok && <div className="banner">{info.error}</div>}

      <div className="filters" role="group" aria-label="Limit answers to countries">
        <span className="filters-label">Countries</span>
        <button className={`chip ${countries.length === 0 ? "on" : ""}`} onClick={() => setCountries([])}>
          Auto-detect
        </button>
        {allCountries.map((c) => (
          <button key={c} className={`chip ${countries.includes(c) ? "on" : ""}`} onClick={() => toggleCountry(c)} title={COUNTRY_NAMES[c] ?? c}>
            {c}
          </button>
        ))}
      </div>

      <main className="messages" ref={listRef}>
        {messages.length === 0 ? (
          <div className="empty">
            <h2>Ask about Kalvora's HR policies</h2>
            <p>Answers come only from the policy documents, with a citation for each fact. Name a country, or pick one above.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="suggestion" onClick={() => send(s)} disabled={busy || !info?.ok}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="thread">
            {messages.map((m) => (m.role === "user" ? <UserBubble key={m.id} text={m.content} /> : <BotMessage key={m.id} msg={m} />))}
          </div>
        )}
      </main>

      <form className="composer" onSubmit={onSubmit}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={countries.length ? `Ask about ${countries.map((c) => COUNTRY_NAMES[c] ?? c).join(", ")}…` : "Ask a question about leave, pay, benefits…"}
          rows={1}
          autoFocus
        />
        {busy ? (
          <button type="button" className="send stop" onClick={() => abortRef.current?.abort()} aria-label="Stop">
            ■
          </button>
        ) : (
          <button type="submit" className="send" disabled={!input.trim()} aria-label="Send">
            ↑
          </button>
        )}
      </form>
      <p className="hint">Enter to send · Shift+Enter for a new line · follow-ups like “and in Germany?” keep context</p>
    </div>
  );
}

function UserMenu({ user, onSignOut }: { user: User; onSignOut?: () => void }) {
  const [open, setOpen] = useState(false);
  const [imgOk, setImgOk] = useState(true);
  const initials = user.name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".user-menu")) setOpen(false);
    };
    const esc = (e: globalThis.KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("click", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="user-menu">
      <button className="avatar" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} title={user.email}>
        {user.picture && imgOk ? (
          <img src={user.picture} alt="" referrerPolicy="no-referrer" onError={() => setImgOk(false)} />
        ) : (
          <span>{initials || "?"}</span>
        )}
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-user">
            <strong>{user.name}</strong>
            <span>{user.email}</span>
          </div>
          {onSignOut ? (
            <button role="menuitem" className="menu-item" onClick={onSignOut}>
              Sign out
            </button>
          ) : (
            <div className="menu-note">Sign-in is off (no GOOGLE_CLIENT_ID)</div>
          )}
        </div>
      )}
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="row user">
      <div className="bubble">{text}</div>
    </div>
  );
}

/** Local models can take a while before the first visible token (hidden reasoning), so show elapsed time. */
function Thinking({ searching }: { searching: boolean }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const id = setInterval(() => setSecs(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="thinking" aria-live="polite">
      <div className="typing" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <span>
        {searching ? "Searching policies" : "Thinking"}
        {secs >= 3 ? ` · ${secs}s` : "…"}
      </span>
    </div>
  );
}

function BotMessage({ msg }: { msg: Message }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const labels = new Set(msg.sources?.map((s) => s.label));

  function cite(label: string) {
    setOpen(true);
    setActive(label);
    requestAnimationFrame(() => document.getElementById(`src-${msg.id}-${label}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  }

  return (
    <div className="row bot">
      <div className="bot-body">
        {msg.scope && <div className="scope">Searched {msg.scope}</div>}
        {msg.pending && !msg.content ? (
          <Thinking searching={!msg.scope} />
        ) : (
          <div className="answer">
            <Markdown text={msg.content} onCite={cite} knownLabels={labels} />
            {msg.pending && <span className="caret" />}
          </div>
        )}
        {msg.error && <div className="error">{msg.error}</div>}
        {!!msg.sources?.length && (
          <div className="sources">
            <button className="sources-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? "▾" : "▸"} {msg.sources.length} sources
            </button>
            {open && (
              <ul>
                {msg.sources.map((s) => (
                  <li key={s.label} id={`src-${msg.id}-${s.label}`} className={active === s.label ? "active" : ""}>
                    <details open={active === s.label}>
                      <summary>
                        <span className="cite static">{s.label}</span>
                        <span className="src-title">{s.title}</span>
                        <span className="src-meta">
                          {s.country} · {s.section}
                        </span>
                      </summary>
                      <pre className="src-text">{s.text}</pre>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
