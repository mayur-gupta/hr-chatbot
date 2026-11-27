/** List the models the configured chat and embedding endpoints offer:  npm run models */
import OpenAI from "openai";
import { loadSettings, type Endpoint } from "./config.js";

async function list(label: string, e: Endpoint): Promise<void> {
  const client = new OpenAI({ baseURL: e.baseUrl, apiKey: e.apiKey || "none" });
  console.log(`${label}: ${e.baseUrl}`);
  try {
    const ids: string[] = [];
    for await (const m of client.models.list()) ids.push(m.id);
    ids.sort().forEach((id) => console.log(`  ${id}`));
    if (!ids.length) console.log("  (no models listed)");
  } catch (err) {
    console.log(`  ERROR: ${(err as Error).message}`);
  }
}

const s = loadSettings();
await list("Chat endpoint", s.chat);
if (s.embed.baseUrl !== s.chat.baseUrl || s.embed.apiKey !== s.chat.apiKey) await list("\nEmbedding endpoint", s.embed);
console.log(`\nConfigured: CHAT_MODEL=${s.chatModel || "(auto)"}  EMBED_MODEL=${s.embedModel}`);
