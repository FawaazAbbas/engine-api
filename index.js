import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";
import crypto from "crypto";

const app = express();
app.use(express.static('.'));
app.use(bodyParser.json());

// CORS
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// -------- config --------
const MEILI_URL = process.env.MEILI_URL || "http://localhost:7700";
const MEILI_KEY = process.env.MEILI_KEY || "supersecret";
const authHeaders = { Authorization: `Bearer ${MEILI_KEY}`, "Content-Type": "application/json" };

// -------- helpers --------
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const safeId = (url) => "u_" + sha1(url);
const domainFrom = (u) => { try { return new URL(u).hostname; } catch { return ""; } };
const tldFrom = (u) => { const d = domainFrom(u).split("."); return d.length > 1 ? d.at(-1) : ""; };
const countryFromTld = (tld) => {
  const map = { uk:"UK", us:"US", ae:"AE", de:"DE", fr:"FR", it:"IT", es:"ES" };
  return map[(tld||"").toLowerCase()] || "UNSPEC";
};

// build meili filter string from query params
function buildFilters(qs) {
  const f = [];
  if (qs.lang)    f.push(`lang = "${qs.lang}"`);
  if (qs.country) f.push(`country_hint = "${qs.country}"`);
  if (qs.tld)     f.push(`tld = "${qs.tld}"`);
  if (qs.after)   f.push(`last_modified >= ${JSON.stringify(qs.after)}`);
  return f.length ? f.join(" AND ") : undefined;
}

// -------- routes --------

// health proxy (quick sanity)
app.get("/health", async (_req, res) => {
  try {
    const r = await fetch(`${MEILI_URL}/health`, { headers: { Authorization: `Bearer ${MEILI_KEY}` } });
    const j = await r.json();
    res.json({ meili: j.status || "unknown" });
  } catch {
    res.status(500).json({ meili: "down" });
  }
});

app.get("/search", async (req, res) => {
  const { q = "", k = "10" } = req.query;
  if (!q) {
    res.set("X-Engine-Message", "Provide q.");
    return res.json([]); // spec: return [] with a friendly note
  }
  const filter = buildFilters(req.query);

  const r = await fetch(`${MEILI_URL}/indexes/pages/search`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      q,
      filter,
      limit: Math.min(parseInt(k, 10) || 10, 50),
      sort: req.query.after ? ["last_modified:desc"] : undefined
    }),
  });

  const data = await r.json().catch(() => ({}));
  const results = (data.hits || []).map(h => ({
    url: h.url,
    title: h.title || h.domain || h.url,
    snippet: (h.meta_desc || h.text || "").slice(0, 280),
    lang: h.lang,
    country_hint: h.country_hint,
    last_modified: h.last_modified,
    crawl_id: h.crawl_id,
    score: h._rankingScore ?? 0
  }));
  res.json(results);
});

// polite live submit: robots check + single backoff on 429/503
app.post("/submit", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ status: "error", reason: "missing_url" });

  try {
    const u = new URL(url);
    // robots.txt (very light)
    const robotsTxt = await fetch(`${u.origin}/robots.txt`).then(r => r.ok ? r.text() : "").catch(() => "");
    const disallowAll = robotsTxt.split("\n").some(l => l.trim().toLowerCase() === "disallow: /");
    if (disallowAll) return res.json({ status: "skipped", reason: "blocked" });

    // polite fetch
    const UA = "EngineBot/0.1 (+https://example.com/bot)";
    let resp = await fetch(url, { headers: { "User-Agent": UA } });
    if ([429, 503].includes(resp.status)) {
      await new Promise(r => setTimeout(r, 1500));
      resp = await fetch(url, { headers: { "User-Agent": UA } });
      if ([429, 503].includes(resp.status))
        return res.status(429).json({ status: "error", reason: "rate_limited" });
    }
    if (!resp.ok) return res.status(400).json({ status: "error", reason: `http_${resp.status}` });

    const html = await resp.text();

    // tiny parse
    const title = (html.match(/<title[^>]*>([^<]{0,200})<\/title>/i) || [,""])[1];
    const meta  = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,300})/i) || [,""])[1];
    const text  = html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi," ")
      .replace(/<[^>]+>/g," ")
      .replace(/\s+/g," ")
      .trim();

    const word_count = text ? text.split(/\s+/).length : 0;
    if (word_count < 30) return res.json({ status: "skipped", reason: "too_short" });

    const id = safeId(url);
    const domain = u.hostname;
    const tld = tldFrom(url);
    const doc = {
      id, url,
      title: title || url,
      meta_desc: meta,
      text,
      lang: "en", // (keep simple for now)
      word_count,
      last_modified: new Date().toISOString(),
      crawl_id: "USER",
      domain, tld,
      country_hint: countryFromTld(tld),
      source: "user-submit"
    };

    const up = await fetch(`${MEILI_URL}/indexes/pages/documents`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify([doc]),
    });

    if (!up.ok) {
      const body = await up.text().catch(() => "");
      return res.status(500).json({ status: "error", reason: "index_failed", meili_status: up.status, meili_body: body });
    }
    res.json({ status: "ok", url });
  } catch (e) {
    res.status(500).json({ status: "error", reason: "exception" });
  }
});

app.listen(8080, () => console.log("API running on 8080"));
