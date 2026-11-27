#!/usr/bin/env node
/**
 * Smoke-test a deployment:
 *   node scripts/smoke-deploy.mjs https://host [--with-session]
 *
 * Public checks always run (UI served, sign-in enforced). With --with-session it signs a
 * session cookie with SMOKE_SESSION_SECRET (must equal the deployment's SESSION_SECRET) and
 * asks one real question. Send VERCEL_AUTOMATION_BYPASS_SECRET to get past Deployment Protection.
 */
import crypto from "node:crypto";

const [base, ...flags] = process.argv.slice(2);
if (!base) {
  console.error("usage: smoke-deploy.mjs <base-url> [--with-session]");
  process.exit(2);
}
const withSession = flags.includes("--with-session");
const headers = {};
if (process.env.VERCEL_AUTOMATION_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

let failed = 0;
async function check(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`PASS  ${name}  (${Date.now() - t0} ms)`);
  } catch (err) {
    failed++;
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const get = (path, extra = {}) => fetch(new URL(path, base), { headers: { ...headers, ...extra } });
const post = (path, body, extra = {}) =>
  fetch(new URL(path, base), { method: "POST", headers: { ...headers, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

await check("UI is served", async () => {
  const r = await get("/");
  assert(r.status === 200, `status ${r.status}`);
  assert((await r.text()).includes('<div id="root">'), "index.html without #root");
});
await check("SPA fallback for deep links", async () => {
  const r = await get("/some/deep/link");
  assert(r.status === 200, `status ${r.status}`);
});
await check("sign-in is configured", async () => {
  const j = await (await get("/api/auth/config")).json();
  assert(j.enabled === true && j.clientId, `got ${JSON.stringify(j)}`);
});
await check("chat requires sign-in", async () => {
  const r = await post("/api/chat", { question: "test" });
  assert(r.status === 401, `status ${r.status}`);
});
await check("junk Google credential is rejected", async () => {
  const r = await post("/api/auth/google", { credential: "not-a-token" });
  assert(r.status === 401, `status ${r.status}`);
});

if (withSession) {
  const secret = process.env.SMOKE_SESSION_SECRET;
  const email = process.env.SMOKE_EMAIL ?? "smoke@example.com";
  assert(secret, "SMOKE_SESSION_SECRET is not set");
  const body = Buffer.from(JSON.stringify({ sub: "smoke", email, name: "Smoke test", exp: Math.floor(Date.now() / 1000) + 600 })).toString("base64url");
  const mac = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const cookie = { cookie: `kal_session=${encodeURIComponent(`${body}.${mac}`)}` };

  await check("backend is ready (/api/info)", async () => {
    const j = await (await get("/api/info", cookie)).json();
    assert(j.ok === true, `got ${JSON.stringify(j)}`);
  });
  await check("answers a question with a citation in < 30 s", async () => {
    const t0 = Date.now();
    const r = await post("/api/chat", { question: "How much partner leave do UK employees get?" }, cookie);
    assert(r.status === 200, `status ${r.status}`);
    const events = (await r.text()).trim().split("\n").map((l) => JSON.parse(l));
    const err = events.find((e) => e.type === "error");
    assert(!err, `error event: ${err?.message}`);
    const done = events.find((e) => e.type === "done");
    assert(done, "no done event");
    assert(/\[KAL-GB-HR-01\d/.test(done.answer), `no UK citation in: ${done.answer.slice(0, 200)}`);
    assert(Date.now() - t0 < 30_000, `took ${Date.now() - t0} ms`);
  });
}

console.log(failed ? `\n${failed} check(s) failed` : "\nAll checks passed");
process.exit(failed ? 1 : 0);
