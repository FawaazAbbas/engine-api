import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());




// --- security & perf middleware ---
const PUBLIC_KEY = process.env.PUBLIC_KEY || "";        // set in Cloud Run
const ORIGIN = process.env.ALLOW_ORIGIN || "*";         // your Netlify URL later

app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});




// Very small in-memory token bucket per IP (resets when instance restarts)
const buckets = new Map(); // ip -> { tokens, ts }
const LIMIT = Number(process.env.SUBMIT_PER_MIN || 6); // 6/min/IP

function allow(ip) {
  const now = Date.now();
  const b = buckets.get(ip) || { tokens: LIMIT, ts: now };
  const elapsedMin = (now - b.ts) / 60000;
  b.tokens = Math.min(LIMIT, b.tokens + elapsedMin * LIMIT);
  b.ts = now;
  if (b.tokens < 1) { buckets.set(ip, b); return false; }
  b.tokens -= 1; buckets.set(ip, b); return true;
}



const ip = (req.headers["x-forwarded-for"] || "").split(",")[0] || req.ip || "na";
if (!allow(ip)) return res.status(429).json({ status: "error", reason: "rate_limited" });



// Require ?key= on /search and /submit
app.use((req, res, next) => {
  // allow health checks
  if (req.path === "/" || req.path === "/_ah/health") return next();
  if (!PUBLIC_KEY) return next();
  if (req.query.key === PUBLIC_KEY) return next();
  return res.status(401).json({ error: "missing_or_bad_key" });
});

// 60s browser cache, 300s CDN/proxy cache
function setCache(res, seconds = 60, smax = 300) {
  res.set("Cache-Control", `public, max-age=${seconds}, s-maxage=${smax}`);
}





const MEILI_URL = process.env.MEILI_URL;
const MEILI_KEY = process.env.MEILI_KEY;

app.get("/search", async (req, res) => {
  const { q = "", k = "10" } = req.query;


  
  setCache(res, 60, 300);   // 60s browser, 300s CDN




  if (!q) return res.json({ results: [], message: "Provide q." });
  const body = { q, limit: Number(k) };
  const r = await fetch(`${MEILI_URL}/indexes/pages/search`, {
    method: "POST",
    headers: { "X-Meili-API-Key": MEILI_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  const results = (data.hits || []).map(h => ({
    url: h.url,
    title: h.title || h.domain,
    snippet: (h.text || "").slice(0, 200),
  }));
  res.json(results);
});

app.listen(8080, () => console.log("API running on 8080"));
