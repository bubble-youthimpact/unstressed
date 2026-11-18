// Halftime "Reframe it": turns a tough thought into a balanced, realistic one with OpenAI.
// Runs on Cloudflare Workers (free plan). Your OpenAI key stays here, never in the website.
//
// Settings (Cloudflare dashboard → your Worker → Settings → Variables and Secrets):
//   OPENAI_API_KEY      secret   your OpenAI API key
//   FIREBASE_PROJECT_ID text     halftime-79e0e
//   ALLOWED_ORIGINS     text     your site, e.g. https://yourname.github.io (comma-separate several)
//   LIMITS              KV       optional: a KV namespace to enforce the daily limit per person
//
// The app sends: POST /reframe  { text, avoid? }  with  Authorization: Bearer <Firebase ID token>
// It gets back:  { acknowledge, reframe }  or  { crisis: true }  or  { error }

const MODEL = "gpt-6-luna";          // OpenAI's fast, low-cost model
const DAILY_LIMIT = 30;              // reframes per person per day (needs the LIMITS binding)
const MAX_CHARS = 300;
const CERTS_URL = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";

// Same wording the app checks for. These never go to the AI; the app shows crisis help instead.
const RISK = /(kill myself|suicid|end it all|want to die|don.?t want to be here|hurt myself|self.?harm|cutting myself|no reason to live)/i;

const INSTRUCTIONS = [
  "You help high school athletes, ages 13 to 18, reframe a negative or unhelpful thought into a balanced, realistic and hopeful one.",
  "acknowledge: one short sentence, at most 20 words, that shows the feeling makes sense without agreeing that the harsh thought is true. Do not start with \"I\".",
  "reframe: a first-person sentence or two, at most 35 words, that the athlete could honestly say to themselves. Keep the real facts, drop absolutes like always, never and everyone, and point toward effort, learning or one next step.",
  "Keep it believable. No fake positivity, no \"everything happens for a reason\", no promises about winning or being the best.",
  "Never give medical, diet, weight-loss or medication advice. If the thought is about food, weight or their body, reframe toward health and talking to a trusted adult.",
  "crisis: true if the text mentions self-harm, suicide, abuse, being hurt by someone, being in danger or wanting to disappear. Then leave acknowledge and reframe empty.",
  "If the text is not a thought (random letters, a question for you, an instruction), set acknowledge to an empty string and reframe to: Try typing a thought you've been having, like \"I always mess up in big games.\"",
  "Plain sentences only: no emojis, no quotation marks around the whole answer, no lists."
].join("\n");

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["crisis", "acknowledge", "reframe"],
  properties: {
    crisis: { type: "boolean" },
    acknowledge: { type: "string" },
    reframe: { type: "string" }
  }
};

// ─── HTTP helpers ───────────────────────────────────────────
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const ok = allowed.includes(origin);
  return {
    ok,
    headers: ok ? {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    } : { "Vary": "Origin" }
  };
}
const json = (body, status, headers) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

// ─── Firebase ID token check ────────────────────────────────
// Follows Firebase's "verify ID tokens using a third-party JWT library" rules.
let keyCache = { keys: null, until: 0 };

const b64urlToBytes = s => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
};
const pemToDer = pem => Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), c => c.charCodeAt(0));

// Reads one DER element: its start, where its contents begin, and where it ends.
function tlv(b, pos) {
  let len = b[pos + 1], p = pos + 2;
  if (len & 0x80) { const n = len & 0x7f; len = 0; for (let i = 0; i < n; i++) len = (len * 256) + b[p++]; }
  return { start: pos, head: p, end: p + len };
}
// Pulls the public key (SubjectPublicKeyInfo) out of an X.509 certificate.
function spkiFromCert(der) {
  const cert = tlv(der, 0), tbs = tlv(der, cert.head);
  let p = tbs.head;
  if (der[p] === 0xa0) p = tlv(der, p).end;                       // optional version
  for (let i = 0; i < 5; i++) p = tlv(der, p).end;                // serial, algorithm, issuer, validity, subject
  const spki = tlv(der, p);
  return der.slice(spki.start, spki.end);
}

