import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { normalizeHebrewText } from "../../../lib/normalizeHebrewText";

type Citation = {
  title: string;
  section: string;
  url?: string;
  locator?: any;
};

type AnswerSegment = {
  title: string;
  section: string;
  text: string;
  url?: string;
};

type AskResponse = {
  answer: string;
  mode: "online";
  citations: Citation[];
  segments: AnswerSegment[];
  confidence: "high" | "medium" | "low";
};

type Hit = {
  source_title: string;
  source_url: string | null;
  section: string | null;
  locator: any;
  text: string;
  rank: number;
};

const NOISE_PATTERNS = [
  /your browser does not support the video tag/gi,
  /skip to main content/gi,
  /תפריט ראשי/g,
  /<<\s*הקודם\s*הבא\s*>>/g,
  /לא קיים סרטון/g,
  /מסמכי עבודה/g,
  /הדפסה/g,
];

function cleanAnswerText(text: string): string {
  let out = normalizeHebrewText(text || "");
  for (const p of NOISE_PATTERNS) out = out.replace(p, " ");
  out = out.replace(/\s{2,}/g, " ").trim();
  return out;
}

function noiseScore(text: string): number {
  const t = (text || "").toLowerCase();
  let score = 0;
  if (t.includes("your browser does not support the video tag")) score += 3;
  if (t.includes("skip to main content")) score += 2;
  if (t.includes("תפריט ראשי")) score += 2;
  if (t.includes("לא קיים סרטון")) score += 1;
  if (t.includes("<< הקודם הבא >>")) score += 1;
  return score;
}

