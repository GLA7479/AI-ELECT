// scripts/ingest.js
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dotenv = require("dotenv");
const cheerio = require("cheerio");
const pdfParse = require("pdf-parse");
console.log("[ingest] pdfParse typeof:", typeof pdfParse);
const mammoth = require("mammoth");
const { chromium } = require("playwright");
const { createClient } = require("@supabase/supabase-js");

dotenv.config({ path: path.join(process.cwd(), ".env.ingest") });

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL in .env.ingest");
if (!SUPABASE_SERVICE_ROLE_KEY)
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY in .env.ingest");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const INGEST_VISITED_URLS = new Set();

function walkFilesRecursive(dirPath) {
  const out = [];
  const items = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const it of items) {
    const p = path.join(dirPath, it.name);
    if (it.isDirectory()) out.push(...walkFilesRecursive(p));
    else out.push(p);
  }
  return out;
}

function inferLocalPdfMeta(filePath) {
  const lower = path.basename(filePath).toLowerCase();
  if (lower.includes("חוק-החשמל") || lower.includes("law")) {
    return { publisher: "official_local_pdf", doc_type: "law_pdf" };
  }
  if (
    lower.includes("minhal_hashmal") ||
    lower.includes("pics_minhal_hashmal") ||
    lower.includes("files_minhal_hashmal")
  ) {
    // Boost priority for earthing/grounding related files
    if (
      lower.includes("adama") ||
      lower.includes("הארק") ||
      lower.includes("earthing") ||
      lower.includes("grounding") ||
      lower.includes("14")
    ) {
      return { publisher: "minhal-hashmal", doc_type: "regulation_pdf" };
    }
    return { publisher: "minhal-hashmal", doc_type: "regulation_pdf" };
  }
  if (lower.includes("licensure")) {
    return { publisher: "minhal-hashmal", doc_type: "regulation_pdf" };
  }
  // Check for earthing-related keywords in any PDF
  if (
    lower.includes("הארק") ||
    lower.includes("adama") ||
    lower.includes("earthing") ||
    lower.includes("grounding")
  ) {
    return { publisher: "minhal-hashmal", doc_type: "regulation_pdf" };
  }
  return { publisher: "official_local_pdf", doc_type: "regulation_pdf" };
}

