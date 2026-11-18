/** Conversation logic shared by the CLI (ask.ts) and the web API (server.ts). */
import { detectCountries } from "./retriever.js";
import type { Turn } from "./answer.js";

/** Keep the last few Q/A pairs so follow-ups ("what about Germany?") make sense. */
export const MAX_HISTORY_TURNS = 3;

export interface ChatState {
  history: Turn[];
  lastCountries: string[];
  lastQuestion: string;
}

export const emptyState = (): ChatState => ({ history: [], lastCountries: [], lastQuestion: "" });

export interface SearchPlan {
  countries: string[];
  /** True when no country was named and the previous turn's countries were reused. */
  carried: boolean;
  searchText: string;
  /** Human-readable scope, e.g. "GB, DE" or "all countries". */
  scope: string;
}

/** Decide which countries to filter on and what text to embed for this question. */
export function planSearch(question: string, state: ChatState, forcedCountries: string[] = []): SearchPlan {
  // Countries: forced > mentioned in this question > carried over from the previous turn.
  let countries = forcedCountries.length ? forcedCountries : detectCountries(question);
  const carried = !countries.length && state.lastCountries.length > 0;
  if (carried) countries = state.lastCountries;

  // Short follow-ups ("and in Germany?") carry little meaning on their own; add the previous question.
  const isFollowUp = state.lastQuestion && question.split(/\s+/).length < 8;
  const searchText = isFollowUp ? `${state.lastQuestion} ${question}` : question;

  const scope = countries.length ? `${countries.join(", ")}${carried ? " (from previous question)" : ""}` : "all countries";
  return { countries, carried, searchText, scope };
}

/** State after a completed turn. */
export function nextState(state: ChatState, question: string, answer: string, countries: string[]): ChatState {
  const history: Turn[] = [...state.history, { role: "user", content: question }, { role: "assistant", content: answer }];
  return { history: history.slice(-2 * MAX_HISTORY_TURNS), lastCountries: countries, lastQuestion: question };
}
