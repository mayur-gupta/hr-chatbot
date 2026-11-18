/**
 * Ask the Kalvora HR policies a question.
 *   npm run ask -- "How much partner leave do UK employees get?"   one-shot
 *   npm run ask                                                    interactive chat
 */
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Command } from "commander";
import { loadSettings } from "./config.js";
import { COUNTRY_CODES, Retriever } from "./retriever.js";
import { Answerer, citeLabel } from "./answer.js";
import { type ChatState, emptyState, nextState, planSearch } from "./chat.js";

interface Options {
  k?: number;
  country?: string;
  model?: string;
  context: boolean;
}

const program = new Command()
  .name("ask")
  .description("Ask questions about the Kalvora HR policies (RAG over ChromaDB + an LM Studio chat model)")
  .argument("[question...]", "question to ask; omit to start an interactive chat")
  .option("-k, --k <n>", "number of chunks to retrieve (default: TOP_K from .env)", (v) => parseInt(v, 10))
  .option("-c, --country <codes>", `force country filter, comma-separated (${COUNTRY_CODES.join(", ")})`)
  .option("-m, --model <id>", "LM Studio chat model id (default: CHAT_MODEL from .env, else auto)")
  .option("--context", "print the retrieved chunk text before each answer", false);

class Session {
  state: ChatState = emptyState();

  constructor(
    private retriever: Retriever,
    private answerer: Answerer,
    private k: number,
    private forcedCountries: string[],
    public showContext: boolean,
  ) {}

  async ask(question: string): Promise<void> {
    const { countries, searchText, scope } = planSearch(question, this.state, this.forcedCountries);
    const hits = await this.retriever.retrieve(searchText, this.k, countries);
    console.log(dim(`\n[searched ${scope}: ${hits.length} chunks]`));
    if (this.showContext) {
      for (const h of hits) console.log(dim(`\n--- [${citeLabel(h)}] d=${h.distance.toFixed(3)}\n${h.text}`));
      console.log();
    }

    stdout.write("\n");
    const answer = await this.answerer.answer(question, hits, this.state.history, (t) => stdout.write(t));
    stdout.write("\n");

    console.log(dim("\nSources:"));
    for (const h of hits) {
      console.log(dim(`  [${citeLabel(h)}] ${h.title} (${h.country}) | ${h.sectionTitle}  d=${h.distance.toFixed(3)}`));
    }

    this.state = nextState(this.state, question, answer, countries);
  }

  reset(): void {
    this.state = emptyState();
  }
}

const dim = (s: string) => (stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);

async function main(): Promise<void> {
  program.parse();
  const opts = program.opts<Options>();
  const question = program.args.join(" ").trim();
  const settings = loadSettings();

  const forced = (opts.country ?? "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  const bad = forced.filter((c) => !COUNTRY_CODES.includes(c));
  if (bad.length) throw new Error(`Unknown country code(s): ${bad.join(", ")}. Use: ${COUNTRY_CODES.join(", ")}`);

  const retriever = await Retriever.open(settings);
  const answerer = new Answerer(settings);
  const model = await answerer.init(opts.model);
  const session = new Session(retriever, answerer, opts.k ?? settings.topK, forced, opts.context);

  if (question) {
    await session.ask(question);
    return;
  }

  console.log(`Kalvora HR assistant | chat: ${model} | embed: ${settings.embedModel} | top-k: ${opts.k ?? settings.topK}`);
  console.log(dim("Ask a question. Commands: /context (toggle chunk text), /reset (clear history), /exit\n"));

  const rl = readline.createInterface({ input: stdin, output: stdout });
  rl.on("SIGINT", () => {
    rl.close();
    process.exit(0);
  });
  for (;;) {
    let line: string;
    try {
      line = (await rl.question("> ")).trim();
    } catch {
      break; // stdin closed
    }
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/reset") {
      session.reset();
      console.log(dim("History cleared.\n"));
      continue;
    }
    if (line === "/context") {
      session.showContext = !session.showContext;
      console.log(dim(`Show context: ${session.showContext ? "on" : "off"}\n`));
      continue;
    }
    try {
      await session.ask(line);
    } catch (err) {
      console.error(`\nERROR: ${(err as Error).message}`);
    }
    console.log();
  }
  rl.close();
}

main().catch((err) => {
  console.error(`\nERROR: ${(err as Error).message}`);
  process.exit(1);
});