function fingerprint(text: string): string {
  return (text || "")
    .toLowerCase()
    .replace(/[^\u0590-\u05ffA-Za-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function buildExpandedQueries(q: string): string[] {
  const normalized = q.trim();
  const variants = new Set<string>([normalized]);

  const synonymMap: Array<{ re: RegExp; add: string[] }> = [
    { re: /הארק(?:ה|ות)/i, add: ["הארקת יסוד", "מוליך הארקה", "השוואת פוטנציאלים", "PE"] },
    { re: /פחת/i, add: ["מפסק פחת", "RCD", "ממסר פחת"] },
    { re: /ריכוז מונים|מונים|מונה/i, add: ["ארון מונים", "ריכוז מונים", "לוח מונים"] },
    { re: /לוח|לוחות/i, add: ["לוח חשמל", "לוח ראשי", "מפסק ראשי"] },
    { re: /איפוס|tt|tn/i, add: ["TN", "TT", "שיטת איפוס"] },
  ];

  for (const s of synonymMap) {
    if (s.re.test(normalized)) {
      variants.add(`${normalized} ${s.add.join(" ")}`);
      s.add.forEach((term) => variants.add(term));
    }
  }

  // Add token-level fallbacks for natural Hebrew questions:
  // "איך לסדר ריכוז מונים" -> "ריכוז", "מונים", "ריכוז מונים"
  const cleaned = normalized
    .replace(/[^\u0590-\u05FFA-Za-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const stopwords = new Set([
    "איך",
    "מה",
    "מתי",
    "למה",
    "איפה",
    "מי",
    "עם",
    "על",
    "של",
    "את",
    "זה",
    "זו",
    "או",
    "אם",
    "כי",
    "לפי",
    "צריך",
    "אפשר",
    "רוצה",
    "לסדר",
  ]);
  const tokens = cleaned
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !stopwords.has(t));
  tokens.forEach((t) => variants.add(t));
  for (let i = 0; i < tokens.length - 1; i += 1) {
    variants.add(`${tokens[i]} ${tokens[i + 1]}`);
  }

  // Keep small set to avoid latency spikes.
  return Array.from(variants).slice(0, 8);
}

function dedupeHits(hits: Hit[]): Hit[] {
  const seen = new Set<string>();
  const out: Hit[] = [];
  for (const h of hits) {
    const key = `${h.source_title}||${h.section || ""}||${fingerprint(h.text || "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<AskResponse | { error: string }>
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { question } = req.body as { question?: string };
  const q = (question || "").trim();
  if (!q) {
    return res.status(400).json({ error: "Missing question" });
  }

  // Read env (and log short debug so תוכל לראות בטרמינל מה נטען)
  const urlFromEnv = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // fallback: אם משום מה ה‑env לא נקרא, נשתמש ב‑URL הקבוע כדי שלא תחסם
  const url =
    urlFromEnv || "https://sareeozscowscaiyepkz.supabase.co";

  // debug minimal (לא מדפיס את כל ה‑key)
  // eslint-disable-next-line no-console
  console.log("SUPABASE_URL:", urlFromEnv);
  // eslint-disable-next-line no-console
  console.log(
    "SUPABASE_KEY_PREFIX:",
    anon ? String(anon).slice(0, 20) : "MISSING"
  );

  // עדיין דורשים שיהיה KEY תקין מה‑env
  if (!anon) {
    return res
      .status(500)
      .json({ error: "Missing env: NEXT_PUBLIC_SUPABASE_ANON_KEY" });
  }

  const supabase = createClient(url, anon, {
    auth: { persistSession: false },
  });

  // Expand query for common Hebrew/English brand names
  const queryExpansions: Record<string, string> = {
    שניידר: "Schneider",
    "שניידר אלקטריק": "Schneider Electric",
    ארכה: "ERCO",
    אסקו: "Aresco",
    "א.ר. אסקו": "A.R. Aresco",
    "wise electric": "Wise Electric",
    "אל-קם": "El-Kam",
  };

  let expandedQuery = q;
  for (const [hebrew, english] of Object.entries(queryExpansions)) {
    if (q.includes(hebrew)) {
      expandedQuery = `${q} ${english}`;
      break;
    }
  }

  const queryVariants = buildExpandedQueries(expandedQuery);
  const collectedHits: Hit[] = [];

  for (const qv of queryVariants) {
    const { data, error } = await supabase.rpc("search_chunks", {
      q: qv,
      k: 20,
    });

    if (error) {
      return res
        .status(500)
        .json({ error: `search_chunks failed: ${error.message}` });
    }

    collectedHits.push(...((data || []) as Hit[]));
  }

  const hits = dedupeHits(collectedHits);

  if (!hits || hits.length === 0) {
    return res.status(200).json({
      mode: "online",
      confidence: "low",
      answer:
        "לא מצאתי במאגר המקוון קטעים רלוונטיים מספיק. נסה ניסוח אחר או נוסיף מקורות נוספים.",
      citations: [],
      segments: [],
    });
  }

  // Get source metadata for re-ranking
  const sourceTitles = [...new Set(hits.map((h) => h.source_title).filter(Boolean))];
  const sourceDocTypes: Record<string, string> = {};
  const sourcePublishers: Record<string, string> = {};

  if (sourceTitles.length > 0) {
    const { data: sourcesData } = await supabase
      .from("sources")
      .select("title, doc_type, publisher")
      .in("title", sourceTitles);

    if (sourcesData) {
      for (const s of sourcesData) {
        sourceDocTypes[s.title] = s.doc_type || "";
        sourcePublishers[s.title] = s.publisher || "";
      }
    }
  }

  const isCatalogIntent =
    /(קטלוג|מק\"?ט|דגם|מחיר|שניידר|schneider|ארכה|erco|אסקו|aresco|wise|אל-?קם|el-?kam)/i.test(
      q
    );
  const isUtilityIntent =
    /(המעגל|חברת החשמל|ריכוז מונים|מונים|מונה|חיבור לבניין|תכנון חיבור)/i.test(
      q
    );

  // Sort hits so that laws/regulations and official sources are first, suppliers last.
  const getPriorityForHit = (h: Hit): number => {
    const docType = (sourceDocTypes[h.source_title] || "").toLowerCase();
    const publisher = (sourcePublishers[h.source_title] || "").toLowerCase();
    const url = (h.source_url || "").toLowerCase();

    // Highest priority: laws / regulations / safety + official gov / knesset / nevo
    if (
      docType.startsWith("law_") ||
      docType.startsWith("regulation_") ||
      docType.startsWith("safety_") ||
      publisher.includes("knesset") ||
      publisher.includes("gov") ||
      publisher.includes("nevo") ||
      url.includes("knesset.gov.il") ||
      url.includes("gov.il") ||
      url.includes("nevo.co.il")
    ) {
      return 0;
    }

    // Utility (IEC המעגל)
    if (
      docType.startsWith("utility_") ||
      publisher.includes("iec") ||
      url.includes("iec-hamaagal.co.il")
    ) {
      return 1;
    }

    // Suppliers / catalogs – always last
    if (
      docType.startsWith("catalog_") ||
      publisher.includes("public_copy") ||
      publisher.includes("schneider") ||
      publisher.includes("erco") ||
      publisher.includes("aresco") ||
      publisher.includes("wise") ||
      publisher.includes("el-kam") ||
      url.includes("erco.co.il") ||
      url.includes("aresco.co.il") ||
      url.includes("wise-electric.co.il") ||
      url.includes("wise-electric.com") ||
      url.includes("el-kam.com") ||
      url.includes("se.com")
    ) {
      return 3;
    }

    // Other sources in the middle
    return 2;
  };

  let rankedHits = [...hits].sort((a, b) => {
    const priorityA = getPriorityForHit(a);
    const priorityB = getPriorityForHit(b);

    // First sort by priority (lower is better), then by rank
    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }
    return (b.rank || 0) - (a.rank || 0);
  });

  // Unless user asked for supplier/catalog info explicitly, hide catalog hits when better sources exist
  if (!isCatalogIntent) {
    const nonCatalog = rankedHits.filter((h) => getPriorityForHit(h) <= 2);
    if (nonCatalog.length > 0) rankedHits = nonCatalog;
  }

  // If this is not a utility-specific question and we have legal hits,
  // force legal sources to dominate the final answer.
  if (!isUtilityIntent) {
    const legalOnly = rankedHits.filter((h) => getPriorityForHit(h) === 0);
    if (legalOnly.length > 0) rankedHits = legalOnly;
  }

  // Filter out broken PDF extraction chunks (control chars / unreadable garbage).
  const isReadableHit = (raw: string): boolean => {
    const text = raw || "";
    if (!text.trim()) return false;

    const controlChars = (text.match(/[\u0000-\u001F\u007F-\u009F]/g) || [])
      .length;
    const replacementChars = (text.match(/�/g) || []).length;
    const length = Math.max(text.length, 1);
    const noiseRatio = (controlChars + replacementChars) / length;

    // Reject if clearly noisy.
    if (controlChars >= 3) return false;
    if (noiseRatio > 0.01) return false;

    return true;
  };

  const readableHits = rankedHits.filter((h) => isReadableHit(h.text || ""));
  if (readableHits.length > 0) rankedHits = readableHits;

  // Prefer cleaner and more diverse hits (avoid multiple near-identical menu pages).
  const sortedByQuality = [...rankedHits].sort((a, b) => {
    const qa = noiseScore(a.text || "");
    const qb = noiseScore(b.text || "");
    if (qa !== qb) return qa - qb;
    return (b.rank || 0) - (a.rank || 0);
  });

  const diverseTop: Hit[] = [];
  const seenFingerprints = new Set<string>();
  const seenTitles = new Set<string>();

  for (const h of sortedByQuality) {
    if (diverseTop.length >= 4) break;
    const fp = fingerprint(cleanAnswerText(h.text || ""));
    if (!fp || fp.length < 20) continue;
    if (seenFingerprints.has(fp)) continue;

    // Allow at most 1 result per exact source title in top set.
    if (seenTitles.has(h.source_title)) continue;

    seenFingerprints.add(fp);
    seenTitles.add(h.source_title);
    diverseTop.push(h);
  }

  const top = diverseTop.length > 0 ? diverseTop : rankedHits.slice(0, 4);

  const segments: AnswerSegment[] = top.map((h) => ({
    title: h.source_title,
    section:
      h.section && !/^chunk\s+\d+/i.test(h.section)
        ? h.section
        : "קטע רלוונטי",
    text: cleanAnswerText(h.text || ""),
    url: h.source_url || undefined,
  }));

  const answer = `מצאתי ${rankedHits.length} קטעים רלוונטיים בנושא "${q}". מוצגים המקורות המהימנים ביותר קודם.`;

  const citations = top.map((h) => ({
    title: h.source_title,
    section: h.section || "ללא סעיף",
    url: h.source_url || undefined,
    locator: h.locator || undefined,
  }));

  const confidence =
    rankedHits[0].rank >= 1.2
      ? "high"
      : rankedHits[0].rank >= 0.7
        ? "medium"
        : "low";

  return res.status(200).json({
    mode: "online",
    confidence,
    answer,
    citations,
    segments,
  });
}