function buildSourcesFromLocalPdfDir(pdfDir) {
  const absDir = path.isAbsolute(pdfDir)
    ? pdfDir
    : path.join(process.cwd(), pdfDir);
  if (!fs.existsSync(absDir)) {
    throw new Error(`PDF_DIR not found: ${absDir}`);
  }

  const files = walkFilesRecursive(absDir).filter((f) =>
    f.toLowerCase().endsWith(".pdf")
  );
  const cwd = process.cwd();
  const seen = new Set();
  const sources = [];

  for (const file of files) {
    const rel = path.relative(cwd, file).replace(/\\/g, "/");
    const fileUrl = `file:${rel}`;
    if (seen.has(fileUrl)) continue;
    seen.add(fileUrl);

    const base = path.basename(file, path.extname(file));
    const meta = inferLocalPdfMeta(file);
    sources.push({
      title: base,
      url: fileUrl,
      publisher: meta.publisher,
      doc_type: meta.doc_type,
    });
  }

  return sources;
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function normalizeText(s) {
  return (s || "")
    .replace(/\r/g, "")
    // fix hyphen line-breaks (e.g., "האר-\nקה" -> "הארקה")
    .replace(/-\n([א-תA-Za-z])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function chunkText(text, opts = {}) {
  const maxChars = opts.maxChars || 1200;
  const overlap = opts.overlap || 150;

  const t = normalizeText(text);
  if (!t) return [];

  const chunks = [];
  let i = 0;
  while (i < t.length) {
    const end = Math.min(i + maxChars, t.length);
    chunks.push(t.slice(i, end).trim());
    if (end >= t.length) break;
    i = Math.max(0, end - overlap);
  }
  return chunks.filter(Boolean);
}

function guessSection(chunkText) {
  const t = (chunkText || "").slice(0, 600);

  // Examples: "סעיף 3", "סעיף 3א", "סעיף 2 (א)", "סעיף קטן (א)"
  const m1 = t.match(/(סעיף\s+(?:קטן\s+)?\d+[א-ת]?(?:\s*\([א-ת]\))?)\b/);
  if (m1) return m1[1].trim();

  // "תקנה 2", "תקנה 2 (א)", "תקנה 16."
  const m2 = t.match(/(תקנה\s+\d{1,3}(?:\s*\([א-ת]\))?\.?)\b/);
  if (m2) return m2[1].trim();

  // Regulation numbering like "16." or "16. (א)" at start of line
  const m3 = t.match(/^\s*(\d{1,3})\.\s*(\([א-ת]\))?/m);
  if (m3) return `תקנה ${m3[1]}${m3[2] ? " " + m3[2] : ""}`;

  // "פרק א", "פרק ב"
  const m4 = t.match(/(פרק\s+[א-ת]+)\b/);
  if (m4) return m4[1];

  // "תוספת א", "תוספת ב"
  const m5 = t.match(/(תוספת\s+[א-ת]+)\b/);
  if (m5) return m5[1];

  // "הגדרות"
  const m6 = t.match(/\b(הגדרות)\b/);
  if (m6) return "הגדרות";

  // "תת-סעיף", "תת-תקנה"
  const m7 = t.match(/(תת[-־]?(?:סעיף|תקנה)\s+\d+[א-ת]?(?:\s*\([א-ת]\))?)\b/);
  if (m7) return m7[1].trim();

  return null;
}

function isPdfUrl(url) {
  return url.toLowerCase().includes(".pdf");
}

function isFileUrl(url) {
  return typeof url === "string" && url.startsWith("file:");
}

function localPathFromFileUrl(fileUrl) {
  const raw = fileUrl.replace(/^file:/, "").trim();
  // Support both absolute and relative paths
  return path.isAbsolute(raw) ? raw : path.join(process.cwd(), raw);
}

async function extractTextFromLocalFile(fileUrl) {
  const absPath = localPathFromFileUrl(fileUrl);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Local file not found: ${absPath}`);
  }

  const ext = path.extname(absPath).toLowerCase();
  const buf = fs.readFileSync(absPath);

  if (ext === ".pdf") {
    const data = await pdfParse(buf);
    return { text: normalizeText(data.text || ""), used: "local-pdf", fileUrl };
  }

  if (ext === ".docx" || ext === ".doc") {
    try {
      const result = await mammoth.extractRawText({ buffer: buf });
      return {
        text: normalizeText(result.value || ""),
        used: "local-docx",
        fileUrl,
      };
    } catch (err) {
      // fallback for old .doc
      const text = await extractTextFromOldDocViaLibreOffice(fileUrl, buf);
      return { text, used: "local-doc", fileUrl };
    }
  }

  // default plain text-ish fallback
  return { text: normalizeText(buf.toString("utf8")), used: "local-text", fileUrl };
}

async function fetchWithMeta(url) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.8,*/*;q=0.7",
      "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    },
  });

  const contentType = res.headers.get("content-type") || "";
  const status = res.status;
  const ok = res.ok;

  // Read body even on errors (sometimes useful)
  const arr = await res.arrayBuffer().catch(() => null);
  const buf = arr ? Buffer.from(arr) : Buffer.alloc(0);

  return { ok, status, contentType, buf };
}

async function fetchHtmlViaBrowser(url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    locale: "he-IL",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    // Try to accept cookies/consent if a button exists
    const possibleButtons = [
      'button:has-text("אישור")',
      'button:has-text("מסכים")',
      'button:has-text("Accept")',
      'button:has-text("I agree")',
      'button:has-text("Agree")',
    ];
    for (const sel of possibleButtons) {
      const btn = page.locator(sel).first();
      if (await btn.count()) {
        try {
          await btn.click({ timeout: 1500 });
          break;
        } catch {}
      }
    }

    // Wait a bit for client-rendered content
    await page.waitForTimeout(1500);

    // Scroll to trigger lazy loading
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(700);
    }

    // Ensure network idle if possible
    try {
      await page.waitForLoadState("networkidle", { timeout: 15000 });
    } catch {}

    // Collect ALL links (not just pdf/docx) - gov.il often has download links without extensions
    const fileLinks = await page.evaluate(() => {
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      const hrefs = anchors
        .map((a) => (a.getAttribute("href") || "").trim())
        .filter(Boolean);

      // unique, keep it reasonable
      const uniq = Array.from(new Set(hrefs));
      return uniq.slice(0, 250);
    });

    const html = await page.content();
    return { html, fileLinks };
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function sniffPdfUrlViaBrowser(url) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    locale: "he-IL",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  });

  const pdfUrls = new Set();
  const jsonUrls = new Set();

  page.on("response", async (resp) => {
    try {
      const ct = (resp.headers()["content-type"] || "").toLowerCase();
      const rurl = resp.url();
      if (ct.includes("application/pdf")) pdfUrls.add(rurl);
      if (ct.includes("application/json")) jsonUrls.add(rurl);
    } catch {}
  });

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(1500);

    // scroll a bit to trigger lazy load
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(700);
    }

    try {
      await page.waitForLoadState("networkidle", { timeout: 15000 });
    } catch {}

    // If we already saw PDFs, return the first
    if (pdfUrls.size > 0)
      return { pdfUrl: Array.from(pdfUrls)[0], jsonUrl: null };

    // If no PDFs, try to fetch JSON responses and look for ".pdf" inside
    for (const jurl of Array.from(jsonUrls).slice(0, 25)) {
      try {
        const r = await page.request.get(jurl);
        if (!r.ok()) continue;
        const body = await r.text();
        const m = body.match(/https?:\/\/[^\s"'<>]+\.pdf[^\s"'<>]*/i);
        if (m && m[0]) return { pdfUrl: m[0], jsonUrl: jurl };
      } catch {}
    }

    return { pdfUrl: null, jsonUrl: null };
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

function extractTextFromHtmlString(html) {
  const $ = cheerio.load(html);

  $("script, style, nav, header, footer, noscript").remove();

  // Best-effort main content
  const main =
    $("main").text() ||
    $("article").text() ||
    $("#main").text() ||
    $("body").text();
  return normalizeText(main);
}

function findPdfLinksInHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const links = [];

  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    if (!href) return;

    let u = href;
    try {
      if (href.startsWith("/")) {
        const base = new URL(baseUrl);
        u = `${base.origin}${href}`;
      } else if (!href.startsWith("http")) {
        u = new URL(href, baseUrl).toString();
      }
    } catch {
      return;
    }

    if (u.toLowerCase().includes(".pdf")) links.push(u);
  });

  return [...new Set(links)];
}

function toAbsoluteUrlMaybe(href, baseUrl) {
  if (!href) return null;
  const raw = String(href).trim();
  if (!raw) return null;
  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
    if (raw.startsWith("/")) {
      const base = new URL(baseUrl);
      return `${base.origin}${raw}`;
    }
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

function normalizeUrlForQueue(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

function isAllowedGovHost(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return (
      h === "gov.il" ||
      h.endsWith(".gov.il") ||
      h === "knesset.gov.il" ||
      h.endsWith(".knesset.gov.il") ||
      h === "nevo.co.il" ||
      h.endsWith(".nevo.co.il")
    );
  } catch {
    return false;
  }
}

function inferPublisherByUrl(url) {
  const u = (url || "").toLowerCase();
  if (u.includes("knesset.gov.il")) return "knesset";
  if (u.includes("gov.il")) return "gov.il";
  if (u.includes("nevo.co.il")) return "nevo";
  return "gov.il";
}

function inferDocTypeByUrl(url) {
  const u = (url || "").toLowerCase();
  if (u.includes(".pdf")) return "regulation_pdf";
  if (u.includes(".docx") || u.includes(".doc")) return "regulation_doc";
  return "regulation_html";
}

function buildFallbackTitle(url) {
  try {
    const u = new URL(url);
    return `מקור רגולטורי רשמי — ${u.hostname}${u.pathname}`;
  } catch {
    return "מקור רגולטורי רשמי";
  }
}

function isElectricityRegulationLike(params) {
  const title = normalizeText(params?.title || "").toLowerCase();
  const url = String(params?.url || "").toLowerCase();
  const hay = `${title} ${url}`;

  // Keep only legal/electricity regulation style links and drop generic gov pages.
  const positive =
    /(חשמל|תקנות|חוק|הארק|חישמול|פחת|לוח|מיתקן|בטיחות בעבודה|knesset|law|regulation)/i.test(
      hay
    );
  const negative =
    /(רכב|קבלת קהל|דרכון|ארנונה|רישוי|ביטוח לאומי|חינוך|קורונה|נישואין|מענק|תעודת זהות|שכר|תעסוקה)/i.test(
      hay
    );

  return positive && !negative;
}

async function discoverGovernmentSourcesFromIndexPage(indexUrl) {
  const outMap = new Map();
  try {
    const { html, fileLinks } = await fetchHtmlViaBrowser(indexUrl);
    const $ = cheerio.load(html || "");

    $("a[href]").each((_, el) => {
      const href = ($(el).attr("href") || "").trim();
      const title = normalizeText($(el).text() || "").slice(0, 180);
      const abs = toAbsoluteUrlMaybe(href, indexUrl);
      if (!abs) return;
      const normalized = normalizeUrlForQueue(abs);
      if (!isAllowedGovHost(normalized)) return;
      if (!isElectricityRegulationLike({ title, url: normalized })) return;
      if (!outMap.has(normalized)) {
        outMap.set(normalized, {
          title: title || buildFallbackTitle(normalized),
          url: normalized,
          publisher: inferPublisherByUrl(normalized),
          doc_type: inferDocTypeByUrl(normalized),
        });
      }
    });

    for (const href of fileLinks || []) {
      const abs = toAbsoluteUrlMaybe(href, indexUrl);
      if (!abs) continue;
      const normalized = normalizeUrlForQueue(abs);
      if (!isAllowedGovHost(normalized)) continue;
      if (!isElectricityRegulationLike({ title: "", url: normalized })) continue;
      if (!outMap.has(normalized)) {
        outMap.set(normalized, {
          title: buildFallbackTitle(normalized),
          url: normalized,
          publisher: inferPublisherByUrl(normalized),
          doc_type: inferDocTypeByUrl(normalized),
        });
      }
    }
  } catch (err) {
    console.warn(`[index] discovery failed for ${indexUrl}: ${err.message || err}`);
  }
  return Array.from(outMap.values());
}

async function extractTextFromPdfUrl(url) {
  const { ok, status, buf } = await fetchWithMeta(url);
  if (!ok) throw new Error(`PDF fetch failed ${status} for ${url}`);
  const data = await pdfParse(buf);
  return normalizeText(data.text || "");
}

async function extractTextFromDocxUrl(url) {
  const { ok, status, buf } = await fetchWithMeta(url);
  if (!ok) throw new Error(`DOC fetch failed ${status} for ${url}`);

  try {
    const result = await mammoth.extractRawText({ buffer: buf });
    return normalizeText(result.value || "");
  } catch (err) {
    // mammoth only supports DOCX, not old .doc format
    if (err.message && err.message.includes("docx")) {
      // Try LibreOffice conversion for old .doc files
      return await extractTextFromOldDocViaLibreOffice(url, buf);
    }
    throw err;
  }
}

async function extractTextFromOldDocViaLibreOffice(url, docBuffer) {
  const { execSync } = require("child_process");
  const tmpDir = path.join(process.cwd(), "tmp_ingest");
  const tmpDoc = path.join(tmpDir, "input.doc");
  const tmpTxt = path.join(tmpDir, "input.txt");

  try {
    // Create temp directory
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }

    // Write DOC to temp file
    fs.writeFileSync(tmpDoc, docBuffer);

    // Try to find LibreOffice (common paths on Windows)
    const possiblePaths = [
      "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
      "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
      "soffice", // if in PATH
    ];

    let sofficePath = null;
    for (const p of possiblePaths) {
      try {
        if (p === "soffice") {
          execSync("soffice --version", { stdio: "ignore" });
          sofficePath = "soffice";
          break;
        } else if (fs.existsSync(p)) {
          sofficePath = p;
          break;
        }
      } catch {}
    }

    if (!sofficePath) {
      throw new Error(
        "LibreOffice not found. Please install LibreOffice or use PDF source instead."
      );
    }

    // Convert DOC to TXT using LibreOffice headless
    execSync(
      `"${sofficePath}" --headless --convert-to txt:Text "${tmpDoc}" --outdir "${tmpDir}"`,
      { stdio: "ignore", timeout: 30000 }
    );

    // Read converted TXT
    if (fs.existsSync(tmpTxt)) {
      const text = fs.readFileSync(tmpTxt, "utf8");
      return normalizeText(text);
    } else {
      throw new Error("LibreOffice conversion failed - no output file");
    }
  } catch (err) {
    throw new Error(
      `Failed to convert old .doc via LibreOffice: ${err.message}. URL: ${url}`
    );
  } finally {
    // Cleanup temp files
    try {
      if (fs.existsSync(tmpDoc)) fs.unlinkSync(tmpDoc);
      if (fs.existsSync(tmpTxt)) fs.unlinkSync(tmpTxt);
      if (fs.existsSync(tmpDir)) fs.rmdirSync(tmpDir);
    } catch {}
  }
}

async function getBestTextFromUrl(url) {
  // Local file mode (file:relative/path.pdf)
  if (isFileUrl(url)) {
    const local = await extractTextFromLocalFile(url);
    return { text: local.text, used: local.used, pdfUrl: local.fileUrl };
  }

  // 1) Try normal fetch
  const res = await fetchWithMeta(url);

  // If it's a PDF (content-type or .pdf), parse as pdf
  if (
    res.ok &&
    (res.contentType.includes("application/pdf") || isPdfUrl(url))
  ) {
    const data = await pdfParse(res.buf);
    return {
      text: normalizeText(data.text || ""),
      used: "pdf-fetch",
      pdfUrl: url,
    };
  }

  // If it's a DOC/DOCX, parse as docx
  if (
    res.ok &&
    (res.contentType.includes("application/msword") ||
      res.contentType.includes(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ) ||
      url.toLowerCase().includes(".doc") ||
      url.toLowerCase().includes(".docx"))
  ) {
    const text = await extractTextFromDocxUrl(url);
    return { text, used: "doc-fetch", pdfUrl: url };
  }

  // If normal fetch ok and html-ish
  if (res.ok && res.buf.length > 0) {
    const html = res.buf.toString("utf8");
    const text = extractTextFromHtmlString(html);

    // If html has a PDF link and text is tiny, prefer PDF
    if (!text || text.length < 500) {
      const pdfLinks = findPdfLinksInHtml(html, url);
      if (pdfLinks.length > 0) {
        const pdfText = await extractTextFromPdfUrl(pdfLinks[0]);
        return {
          text: pdfText,
          used: "pdf-from-html",
          pdfUrl: pdfLinks[0],
        };
      }
    }

    // If HTML is empty, try browser (for JS-heavy pages like Knesset)
    if (!text || text.length < 200) {
      const browserResult = await fetchHtmlViaBrowser(url);
      const html2 = browserResult.html;
      const text2 = extractTextFromHtmlString(html2);
      if (text2 && text2.length > text.length) {
        return { text: text2, used: "browser-html", html: html2 };
      }
    }

    return { text, used: "html-fetch", html };
  }

  // 2) If blocked (403/401/429), use Playwright
  if (res.status === 403 || res.status === 401 || res.status === 429) {
    const browserResult = await fetchHtmlViaBrowser(url);
    const html = browserResult.html;
    const text = extractTextFromHtmlString(html);

    // Prefer PDF/DOC attachments if exist - check all links, not just .pdf
    const links = browserResult.fileLinks || [];
    console.log(`Browser links found: ${links.length}`);

    const normalized = links
      .map((href) => {
        try {
          if (href.startsWith("http")) return href;
          if (href.startsWith("/")) {
            const base = new URL(url);
            return `${base.origin}${href}`;
          }
          return new URL(href, url).toString();
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    // First try obvious PDFs
    const obviousPdf = normalized.find((u) => u.toLowerCase().includes(".pdf"));
    if (obviousPdf) {
      console.log(`Found obvious PDF link: ${obviousPdf}`);
      const pdfText = await extractTextFromPdfUrl(obviousPdf);
      if (pdfText && pdfText.length > 500) {
        return {
          text: pdfText,
          used: "attachment-pdf",
          pdfUrl: obviousPdf,
        };
      }
    }

    // Then probe top candidates by content-type (PDF may not have .pdf)
    const candidates = normalized.slice(0, 40);
    for (const cand of candidates) {
      try {
        const probe = await fetchWithMeta(cand);
        if (
          probe.ok &&
          (probe.contentType.includes("application/pdf") ||
            cand.toLowerCase().includes(".pdf"))
        ) {
          console.log(`Detected PDF by content-type: ${cand}`);
          const data = await pdfParse(probe.buf);
          const pdfText = normalizeText(data.text || "");
          if (pdfText && pdfText.length > 500) {
            return {
              text: pdfText,
              used: "attachment-pdf-by-ctype",
              pdfUrl: cand,
            };
          }
        }
      } catch {}
    }

    // If still tiny, try pdf links in HTML
    if (!text || text.length < 500) {
      const pdfLinks = findPdfLinksInHtml(html, url);
      if (pdfLinks.length > 0) {
        const pdfText = await extractTextFromPdfUrl(pdfLinks[0]);
        return {
          text: pdfText,
          used: "pdf-from-browser-html",
          pdfUrl: pdfLinks[0],
        };
      }
    }

    // If still tiny, try to sniff a PDF via network requests
    if (!text || text.length < 800) {
      const sniff = await sniffPdfUrlViaBrowser(url);
      if (sniff.pdfUrl) {
        console.log(`Sniffed PDF from network: ${sniff.pdfUrl}`);
        const pdfText = await extractTextFromPdfUrl(sniff.pdfUrl);
        if (pdfText && pdfText.length > 500) {
          return {
            text: pdfText,
            used: "pdf-sniffed",
            pdfUrl: sniff.pdfUrl,
          };
        }
      } else {
        console.log("No PDF detected via network sniffing.");
      }
    }

    return { text, used: "browser-html", html };
  }

  throw new Error(`Fetch failed ${res.status} for ${url}`);
}

async function upsertSource({ title, url, publisher, doc_type }) {
  const { data: existing } = await supabase
    .from("sources")
    .select("id,title,url,checksum")
    .or(`url.eq.${url},title.eq.${title}`)
    .limit(1)
    .maybeSingle();

  if (existing?.id) return existing;

  const { data, error } = await supabase
    .from("sources")
    .insert({
      title,
      url,
      publisher,
      doc_type,
      version: "v1",
      fetched_at: new Date().toISOString(),
      status: "active",
    })
    .select("id,title,url,checksum")
    .single();

  if (error) throw error;
  return data;
}

async function replaceChunks(sourceId, chunks, url, used, extraLocator = {}) {
  const { error: delErr } = await supabase
    .from("chunks")
    .delete()
    .eq("source_id", sourceId);
  if (delErr) throw delErr;

  const rows = chunks.map((text, idx) => ({
    source_id: sourceId,
    chunk_index: idx + 1,
    section: guessSection(text) || `Chunk ${idx + 1}`,
    text,
    tags: [],
    locator: { url, used, chunk: idx + 1, ...extraLocator },
  }));

  const batchSize = 150;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase.from("chunks").insert(batch);
    if (error) throw error;
  }
}

async function updateSourceChecksum(sourceId, checksum) {
  const { error } = await supabase
    .from("sources")
    .update({
      checksum,
      fetched_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", sourceId);
  if (error) throw error;
}

async function ingestOne(src) {
  const { title, url, publisher, doc_type } = src;
  console.log(`\n=== Ingest: ${title}\n${url}`);
  const normalizedUrl = normalizeUrlForQueue(url);
  if (INGEST_VISITED_URLS.has(normalizedUrl)) {
    console.log("Already visited URL in this run. Skipping.");
    return;
  }
  INGEST_VISITED_URLS.add(normalizedUrl);

  try {
    const sourceRow = await upsertSource({ title, url, publisher, doc_type });

    if (/index|landing/i.test(String(doc_type || ""))) {
      const discovered = await discoverGovernmentSourcesFromIndexPage(url);
      const filtered = discovered
        .filter((d) => d.url !== normalizedUrl)
        .filter((d) => !/mmok_takanot_maagar_2025/i.test(d.url))
        .slice(0, 120);
      console.log(`[index] discovered ${filtered.length} official links from index page.`);

      const { error: delErr } = await supabase
        .from("chunks")
        .delete()
        .eq("source_id", sourceRow.id);
      if (delErr) throw delErr;

      for (const child of filtered) {
        await ingestOne(child);
      }

      // Keep index source without chunks to avoid noisy retrieval on navigation pages.
      await updateSourceChecksum(sourceRow.id, sha256(`index:${filtered.length}:${new Date().toISOString()}`));
      console.log("Index source processed (links ingested, chunks skipped).");
      return;
    }

    const { text, used, pdfUrl } = await getBestTextFromUrl(url);

    console.log(`Used: ${used}${pdfUrl ? ` (PDF: ${pdfUrl})` : ""}`);
    console.log(`Text length: ${text ? text.length : 0}`);

    if (!text || text.length < 200) {
      console.warn(`Text too small (${text ? text.length : 0}). Skipping.`);
      return;
    }

    const checksum = sha256(text);

    const FORCE_RECHUNK = process.env.FORCE_RECHUNK === "1";
    if (!FORCE_RECHUNK && sourceRow.checksum && sourceRow.checksum === checksum) {
      console.log("No change (checksum match). Skipping.");
      return;
    }
    if (FORCE_RECHUNK && sourceRow.checksum && sourceRow.checksum === checksum) {
      console.log("No change, but FORCE_RECHUNK=1 so rebuilding chunks/sections.");
    }

    const chunks = chunkText(text, { maxChars: 1200, overlap: 150 });
    console.log(`Extracted chars: ${text.length}, chunks: ${chunks.length}`);

    await replaceChunks(sourceRow.id, chunks, url, used, pdfUrl ? { pdfUrl } : {});
    await updateSourceChecksum(sourceRow.id, checksum);

    console.log("Done.");
  } catch (e) {
    console.error(`Failed to ingest ${title}: ${e.message || e}`);
  }
}

async function main() {
  const pdfDir = process.env.PDF_DIR;
  let sources = [];
  if (pdfDir) {
    sources = buildSourcesFromLocalPdfDir(pdfDir);
    console.log(`[ingest] PDF_DIR mode: ${pdfDir}`);
    console.log(`[ingest] Found ${sources.length} local PDF files.`);
  } else {
    const sourcesPath = process.env.SOURCES_FILE
      ? path.join(process.cwd(), process.env.SOURCES_FILE)
      : path.join(process.cwd(), "scripts", "sources.json");
    sources = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
    console.log(`[ingest] SOURCES_FILE mode: ${sourcesPath}`);
  }

  // Run sequentially to avoid overwhelming servers and Playwright browser instances
  for (const src of sources) {
    try {
      await ingestOne(src);
    } catch (err) {
      console.error(`Failed to ingest ${src.title}:`, err.message);
    }
  }

  console.log("\nAll ingestion completed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
