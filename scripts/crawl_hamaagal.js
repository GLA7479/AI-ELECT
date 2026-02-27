// scripts/crawl_hamaagal.js
const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");
const { chromium } = require("playwright");

const BASE = "https://iec-hamaagal.co.il";

function uniq(arr) {
  return Array.from(new Set(arr));
}

function normalizeUrl(u) {
  try {
    // allow relative
    if (u.startsWith("/")) return BASE + u;
    if (!u.startsWith("http")) return new URL(u, BASE).toString();
    return u;
  } catch {
    return null;
  }
}

async function fetchHtml(url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ locale: "he-IL" });

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

    // Scroll a bit to load lazy parts
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 1400);
      await page.waitForTimeout(700);
    }

    return await page.content();
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function extractInternalLinks(html) {
  const $ = cheerio.load(html);
  const links = [];

  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    if (!href) return;

    const u = normalizeUrl(href);
    if (!u) return;

    // keep only internal
    if (u.startsWith(BASE + "/")) links.push(u);
  });

  return uniq(links);
}

function toSources(urls) {
  return urls.map((url) => {
    const slug = url.replace(BASE + "/", "").trim() || "home";
    const title = `המעגל – ${decodeURIComponent(slug)}`;
    return {
      title,
      url,
      publisher: "iec-hamaagal",
      doc_type: "utility_guideline",
    };
  });
}

async function main() {
  // You can add more seed pages here if you want broader crawl
  const seeds = [
    `${BASE}/information_library_menu`,
    `${BASE}/main_menu`,
  ];

  console.log("[crawl] Fetching seed pages...");
  const allLinks = [];

  for (const s of seeds) {
    console.log("[crawl] seed:", s);
    const html = await fetchHtml(s);
    const links = extractInternalLinks(html);
    console.log(`[crawl] found ${links.length} links from seed`);
    allLinks.push(...links);
  }

  const urls = uniq(allLinks)
    // remove obvious non-content endpoints if any
    .filter((u) => !u.includes("/api/"))
    .filter((u) => !u.includes("javascript:"))
    .slice(0, 250); // safety cap for first run

  console.log("[crawl] total unique internal URLs:", urls.length);

  const sources = toSources(urls);

  const outPath = path.join(process.cwd(), "scripts", "sources.utility.auto.json");
  fs.writeFileSync(outPath, JSON.stringify(sources, null, 2), "utf8");
  console.log("[crawl] wrote:", outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
