import express from "express";
import fetch   from "node-fetch";
import bodyParser from "body-parser";
import crypto  from "crypto";          // ← NEW

const app = express();
app.use(bodyParser.json());

/* ---------- config ---------- */
const PUBLIC_KEY   = process.env.PUBLIC_KEY  || "";
const ORIGIN       = process.env.ALLOW_ORIGIN || "*";
const MEILI_URL    = process.env.MEILI_URL;
const MEILI_KEY    = process.env.MEILI_KEY;
const SUBMIT_LIMIT = Number(process.env.SUBMIT_PER_MIN || 6);

/* ---------- CORS + security ---------- */
app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

/* ---------- tiny token-bucket per IP for /submit ---------- */
const buckets = new Map();                       // ip → { tokens, ts }
function allow(ip){
  const now = Date.now();
  const b   = buckets.get(ip) || { tokens: SUBMIT_LIMIT, ts: now };
  const deltaMin = (now - b.ts) / 60000;
  b.tokens = Math.min(SUBMIT_LIMIT, b.tokens + deltaMin * SUBMIT_LIMIT);
  b.ts = now;
  if (b.tokens < 1){ buckets.set(ip,b); return false; }
  b.tokens -= 1; buckets.set(ip,b); return true;
}

/* ---------- API-key gate ---------- */
app.use((req,res,next)=>{
  if (req.path === "/" || req.path === "/_ah/health") return next();
  if (!PUBLIC_KEY || req.query.key === PUBLIC_KEY)   return next();
  return res.status(401).json({ error:"missing_or_bad_key" });
});

/* ---------- cache helper ---------- */
function setCache(res, s=60, smax=300){
  res.set("Cache-Control",`public, max-age=${s}, s-maxage=${smax}`);
}

/* ---------- /search ---------- */
app.get("/search", async (req,res)=>{
  const { q="", k="10" } = req.query;
  if (!q) return res.json({ results:[], message:"Provide q." });

  setCache(res);
  const r = await fetch(`${MEILI_URL}/indexes/pages/search`,{
    method:"POST",
    headers:{ "X-Meili-API-Key":MEILI_KEY,"Content-Type":"application/json" },
    body: JSON.stringify({ q, limit:Number(k) }),
  });
  const data = await r.json();
  const results = (data.hits||[]).map(h=>({
    url: h.url,
    title: h.title || h.domain,
    snippet: (h.text||"").slice(0,200),
  }));
  res.json(results);
});

/* ---------- /submit ---------- */
app.post("/submit", async (req,res)=>{
  const ip = (req.headers["x-forwarded-for"]||"").split(",")[0] || req.ip || "na";
  if (!allow(ip)) return res.status(429).json({ status:"error", reason:"rate_limited" });

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ status:"error", reason:"missing_url" });

  // NEW – safe deterministic id
  const id = crypto.createHash("sha1").update(url).digest("hex");

  const doc = {
    id,
    url,
    title: url,
    text: "",
    source: "user-submit",
    lang: "",
    city: ""
  };

  const r = await fetch(`${MEILI_URL}/indexes/pages/documents`,{
    method:"POST",
    headers:{ "X-Meili-API-Key":MEILI_KEY,"Content-Type":"application/json" },
    body: JSON.stringify([doc])
  });
  if (!r.ok){
    const text = await r.text().catch(()=> "");
    return res.status(500).json({ status:"error", reason:"index_failed", meili_status:r.status, meili_body:text });
  }
  res.json({ status:"ok", url });
});

/* ---------- start ---------- */
app.listen(8080, ()=> console.log("API running on 8080"));
