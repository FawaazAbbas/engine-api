import express from "express";
import fetch from "node-fetch";
import bodyParser from "body-parser";

const app = express();
app.use(bodyParser.json());

const MEILI_URL = process.env.MEILI_URL;
const MEILI_KEY = process.env.MEILI_KEY;

app.get("/search", async (req, res) => {
  const { q = "", k = "10" } = req.query;
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