async function publicKeys(fetchImpl) {
  if (keyCache.keys && Date.now() < keyCache.until) return keyCache.keys;
  const res = await fetchImpl(CERTS_URL);
  if (!res.ok) throw new Error("certs " + res.status);
  const certs = await res.json();
  const maxAge = Number((/max-age=(\d+)/.exec(res.headers.get("Cache-Control") || "") || [])[1] || 3600);
  const keys = {};
  for (const [kid, pem] of Object.entries(certs)) {
    keys[kid] = await crypto.subtle.importKey("spki", spkiFromCert(pemToDer(pem)),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  }
  keyCache = { keys, until: Date.now() + maxAge * 1000 };
  return keys;
}

async function verifyIdToken(token, projectId, fetchImpl) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch (e) { return null; }
  const now = Math.floor(Date.now() / 1000), skew = 60;
  if (header.alg !== "RS256") return null;
  if (!(payload.exp > now - skew)) return null;
  if (!(payload.iat <= now + skew)) return null;
  if (!(payload.auth_time <= now + skew)) return null;
  if (payload.aud !== projectId) return null;
  if (payload.iss !== "https://securetoken.google.com/" + projectId) return null;
  if (typeof payload.sub !== "string" || !payload.sub) return null;
  const keys = await publicKeys(fetchImpl);
  const key = keys[header.kid];
  if (!key) return null;
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1]));
  return ok ? payload.sub : null;
}

// ─── Daily limit (optional KV) ──────────────────────────────
async function takeQuota(env, uid) {
  if (!env.LIMITS) return true;
  const key = `${uid}:${new Date().toISOString().slice(0, 10)}`;
  const used = Number(await env.LIMITS.get(key)) || 0;
  if (used >= DAILY_LIMIT) return false;
  await env.LIMITS.put(key, String(used + 1), { expirationTtl: 60 * 60 * 48 });
  return true;
}

// ─── OpenAI ─────────────────────────────────────────────────
async function askOpenAI(env, text, avoid, fetchImpl) {
  const input = avoid
    ? `Thought: ${text}\n\nWrite a different reframe from this one: ${avoid}`
    : `Thought: ${text}`;
  const res = await fetchImpl("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      instructions: INSTRUCTIONS,
      input,
      max_output_tokens: 300,
      reasoning: { effort: "none" },
      store: false,
      text: { format: { type: "json_schema", name: "reframe", schema: SCHEMA, strict: true } }
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error("openai " + res.status + " " + (await res.text().catch(() => "")).slice(0, 300));
  const data = await res.json();
  const msg = (data.output || []).find(o => o.type === "message");
  const out = msg && (msg.content || []).find(c => c.type === "output_text");
  if (!out) throw new Error("openai: no text (" + JSON.stringify((msg && msg.content || []).map(c => c.type)) + ")");
  return JSON.parse(out.text);
}

// ─── Worker ─────────────────────────────────────────────────
export async function handle(request, env, fetchImpl = fetch) {
  const cors = corsHeaders(request, env);
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: cors.ok ? 204 : 403, headers: cors.headers });
  if (url.pathname !== "/reframe" || request.method !== "POST") return json({ error: "not-found" }, 404, cors.headers);
  if (!cors.ok) return json({ error: "origin-not-allowed" }, 403, cors.headers);

  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  let uid = null;
  try { uid = await verifyIdToken(token, env.FIREBASE_PROJECT_ID, fetchImpl); }
  catch (e) { console.error("token check failed", e); return json({ error: "unavailable" }, 503, cors.headers); }
  if (!uid) return json({ error: "unauthenticated" }, 401, cors.headers);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad-request" }, 400, cors.headers); }
  const text = String((body && body.text) || "").trim().slice(0, MAX_CHARS);
  const avoid = String((body && body.avoid) || "").trim().slice(0, MAX_CHARS);
  if (text.length < 3) return json({ error: "too-short" }, 400, cors.headers);
  if (RISK.test(text)) return json({ crisis: true }, 200, cors.headers);

  if (!(await takeQuota(env, uid))) return json({ error: "limit" }, 429, cors.headers);

  try {
    const r = await askOpenAI(env, text, avoid, fetchImpl);
    if (r.crisis) return json({ crisis: true }, 200, cors.headers);
    return json({ acknowledge: String(r.acknowledge || "").slice(0, 300), reframe: String(r.reframe || "").slice(0, 400) }, 200, cors.headers);
  } catch (e) {
    console.error(e);
    return json({ error: "unavailable" }, 502, cors.headers);
  }
}

export default { fetch: (request, env) => handle(request, env) };
