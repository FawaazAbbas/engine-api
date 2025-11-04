import fetch from "node-fetch";
import crypto from "crypto";
import { URL } from "url";
import * as cheerio from "cheerio";

const MEILI_URL = process.env.MEILI_URL || "http://localhost:7700";
const MEILI_KEY = process.env.MEILI_KEY || "supersecret";
const authHeaders = { Authorization:`Bearer ${MEILI_KEY}`, "Content-Type":"application/json" };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha1 = s => crypto.createHash("sha1").update(s).digest("hex");

export async function crawl(seed, {maxPages=25, maxDepth=1}={}) {
  const seen = new Set();
  const queue = [{url: seed, depth:0}];
  const domain = new URL(seed).hostname;

  console.log(`🌐 Starting crawl for ${seed}`);

  while(queue.length && seen.size < maxPages){
    const {url, depth} = queue.shift();
    if(seen.has(url)) continue;
    seen.add(url);

    try{
      const res = await fetch(url, {headers:{'User-Agent':'EngineBot/0.1'}});
      if(!res.ok || !res.headers.get("content-type")?.includes("text/html")) continue;

      const html = await res.text();
      const $ = cheerio.load(html);
      const title = $("title").text().slice(0,200);
      const meta = $('meta[name="description"]').attr("content") || "";
      const text = $("body").text().replace(/\s+/g," ").trim();
      const wc = text.split(" ").length;

      const doc = {
        id:"u_"+sha1(url),
        url,title,meta_desc:meta,text,
        word_count:wc,lang:"en",
        last_modified:new Date().toISOString(),
        crawl_id:"LIVE",domain,
        tld:domain.split(".").pop(),
        country_hint:"UNSPEC",source:"live-crawl"
      };

      await fetch(`${MEILI_URL}/indexes/pages/documents`,{
        method:"POST",headers:authHeaders,body:JSON.stringify([doc])
      });

      console.log(`Indexed: ${url}`);

      if(depth<maxDepth){
        $("a[href]").each((_,a)=>{
          const href=$(a).attr("href");
          if(!href) return;
          try{
            const u=new URL(href, url);
            if(u.hostname===domain && !seen.has(u.href) && u.protocol.startsWith("http"))
              queue.push({url:u.href,depth:depth+1});
          }catch{}
        });
      }
      await sleep(1000); // polite delay
    }catch(e){
      console.error("Failed:",url,e.message);
    }
  }
  console.log(`✅ Crawl done. Indexed ${seen.size} pages.`);
}
