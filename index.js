import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";
import crypto from "crypto";

const app = express();
// parse JSON bodies for all incoming requests
app.use(bodyParser.json());

/* ---------- config ---------- */
// Environment variables are read from process.env. These can be set at deploy time.
// PUBLIC_KEY is an optional API key. If defined, all calls to /search and /submit must include ?key=PUBLIC_KEY
const PUBLIC_KEY = process.env.PUBLIC_KEY || "";
// ALLOW_ORIGIN controls which origin may access this API via CORS. If not set, all origins are allowed.
const MEILI_URL = process.env.MEILI_URL;
const MEILI_KEY = process.env.MEILI_KEY;
const SUBMIT_LIMIT = Number(process.env.SUBMIT_PER_MIN || 6);

/* ---------- CORS + security ---------- */
// Always set CORS headers for every request. Cloud Run will forward these to the client unchanged.
// This middleware is registered before any other handlers so that preflight checks succeed.
app.set("trust proxy", true); // respect x-forwarded-for for rate limiting
app.use((req, res, next) => {
  // Pull the allowed origin from the environment on each request. If unset, default to '*'.
  const origin = process.env.ALLOW_ORIGIN || "*";
  res.set({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    // Explicitly vary on Origin so caches do not serve the wrong CORS header.
    Vary: "Origin",
  });
  // Reply immediately to OPTIONS preflight requests
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

/* ---------- tiny token-bucket per IP for /submit ---------- */
// Simple rate limiting: Each IP gets SUBMIT_LIMIT tokens per minute.
const buckets = new Map(); // ip → { tokens, ts }
function allow(ip) {
  const now = Date.now();
  const b = buckets.get(ip) || { tokens: SUBMIT_LIMIT, ts: now };
  const deltaMin = (now - b.ts) / 60000;
  // refill tokens proportional to elapsed minutes
  b.tokens = Math.min(SUBMIT_LIMIT, b.tokens + deltaMin * SUBMIT_LIMIT);
  b.ts = now;
  if (b.tokens < 1) {
    buckets.set(ip, b);
    return false;
  }
  b.tokens -= 1;
  buckets.set(ip, b);
  return true;
}

/* ---------- API-key gate ---------- */
// Require the correct key for all routes except the root and health checks.
app.use((req, res, next) => {
  if (req.path === "/" || req.path === "/_ah/health" || req.path === "/health") return next();
  // If no PUBLIC_KEY is defined or the query param matches, allow.
  if (!PUBLIC_KEY || req.query.key === PUBLIC_KEY) return next();
  return res.status(401).json({ error: "missing_or_bad_key" });
});

/* ---------- cache helper ---------- */
function setCache(res, s = 60, smax = 300) {
  res.set("Cache-Control", `public, max-age=${s}, s-maxage=${smax}`);
}

/* ---------- lightweight page fetcher (for /submit) ---------- */
async function fetchPageText(url) {
  try {
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) return { title: "", text: "" };
    const html = await r.text();

    // extract <title>
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch
      ? titleMatch[1].trim().replace(/\s+/g, " ").slice(0, 200)
      : "";

    // strip scripts/styles/tags → plaintext
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/\s+/g, " ")
      .trim();

    // cap to keep docs small
    const text = cleaned.slice(0, 8000);
    return { title, text };
  } catch {
    return { title: "", text: "" };
  }
}

/* ---------- /search ---------- */
app.get("/search", async (req, res) => {
  const { q = "", k = "10" } = req.query;
  if (!q) return res.json({ results: [], message: "Provide q." });

  setCache(res);
  const r = await fetch(`${MEILI_URL}/indexes/pages/search`, {
    method: "POST",
    headers: {
      // MeiliSearch v0.24 and older require this header. Later versions accept Bearer but this header works on all versions.
      "X-Meili-API-Key": MEILI_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q, limit: Number(k) }),
  });

  const data = await r.json().catch(() => ({}));
  const results = (data.hits || []).map((h) => ({
    url: h.url,
    title: h.title || h.domain,
    snippet: (h.text || "").slice(0, 200),
  }));
  res.json(results);
});

/* ---------- /submit ---------- */
app.post("/submit", async (req, res) => {
  // Determine the client IP for rate limiting. x-forwarded-for may contain multiple addresses.
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0] || req.ip || "na";
  if (!allow(ip))
    return res.status(429).json({ status: "error", reason: "rate_limited" });

  const { url } = req.body || {};
  if (!url)
    return res.status(400).json({ status: "error", reason: "missing_url" });

  // deterministic id
  const id = crypto.createHash("sha1").update(url).digest("hex");

  // fetch page to get title + text so search can show snippets
  const { title, text } = await fetchPageText(url);

  const doc = {
    id,
    url,
    title: title || url,
    text,
    source: "user-submit",
    lang: "",
    city: "",
  };

  const r = await fetch(`${MEILI_URL}/indexes/pages/documents`, {
    method: "POST",
    headers: {
      "X-Meili-API-Key": MEILI_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify([doc]),
  });

  if (!r.ok) {
    const body = await r.text().catch(() => "");
    return res.status(500).json({
      status: "error",
      reason: "index_failed",
      meili_status: r.status,
      meili_body: body,
    });
  }
  res.json({ status: "ok", url });
});

/* ---------- health (optional) ---------- */
app.get("/health", (req, res) => res.json({ ok: true }));

/* ---------- start ---------- */
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`API running on ${port}`));
