import path from "node:path";
import { describe, expect, it } from "vitest";
import { isLocal, loadSettings, PROJECT_ROOT } from "../src/config.js";

describe("loadSettings", () => {
  it("defaults chat and embeddings to LM Studio, and the corpus to corpus/ in the repo", () => {
    const s = loadSettings({});
    expect(s.chat).toEqual({ baseUrl: "http://localhost:1234/v1", apiKey: "lm-studio" });
    expect(s.embed).toEqual(s.chat);
    expect(s.corpusDir).toBe(path.join(PROJECT_ROOT, "corpus"));
    expect(s.vectorStore).toBe("chroma");
    expect(isLocal(s.chat)).toBe(true);
  });

  it("uses hosted endpoints when set, without leaking the LM Studio key", () => {
    const s = loadSettings({
      CHAT_BASE_URL: "https://api.example.com/v1",
      CHAT_API_KEY: "k1",
      EMBED_BASE_URL: "https://emb.example.com/v1",
      EMBED_DIMENSIONS: "768",
      VECTOR_STORE: "file",
    });
    expect(s.chat).toEqual({ baseUrl: "https://api.example.com/v1", apiKey: "k1" });
    expect(s.embed).toEqual({ baseUrl: "https://emb.example.com/v1", apiKey: "" });
    expect(s.embedDimensions).toBe(768);
    expect(s.vectorStore).toBe("file");
    expect(isLocal(s.chat)).toBe(false);
  });

  it("uses Supabase by default on Vercel", () => {
    expect(loadSettings({ VERCEL: "1" }).vectorStore).toBe("supabase");
    expect(loadSettings({ VERCEL: "1", VECTOR_STORE: "file" }).vectorStore).toBe("file");
    expect(loadSettings({ VERCEL: "1", VECTOR_STORE: "chroma" }).vectorStore).toBe("chroma");
  });

  it("reads the Supabase settings and rejects a malformed URL", () => {
    const s = loadSettings({ VECTOR_STORE: "supabase", SUPABASE_URL: "https://abc.supabase.co/", SUPABASE_SECRET_KEY: "sb_secret_x" });
    expect(s.supabaseUrl).toBe("https://abc.supabase.co");
    expect(s.supabaseSecretKey).toBe("sb_secret_x");
    expect(loadSettings({}).supabaseUrl).toBe("");
    expect(() => loadSettings({ SUPABASE_URL: "abc.supabase.co" })).toThrow(/SUPABASE_URL/);
  });

  it("treats an empty EMBED_DIMENSIONS as unset", () => {
    expect(loadSettings({ EMBED_DIMENSIONS: "" }).embedDimensions).toBeUndefined();
  });
});
