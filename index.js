cat > index.js <<'EOF'
import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";
import crypto from "crypto";

const app = express();
app.use(bodyParser.json());

// CORS
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

const MEILI_URL = process.env.MEILI_URL;
const MEILI_KEY = process.env.MEILI_KEY;
const authHeaders = { Authorization: `Bearer ${MEILI_KEY}`, "Content-Type": "application/json" };

app.get("/search", async (req, res) => {
  const { q = "", k = "10" } = req.query;
  if (!q) return res.json({ results: [], message: "Provide q." });
  const r = await fetch(`${MEILI_URL}/indexes/pages/search`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ q, limit: Number(k) }),
  });
  const data = await r.json().catch(() => ({}));
  const results = (data.hits || []).map(h => ({
    url: h.url, title: h.title || h.domain || h.url, snippet: (h.text || "").slice(0, 200),
  }));
  res.json(results);
});

app.post("/submit", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ status: "error", reason: "missing_url" });
  const id = "u_" + crypto.createHash("sha1").update(url).digest("hex");
  const doc = { id, url, title: url, text: "", source: "user-submit", lang: "", city: "" };

  const r = await fetch(`${MEILI_URL}/indexes/pages/documents`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify([doc]),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    return res.status(500).json({ status: "error", reason: "index_failed", meili_status: r.status, meili_body: text });
  }
  res.json({ status: "ok", url });
});

app.listen(8080, () => console.log("API running on 8080"));
EOF
