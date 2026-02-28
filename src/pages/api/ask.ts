import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { normalizeHebrewText } from "../../../lib/normalizeHebrewText";
import type { AskResponse, AskSource } from "../../types/ask";

type AnswerSegment = {
  title: string;
  section: string;
  text: string;
  url?: string;
};

type ScopeMode = "law_only" | "law_plus_utility" | "all";

type AskHistoryItem = {
  q: string;
  createdAt?: string;
};

type AskDebugPayload = {
  retrievedTitles: Array<{ title: string; section: string }>;
  retrievedSnippets: Array<{ title: string; section: string; snippet: string }>;
};

type AskDebugResponse = AskResponse & {
  debug: AskDebugPayload;
};

const SYSTEM_JSON = `
You are a careful assistant for electricians in Israel.
Answer ONLY from the provided sources. If sources are insufficient, say so and ask for missing info.
Return ONLY valid JSON in this exact schema:

{
  "bottomLine": string,
  "steps": string[],
  "cautions": string[],
  "requiredInfo"?: string[],
  "followUpQuestion"?: string,
  "sources": { "title": string, "section": string, "url"?: string }[],
  "confidence": "high" | "medium" | "low"
}

Rules:
- No markdown.
- No extra keys.
- If you are missing critical info to decide, set confidence="low", fill requiredInfo and followUpQuestion.
- If safety-related, add cautions.
- If the user asks "is X ohms OK", you MUST ask what measurement it is (RA vs Zs vs PE continuity) and the earthing system (TT/TN), unless sources explicitly define it.
`;

type DomainIntent =
  | "bathroom"
  | "garden"
  | "grounding"
  | "rcd"
  | "panels"
  | "metering"
  | "medical"
  | "general";

function sanitizeUserQuestion(input: string): string {
  let q = normalizeHebrewText(input || "");
  // Remove dangling quote/bracket tails like: מרחק מאמבטיה לפי תקנות")
  q = q.replace(/["'`)\]}»”]+$/g, "").trim();
  // Collapse repeated punctuation that hurts search parsing.
  q = q.replace(/[!?.,;:]{2,}/g, (m) => m.slice(0, 1));
  return q;
}

function looksLikeEarthingOhmsQuestion(q: string) {
  const s = (q || "").replace(/\s+/g, " ");
  return /הארק|הארקה/.test(s) && (/(אוהם|Ω|ohm)/i.test(s) || /התנגדות/.test(s));
}

function sourcesContainAny(sourcesText: string, terms: RegExp[]) {
  return terms.some((re) => re.test(sourcesText || ""));
}

function stripHebrewPrefix(token: string): string {
  const t = (token || "").trim();
  if (t.length < 4) return t;
  // Common Hebrew prefixes in natural questions: ו/ב/ל/כ/מ/ה/ש
  const stripped = t.replace(/^[ובכלמהש](?=[\u0590-\u05ff]{3,})/, "");
  return stripped.length >= 3 ? stripped : t;
}

function shortSnippet(text: string, max = 260): string {
  const t = cleanAnswerText(text || "");
  if (t.length <= max) return t;
  return `${t.slice(0, max).trim()}...`;
}

function buildFallbackConversationalAnswer(params: {
  question: string;
  segments: AnswerSegment[];
  confidence: "high" | "medium" | "low";
  sources: AskSource[];
}): AskResponse {
  const { question, segments, confidence, sources } = params;
  if (!segments.length) {
    return {
      bottomLine:
        "לא מצאתי כרגע מקור חוקי מספיק מדויק לשאלה הזו. אפשר לנסח שאלה ממוקדת יותר לפי תקנה/סעיף או לפי סוג מתקן.",
      steps: [],
      cautions: [],
      requiredInfo: ["סוג מתקן", "מתח", "נקודת מדידה"],
      followUpQuestion:
        "כדי לדייק: מדובר במבנה מגורים, אתר רפואי, או מתקן תעשייתי?",
      sources,
      confidence: "low",
    };
  }
  const steps = segments.slice(0, 4).map((s) => `${s.section}: ${shortSnippet(s.text, 180)}`);
  return {
    bottomLine: `לפי המקורות שבדקתי, זו התשובה לשאלה "${question}".`,
    steps,
    cautions: [
      "לפני ביצוע עבודה בשטח יש לפעול לפי התקנות והנחיות הבטיחות המחייבות.",
    ],
    requiredInfo:
      confidence === "low"
        ? ["סוג מתקן", "מתח", "שיטת הארקה/הגנה", "ערך מדידה אם קיים"]
        : undefined,
    followUpQuestion:
      "כדי לדייק לפעולה בשטח: מה סוג המתקן ומה המתח הרלוונטי?",
    sources,
    confidence,
  };
}

async function generateConversationalAnswer(params: {
  question: string;
  contextualQuestion: string;
  issueType?: string;
  history: AskHistoryItem[];
  segments: AnswerSegment[];
  sources: AskSource[];
  confidence: "high" | "medium" | "low";
}): Promise<AskResponse | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const contextBlocks = params.segments
    .slice(0, 4)
    .map(
      (s, i) =>
        `מקור ${i + 1}\nכותרת: ${s.title}\nסעיף: ${s.section}\nטקסט: ${shortSnippet(s.text, 850)}`
    )
    .join("\n\n");

  const historyText = params.history
    .slice(-4)
    .map((h, idx) => `${idx + 1}. ${h.q}`)
    .join("\n");

  const userPrompt = [
    `שאלה נוכחית: ${params.question}`,
    `שאלה קונטקסטואלית לחיפוש: ${params.contextualQuestion}`,
    params.issueType ? `סוג תקלה: ${params.issueType}` : "",
    historyText ? `היסטוריית שיחה אחרונה:\n${historyText}` : "",
    `מקורות:\n${contextBlocks}`,
    `מקורות להצמדה בתשובה: ${JSON.stringify(params.sources)}`,
    `רמת ביטחון מומלצת לפי רטריבל: ${params.confidence}`,
    "החזר רק JSON תקין לפי הסכמה.",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 700,
        messages: [
          { role: "system", content: SYSTEM_JSON },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const modelText = data.choices?.[0]?.message?.content?.trim();
    if (!modelText) return null;
    const parsed = JSON.parse(modelText) as AskResponse;
    if (!parsed || typeof parsed.bottomLine !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

type Hit = {
  source_title: string;
  source_url: string | null;
  section: string | null;
  locator: any;
  text: string;
  rank: number;
};

type SourceMeta = {
  id: string;
  title: string;
  url: string | null;
  publisher: string | null;
  doc_type: string | null;
};

const PRIMARY_LAW_DISPLAY_TITLE = "חוק החשמל — מקור חוקי";
const PRIMARY_LAW_DISPLAY_URL = "https://fs.knesset.gov.il/2/law/2_lsr_208393.PDF";

function isPrimaryLocalLawSource(source: {
  title?: string | null;
  publisher?: string | null;
  url?: string | null;
}): boolean {
  const title = (source.title || "").toLowerCase();
  const publisher = (source.publisher || "").toLowerCase();
  const url = (source.url || "").toLowerCase();
  return (
    publisher.includes("official_local_pdf") ||
    publisher.includes("official_local_word") ||
    url.startsWith("file:חוק-החשמל-2017.pdf") ||
    url.startsWith("file:חוק-החשמל-2017.docx") ||
    url.startsWith("file:חוק-החשמל-2017.doc") ||
    (title.includes("חוק החשמל") && title.includes("2017"))
  );
}

function isGovernmentLawSource(source: {
  publisher?: string | null;
  url?: string | null;
}): boolean {
  const publisher = (source.publisher || "").toLowerCase();
  const url = (source.url || "").toLowerCase();
  return (
    publisher.includes("knesset") ||
    publisher.includes("gov") ||
    publisher.includes("nevo") ||
    url.includes("knesset.gov.il") ||
    url.includes("gov.il") ||
    url.includes("nevo.co.il")
  );
}

function isMaskedIndexSource(source: {
  title?: string | null;
  url?: string | null;
  docType?: string | null;
}): boolean {
  const title = (source.title || "").toLowerCase();
  const url = (source.url || "").toLowerCase();
  const docType = (source.docType || "").toLowerCase();
  return (
    docType.includes("index") ||
    url.includes("mmok_takanot_maagar_2025") ||
    title.includes("מאגר תקנות")
  );
}

function isElectricityLegalHit(hit: {
  source_title?: string | null;
  source_url?: string | null;
  section?: string | null;
  text?: string | null;
}): boolean {
  const hay = normalizeHebrewText(
    `${hit.source_title || ""} ${hit.source_url || ""} ${hit.section || ""} ${hit.text || ""}`
  ).toLowerCase();
  const positive =
    /(חשמל|תקנות|חוק|הארק|חישמול|פחת|לוח|מיתקן|מקלחת|אמבט|בטיחות בעבודה|סעיף|תקנה|ground|rcd)/i.test(
      hay
    );
  const negative =
    /(קבלת קהל|רכב|דרכון|ארנונה|נישואין|תעסוקה|שכר|רישוי|מענק|חינוך|ביטוח לאומי)/i.test(
      hay
    );
  return positive && !negative;
}

function hasMojibakeNoise(text: string): boolean {
  const t = text || "";
  if (!t.trim()) return false;
  // Common broken-encoding chars seen in corrupted PDF extraction.
  const suspicious = (t.match(/[À-ÿÆØß≤≥∑∂∏∫∑˜]/g) || []).length;
  const len = Math.max(t.length, 1);
  if (suspicious / len > 0.08) return true;
  if (/Ì|Æ|≤|∑|˜/.test(t) && suspicious > 12) return true;
  return false;
}

function extractQueryContextFlags(question: string) {
  const q = normalizeHebrewText(question || "").toLowerCase();
  return {
    residential: /(דיר(?:ה|ת)|מגורים|בית(?:\s+מגורים)?)/i.test(q),
    medical: /(רפואי|מרפאה|קליניקה|בית חולים|אתר רפואי)/i.test(q),
    pool: /(בריכ(?:ה|ות)|מאגר מים|מים)/i.test(q),
    agricultural: /(חקלאי|חצרים חקלאיים|לול|רפת)/i.test(q),
    construction: /(אתר בניה|בניה|קרון מגורים|מיתקן ארעי)/i.test(q),
  };
}

function isUnrelatedContextForQuery(params: {
  question: string;
  domainIntent: DomainIntent;
  hit: Hit;
}): boolean {
  const { question, domainIntent, hit } = params;
  const ctx = extractQueryContextFlags(question);
  const hay = normalizeHebrewText(
    `${hit.source_title || ""} ${hit.section || ""} ${hit.text || ""}`
  ).toLowerCase();
  const titleOnly = normalizeHebrewText(hit.source_title || "").toLowerCase();

  // Prefer binding regulations over generic interpretation memos unless explicitly requested.
  if (!/(פירוש|פרשנות|מינהל החשמל|הבהרה|חוזר)/i.test(normalizeHebrewText(question || ""))) {
    if (
      /(פירושים בעניין יישום|מינהל החשמל|פניה)/i.test(titleOnly) ||
      /^\d{2}-\d{2}-\d{2}$/.test((hit.source_title || "").trim())
    ) {
      return true;
    }
  }

  // For core grounding questions, avoid pulling "special sites" unless user asked for them.
  if (domainIntent === "grounding") {
    if (!ctx.medical && /(רפואי|סביבת מטופל|אתר רפואי)/i.test(hay)) return true;
    if (!ctx.pool && /(בריכ(?:ה|ות)|מאגר מים)/i.test(hay)) return true;
    if (!ctx.agricultural && /(חקלאי|חצרים חקלאיים|לול|רפת)/i.test(hay)) return true;
    if (!ctx.construction && /(אתר בניה|קרון מגורים|מיתקן ארעי)/i.test(hay)) return true;
  }

  // For residential questions, suppress special environments unless explicit in query.
  if (ctx.residential) {
    if (!ctx.medical && /(רפואי|סביבת מטופל|אתר רפואי)/i.test(hay)) return true;
    if (!ctx.pool && /(בריכ(?:ה|ות)|מאגר מים)/i.test(hay)) return true;
    if (!ctx.agricultural && /(חקלאי|חצרים חקלאיים|לול|רפת)/i.test(hay)) return true;
  }

  return false;
}

function contextMatchBoost(question: string, hit: Hit): number {
  const ctx = extractQueryContextFlags(question);
  const hay = normalizeHebrewText(
    `${hit.source_title || ""} ${hit.section || ""} ${hit.text || ""}`
  ).toLowerCase();
  let score = 0;
  if (ctx.residential && /(דיר(?:ה|ת)|מגורים|בית(?:\s+מגורים)?)/i.test(hay)) score += 0.45;
  if (ctx.medical && /(רפואי|מרפאה|קליניקה|בית חולים)/i.test(hay)) score += 0.45;
  if (ctx.pool && /(בריכ(?:ה|ות)|מאגר מים)/i.test(hay)) score += 0.35;
  if (ctx.agricultural && /(חקלאי|חצרים חקלאיים|לול|רפת)/i.test(hay)) score += 0.35;
  if (ctx.construction && /(אתר בניה|קרון מגורים|מיתקן ארעי)/i.test(hay)) score += 0.35;
  return score;
}

function strongIntentMatch(question: string, hit: Hit, domainIntent: DomainIntent): boolean {
  const q = normalizeHebrewText(question || "").toLowerCase();
  const hay = normalizeHebrewText(
    `${hit.source_title || ""} ${hit.section || ""} ${hit.text || ""}`
  ).toLowerCase();

  if (domainIntent === "grounding" || /הארקה/.test(q)) {
    return /(הארקה|מוליך הארקה|השוואת פוטנציאלים|tt|tn|pe|איפוס)/i.test(hay);
  }
  if (domainIntent === "bathroom") {
    return /(אמבט|מקלח|חדר רחצה|אזור\s*[012]|רטוב)/i.test(hay);
  }
  if (domainIntent === "rcd") {
    return /(פחת|rcd|ממסר פחת)/i.test(hay);
  }
  return true;
}

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
  const normalized = sanitizeUserQuestion(q).trim();
  const variants = new Set<string>([normalized]);
  variants.add(`${normalized} לפי תקנות`);
  variants.add(`${normalized} חוק החשמל`);
  variants.add(`${normalized} תקנות חשמל`);

  const synonymMap: Array<{ re: RegExp; add: string[] }> = [
    { re: /הארק(?:ה|ות)/i, add: ["הארקת יסוד", "מוליך הארקה", "השוואת פוטנציאלים", "PE"] },
    { re: /פחת/i, add: ["מפסק פחת", "RCD", "ממסר פחת"] },
    { re: /ריכוז מונים|מונים|מונה/i, add: ["ארון מונים", "ריכוז מונים", "לוח מונים"] },
    { re: /לוח|לוחות/i, add: ["לוח חשמל", "לוח ראשי", "מפסק ראשי"] },
    { re: /איפוס|tt|tn/i, add: ["TN", "TT", "שיטת איפוס"] },
    {
      re: /אמבטיה|מקלחת|חדר רחצה|רטוב/i,
      add: [
        "אמבטיה",
        "מקלחת",
        "חדר רחצה",
        "הגנה מפני חישמול",
        "מרחקי בטיחות",
        "מרחק מאמבטיה לפי תקנות",
      ],
    },
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
  tokens.forEach((t) => {
    variants.add(t);
    variants.add(stripHebrewPrefix(t));
  });
  for (let i = 0; i < tokens.length - 1; i += 1) {
    variants.add(`${tokens[i]} ${tokens[i + 1]}`);
    variants.add(`${stripHebrewPrefix(tokens[i])} ${stripHebrewPrefix(tokens[i + 1])}`);
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

function detectDomainIntent(question: string): DomainIntent {
  const q = normalizeHebrewText(question || "").toLowerCase();
  if (/(אמבט|אמבטיה|מקלח|מקלחת|חדר רחצה|רטוב|אזור\s*[012])/.test(q)) return "bathroom";
  if (/(ברז גינה|גינה|חצר|חוץ)/.test(q)) return "garden";
  if (/(הארקה|מוליך הארקה|השוואת פוטנציאלים|pe)/.test(q)) return "grounding";
  if (/(פחת|rcd|ממסר פחת)/.test(q)) return "rcd";
  if (/(לוח|לוחות|מפסק ראשי|מאמ\"ת|מאמת)/.test(q)) return "panels";
  if (/(מונה|מונים|ריכוז מונים|ארון מונים)/.test(q)) return "metering";
  if (/(רפואי|מרפאה|קליניקה|בית חולים)/.test(q)) return "medical";
  return "general";
}

function domainRelevanceScore(
  domain: DomainIntent,
  hit: { source_title: string; section: string | null; text: string }
): number {
  const title = normalizeHebrewText(hit.source_title || "").toLowerCase();
  const section = normalizeHebrewText(hit.section || "").toLowerCase();
  const text = normalizeHebrewText(hit.text || "").toLowerCase();
  const hay = `${title} ${section} ${text}`;

  const hasAny = (patterns: RegExp[]) => patterns.some((p) => p.test(hay));

  switch (domain) {
    case "bathroom":
      return hasAny([/אמבטיה/, /מקלחת/, /חדר רחצה/, /רטוב/]) ? 1 : 0;
    case "garden":
      return hasAny([/ברז גינה/, /גינה/, /חצר/, /מתקן חוץ/, /חיצוני/]) ? 1 : 0;
    case "grounding":
      return hasAny([/הארקה/, /מוליך הארקה/, /השוואת פוטנציאלים/, /\bpe\b/]) ? 1 : 0;
    case "rcd":
      return hasAny([/פחת/, /\brcd\b/, /ממסר פחת/]) ? 1 : 0;
    case "panels":
      return hasAny([/לוח/, /מפסק ראשי/, /מאמ\"ת|מאמת/, /מפסקים/]) ? 1 : 0;
    case "metering":
      return hasAny([/מונה/, /מונים/, /ריכוז מונים/, /ארון מונים/]) ? 1 : 0;
    case "medical":
      return hasAny([/רפואי/, /מרפאה/, /קליניקה/, /בית חולים/]) ? 1 : 0;
    default:
      return 0.5;
  }
}

const SEARCH_STOPWORDS = new Set([
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
  "האם",
  "יש",
  "ל",
]);

function extractSearchTokens(q: string): string[] {
  const tokens = normalizeHebrewText(q || "")
    .toLowerCase()
    .replace(/[^\u0590-\u05ffA-Za-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !SEARCH_STOPWORDS.has(t));
  const expanded = new Set<string>();
  for (const t of tokens) {
    expanded.add(t);
    const stripped = stripHebrewPrefix(t);
    expanded.add(stripped);
  }
  return Array.from(expanded).filter((t) => t.length >= 2);
}

async function fallbackLawChunkSearch(params: {
  supabase: any;
  question: string;
  limit?: number;
}): Promise<Hit[]> {
  const { supabase, question } = params;
  const limit = params.limit || 20;

  // 1) get legal sources only
  const { data: sourcesData, error: srcErr } = await supabase
    .from("sources")
    .select("id,title,url,publisher,doc_type")
    .or("doc_type.like.law_%,doc_type.like.regulation_%,doc_type.like.safety_%")
    .limit(200);
  if (srcErr || !sourcesData || sourcesData.length === 0) return [];

  const legalSources = sourcesData as SourceMeta[];
  const allowedLegalSources = legalSources.filter(
    (s) =>
      (isPrimaryLocalLawSource(s) || isGovernmentLawSource(s)) &&
      !isMaskedIndexSource({ title: s.title, url: s.url, docType: s.doc_type })
  );
  if (allowedLegalSources.length === 0) return [];
  const sourceById = new Map(allowedLegalSources.map((s) => [s.id, s]));
  const sourceIds = allowedLegalSources.map((s) => s.id);

  // 2) read chunks from legal sources
  const { data: chunksData, error: chunksErr } = await supabase
    .from("chunks")
    .select("source_id,section,locator,text")
    .in("source_id", sourceIds)
    .limit(6000);
  if (chunksErr || !chunksData || chunksData.length === 0) return [];

  const qNorm = normalizeHebrewText(question).toLowerCase();
  const qTokens = extractSearchTokens(question);
  const domain = detectDomainIntent(question);
  if (qTokens.length === 0 && !qNorm) return [];

  const scored: Hit[] = [];
  for (const row of chunksData as Array<{
    source_id: string;
    section: string | null;
    locator: any;
    text: string;
  }>) {
    const source = sourceById.get(row.source_id);
    if (!source) continue;

    const text = normalizeHebrewText(row.text || "");
    const hay = text.toLowerCase();
    const section = (row.section || "").toLowerCase();

    let score = 0;
    if (qNorm && hay.includes(qNorm)) score += 2.2;

    for (const t of qTokens) {
      if (hay.includes(t)) score += 0.55;
      if (section.includes(t)) score += 0.35;
      if (source.title.toLowerCase().includes(t)) score += 0.2;
    }

    // Boost the local official law PDF so it is used first for legal Q&A.
    if (isPrimaryLocalLawSource(source)) score += 1.4;

    const minScore = domain === "bathroom" || domain === "grounding" ? 0.55 : 0.9;
    if (score < minScore) continue;
    scored.push({
      source_title: source.title,
      source_url: source.url,
      section: row.section,
      locator: row.locator,
      text,
      rank: score,
    });
  }

  return dedupeHits(scored.sort((a, b) => b.rank - a.rank).slice(0, limit));
}

function tokenizeForScoring(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/[^\u0590-\u05ffA-Za-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function tokenOverlapScore(query: string, candidate: string): number {
  const qTokens = tokenizeForScoring(query);
  if (qTokens.length === 0) return 0;
  const cSet = new Set(tokenizeForScoring(candidate));
  let matched = 0;
  for (const t of qTokens) {
    if (cSet.has(t)) matched += 1;
  }
  return matched / qTokens.length;
}

function buildContextualQuestion(question: string, history: AskHistoryItem[]): string {
  const qRaw = (question || "").trim();
  const q = qRaw
    .replace(/^\s*זה\s+לא\s+הכוונה[,:]?\s*/i, "")
    .replace(/^\s*לא\s+הכוונה[,:]?\s*/i, "")
    .replace(/^\s*הכוונה\s+הייתה[,:]?\s*/i, "")
    .replace(/^\s*התכוונתי[,:]?\s*/i, "")
    .trim() || qRaw;
  const lastQ = history.length > 0 ? (history[history.length - 1]?.q || "").trim() : "";
  if (!lastQ) return q;

  const isCorrection =
    /(לא\s+הכוונה|הכוונה\s+הייתה|התכוונתי|זה\s+לא)/.test(qRaw);
  if (isCorrection) {
    // User corrected intent; do not drag previous context blindly.
    return q;
  }

  const isLikelyFollowUp =
    /^(ומה|ואם|ואיך|תסביר|תפרט|ועכשיו|לגבי|ומה לגבי)/.test(q) ||
    /\b(יותר|פחות|אותו|זה|זו)\b/.test(q);

  if (!isLikelyFollowUp) return q;
  return `${lastQ} ${q}`.trim();
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<AskResponse | AskDebugResponse | { error: string }>
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { question, scope, history } = req.body as {
    question?: string;
    scope?: ScopeMode;
    history?: AskHistoryItem[];
    issueType?: string;
  };
  const q = (question || "").trim();
  if (!q) {
    return res.status(400).json({ error: "Missing question" });
  }
  const normalizedQuestion = sanitizeUserQuestion(q);
  const selectedScope: ScopeMode = scope || "law_only";
  const safeHistory = Array.isArray(history) ? history.slice(-6) : [];
  const contextualQuestion = buildContextualQuestion(normalizedQuestion, safeHistory);
  const domainIntent = detectDomainIntent(contextualQuestion);

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    return res.status(500).json({ error: "Missing env: SUPABASE_URL" });
  }
  if (!service) {
    return res
      .status(500)
      .json({ error: "Missing env: SUPABASE_SERVICE_ROLE_KEY" });
  }

  const supabase = createClient(url, service, {
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

  let expandedQuery = contextualQuestion;
  for (const [hebrew, english] of Object.entries(queryExpansions)) {
    if (contextualQuestion.includes(hebrew)) {
      expandedQuery = `${contextualQuestion} ${english}`;
      break;
    }
  }

  let retrievalQuery = expandedQuery;
  const issueTypeRaw = String(req.body?.issueType || "").trim();
  const isEarthingIssueType = /הארקה|לולאת תקלה/i.test(issueTypeRaw);
  if (looksLikeEarthingOhmsQuestion(contextualQuestion) || (isEarthingIssueType && /אוהם|Ω|ohm|התנגדות/i.test(contextualQuestion))) {
    retrievalQuery = `${expandedQuery} התנגדות אוהם Ω RA R_A Zs לולאת תקלה ערך מותר`;
  }

  const queryVariants = buildExpandedQueries(retrievalQuery);
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

  let hits = dedupeHits(collectedHits);

  // Fallback: if RPC misses simple questions, scan legal chunks directly.
  if (!hits || hits.length === 0) {
    const fallbackHits = await fallbackLawChunkSearch({
      supabase,
      question: contextualQuestion,
      limit: 20,
    });
    hits = fallbackHits;
  }

  if (!hits || hits.length === 0) {
    return res.status(200).json({
      bottomLine:
        "לא מצאתי במאגר המקוון קטעים רלוונטיים מספיק. נסה ניסוח אחר או נוסיף מקורות נוספים.",
      steps: [],
      cautions: [],
      requiredInfo: ["סוג מתקן", "מתח", "נקודת מדידה / ערך מדידה"],
      followUpQuestion:
        "כדי לדייק: על איזה סוג מתקן/סביבה אתה שואל (למשל אמבטיה, לוח, הארקה, אתר רפואי)?",
      sources: [],
      confidence: "low",
    });
  }

  // Get source metadata for re-ranking
  const sourceTitles = [...new Set(hits.map((h) => h.source_title).filter(Boolean))];
  const sourceDocTypes: Record<string, string> = {};
  const sourcePublishers: Record<string, string> = {};
  const sourceUrls: Record<string, string> = {};

  if (sourceTitles.length > 0) {
    const { data: sourcesData } = await supabase
      .from("sources")
      .select("title, doc_type, publisher, url")
      .in("title", sourceTitles);

    if (sourcesData) {
      for (const s of sourcesData) {
        sourceDocTypes[s.title] = s.doc_type || "";
        sourcePublishers[s.title] = s.publisher || "";
        sourceUrls[s.title] = s.url || "";
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
  const isMedicalIntent = /(רפואי|בית\s*חולים|מרפאה|קליניקה)/i.test(q);
  const isBathroomIntent = /(אמבטיה|מקלחת|חדר רחצה|רטוב)/i.test(q);

  // Sort hits so that laws/regulations and official sources are first, suppliers last.
  const getPriorityForHit = (h: Hit): number => {
    const docType = (sourceDocTypes[h.source_title] || "").toLowerCase();
    const publisher = (sourcePublishers[h.source_title] || "").toLowerCase();
    const url = (h.source_url || "").toLowerCase();
    if (
      isPrimaryLocalLawSource({
        title: h.source_title,
        publisher,
        url,
      })
    ) {
      return -1;
    }

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
    const sourceBoostA = isPrimaryLocalLawSource({
      title: a.source_title,
      publisher: sourcePublishers[a.source_title],
      url: a.source_url,
    })
      ? 1
      : 0;
    const sourceBoostB = isPrimaryLocalLawSource({
      title: b.source_title,
      publisher: sourcePublishers[b.source_title],
      url: b.source_url,
    })
      ? 1
      : 0;

    // First sort by priority (lower is better), then by rank
    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }
    if (sourceBoostA !== sourceBoostB) {
      return sourceBoostB - sourceBoostA;
    }
    return (b.rank || 0) - (a.rank || 0);
  });

  // Hard filter policy requested by user:
  // 1) local WORD/PDF law file first
  // 2) then governmental sources only
  // 3) never private websites in final answer.
  rankedHits = rankedHits.filter((h) => {
    const publisher = sourcePublishers[h.source_title] || "";
    const metaUrl = sourceUrls[h.source_title] || h.source_url || "";
    const docType = sourceDocTypes[h.source_title] || "";
    return (
      (isPrimaryLocalLawSource({
        title: h.source_title,
        publisher,
        url: metaUrl,
      }) ||
        isGovernmentLawSource({
          publisher,
          url: metaUrl,
        })) &&
      !isMaskedIndexSource({ title: h.source_title, url: metaUrl, docType })
    );
  });

  // Electricity-only safety net: never answer from generic non-electric gov pages.
  rankedHits = rankedHits.filter((h) =>
    isElectricityLegalHit({
      source_title: h.source_title,
      source_url: sourceUrls[h.source_title] || h.source_url || "",
      section: h.section,
      text: h.text,
    })
  );

  // Drop corrupted text chunks (encoding garbage) from retrieval.
  rankedHits = rankedHits.filter((h) => !hasMojibakeNoise(h.text || ""));

  // Remove legally-valid but contextually unrelated hits (e.g. medical/pool for residential grounding).
  const contextFiltered = rankedHits.filter(
    (h) =>
      !isUnrelatedContextForQuery({
        question: contextualQuestion,
        domainIntent,
        hit: h,
      })
  );
  if (contextFiltered.length > 0) rankedHits = contextFiltered;

  // Require strong intent matches for common legal domains to keep answers precise.
  const strongIntentHits = rankedHits.filter((h) =>
    strongIntentMatch(contextualQuestion, h, domainIntent)
  );
  if (strongIntentHits.length > 0) rankedHits = strongIntentHits;

  // Unless user asked for supplier/catalog info explicitly, hide catalog hits when better sources exist
  if (!isCatalogIntent) {
    const nonCatalog = rankedHits.filter((h) => getPriorityForHit(h) <= 2);
    if (nonCatalog.length > 0) rankedHits = nonCatalog;
  }

  // Domain intent focus: keep hits relevant to detected domain when possible.
  if (domainIntent !== "general") {
    const domainHits = rankedHits
      .map((h) => ({ h, s: domainRelevanceScore(domainIntent, h) }))
      .filter((x) => x.s >= 1)
      .map((x) => x.h);
    if (domainHits.length > 0) rankedHits = domainHits;
  }

  // Unless question is explicitly medical, suppress "אתרים רפואיים" sources.
  if (!isMedicalIntent) {
    rankedHits = rankedHits.filter(
      (h) => !/(רפואי|אתרי רפואיים|מרפאה|קליניקה)/i.test(h.source_title || "")
    );
  }

  // Scope mode from UI
  if (selectedScope === "law_only") {
    const legalOnly = rankedHits.filter((h) => getPriorityForHit(h) <= 0);
    rankedHits = legalOnly;
  } else if (selectedScope === "law_plus_utility") {
    rankedHits = rankedHits.filter((h) => getPriorityForHit(h) <= 1);
  }

  // If strict scope filtering removed everything, run legal fallback again.
  if (rankedHits.length === 0 && (selectedScope === "law_only" || !isUtilityIntent)) {
    const fallbackHits = await fallbackLawChunkSearch({
      supabase,
      question: contextualQuestion,
      limit: 25,
    });
    let nextHits = fallbackHits;
    if (!isMedicalIntent) {
      nextHits = nextHits.filter(
        (h) => !/(רפואי|אתרי רפואיים|מרפאה|קליניקה)/i.test(h.source_title || "")
      );
    }
    if (nextHits.length > 0) rankedHits = nextHits;
  }

  // If this is not a utility-specific question and we have legal hits,
  // force legal sources to dominate the final answer.
  if (!isUtilityIntent) {
    const legalOnly = rankedHits.filter((h) => getPriorityForHit(h) <= 0);
    if (legalOnly.length > 0) rankedHits = legalOnly;
  }

  // One more safety net for simple legal questions.
  if (rankedHits.length === 0 && !isUtilityIntent) {
    const fallbackHits = await fallbackLawChunkSearch({
      supabase,
      question: q,
      limit: 25,
    });
    let nextHits = fallbackHits;
    if (!isMedicalIntent) {
      nextHits = nextHits.filter(
        (h) => !/(רפואי|אתרי רפואיים|מרפאה|קליניקה)/i.test(h.source_title || "")
      );
    }
    if (nextHits.length > 0) rankedHits = nextHits;
  }

  // If still nothing relevant for bathroom context, return focused clarification
  // instead of unrelated legal text.
  if (rankedHits.length === 0 && isBathroomIntent && !isMedicalIntent) {
    return res.status(200).json({
      bottomLine:
        "לא מצאתי כרגע במאגר החוקי קטע ברור מספיק על 'אמבטיה' בהקשר שביקשת.",
      steps: [],
      cautions: ["כדי לא להטעות, נדרש מיקוד קצר לפני הנחיה מעשית."],
      requiredInfo: ["סוג המתקן", "מה בדיוק נדרש: מרחק/שקע/הגנה"],
      followUpQuestion:
        "בחר הקשר: בית מגורים / אתר רפואי / מתקן אחר, ומה בדיוק נדרש: מרחק, סוג שקע, או דרישת הגנה.",
      sources: [],
      confidence: "low",
    });
  }

  // Filter out only extremely broken extraction chunks.
  const isReadableHit = (raw: string): boolean => {
    const text = raw || "";
    if (!text.trim()) return false;

    const controlChars = (text.match(/[\u0000-\u001F\u007F-\u009F]/g) || [])
      .length;
    const replacementChars = (text.match(/�/g) || []).length;
    const length = Math.max(text.length, 1);
    const noiseRatio = (controlChars + replacementChars) / length;

    // Keep OCR-heavy legal text unless it is severely corrupted.
    if (controlChars >= 60) return false;
    if (noiseRatio > 0.08) return false;
    if (hasMojibakeNoise(text)) return false;

    return true;
  };

  const readableHits = rankedHits.filter((h) => isReadableHit(h.text || ""));
  if (readableHits.length > 0) rankedHits = readableHits;

  // Hard rule: if question is not utility-specific, never answer from utility-only hits.
  if (!isUtilityIntent) {
    const legalHits = rankedHits.filter((h) => getPriorityForHit(h) <= 0);
    if (legalHits.length > 0) {
      rankedHits = legalHits;
    } else {
      return res.status(200).json({
        bottomLine:
          'לא מצאתי במאגר החוקי קטעים רלוונטיים מספיק לשאלה זו. נסה ניסוח ממוקד יותר (למשל: "מרחק מאמבטיה לפי תקנות") או עדכן מקורות חוק/תקנות נוספים.',
        steps: [],
        cautions: [],
        requiredInfo: ["סוג המתקן", "מתח", "פרטי המקרה המדויקים"],
        followUpQuestion:
          "כדי למקד: באיזה הקשר מדובר — בית מגורים, אתר רפואי, או מתקן אחר?",
        sources: [],
        confidence: "low",
      });
    }
  }

  // Prefer cleaner and more diverse hits (avoid multiple near-identical menu pages).
  const sortedByQuality = [...rankedHits].sort((a, b) => {
    const qa = noiseScore(a.text || "");
    const qb = noiseScore(b.text || "");
    if (qa !== qb) return qa - qb;
    const overlapA = tokenOverlapScore(contextualQuestion, a.text || "");
    const overlapB = tokenOverlapScore(contextualQuestion, b.text || "");
    if (overlapA !== overlapB) return overlapB - overlapA;
    const domainA = domainRelevanceScore(domainIntent, a);
    const domainB = domainRelevanceScore(domainIntent, b);
    if (domainA !== domainB) return domainB - domainA;
    const contextA = contextMatchBoost(contextualQuestion, a);
    const contextB = contextMatchBoost(contextualQuestion, b);
    if (contextA !== contextB) return contextB - contextA;
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
    title: isMaskedIndexSource({
      title: h.source_title,
      url: sourceUrls[h.source_title] || h.source_url || "",
      docType: sourceDocTypes[h.source_title] || "",
    })
      ? PRIMARY_LAW_DISPLAY_TITLE
      : h.source_title,
    section:
      h.section && !/^chunk\s+\d+/i.test(h.section)
        ? h.section
        : "קטע רלוונטי",
    text: shortSnippet(cleanAnswerText(h.text || ""), 320),
    url: isMaskedIndexSource({
      title: h.source_title,
      url: sourceUrls[h.source_title] || h.source_url || "",
      docType: sourceDocTypes[h.source_title] || "",
    })
      ? PRIMARY_LAW_DISPLAY_URL
      : h.source_url || undefined,
  }));

  const sources: AskSource[] = top.map((h) => ({
    title: isMaskedIndexSource({
      title: h.source_title,
      url: sourceUrls[h.source_title] || h.source_url || "",
      docType: sourceDocTypes[h.source_title] || "",
    })
      ? PRIMARY_LAW_DISPLAY_TITLE
      : h.source_title,
    section: h.section || "ללא סעיף",
    url: isMaskedIndexSource({
      title: h.source_title,
      url: sourceUrls[h.source_title] || h.source_url || "",
      docType: sourceDocTypes[h.source_title] || "",
    })
      ? PRIMARY_LAW_DISPLAY_URL
      : h.source_url || undefined,
  }));

  const allSourcesText = segments
    .map((x) => `${x.title}\n${x.section}\n${x.text || ""}`)
    .join("\n---\n");

  if (looksLikeEarthingOhmsQuestion(q)) {
    const ok = sourcesContainAny(allSourcesText, [
      /אוהם|Ω|ohm/i,
      /התנגדות/i,
      /R_A|RA\b/i,
      /Zs\b|לולאת תקלה/i,
    ]);

    if (!ok) {
      return res.status(200).json({
        bottomLine:
          "אין לי במקורות שהוחזרו סעיף שמדבר על התנגדות הארקה באוהם, אז לא ניתן לקבוע תקינות מתוך המסמכים כרגע.",
        steps: [],
        cautions: [
          "אל תסתמך על תשובה בלי סעיף/מקור מתאים. חשמל הוא תחום מסכן חיים.",
        ],
        requiredInfo: [
          "מה בדיוק נמדד: התנגדות אלקטרודת הארקה (R_A) או לולאת תקלה (Zs) או רציפות PE",
          "שיטת האיפוס (TT/TN) אם ידוע",
          "איפה נמדד (לוח ראשי/תת-לוח/נקודת קצה) ובאיזה מכשיר/מצב בדיקה",
        ],
        followUpQuestion:
          "מה בדיוק נמדד: R_A של האלקטרודה, Zs (לולאת תקלה), או רציפות מוליך PE? ואיפה מדדת?",
        sources: [],
        confidence: "low",
      });
    }
  }

  const confidence =
    rankedHits[0].rank >= 1.2
      ? "high"
      : rankedHits[0].rank >= 0.7
        ? "medium"
        : "low";

  const llmResult = await generateConversationalAnswer({
    question: q,
    contextualQuestion,
    issueType: issueTypeRaw,
    history: safeHistory,
    segments,
    sources,
    confidence,
  });

  const fallback = buildFallbackConversationalAnswer({
    question: q,
    segments,
    confidence,
    sources,
  });

  const responsePayload: AskResponse = llmResult || fallback;
  const DEBUG = process.env.DEBUG_RAG === "1";

  if (DEBUG) {
    return res.status(200).json({
      ...responsePayload,
      debug: {
        retrievedTitles: sources.map((s) => ({
          title: s.title,
          section: s.section,
        })),
        retrievedSnippets: segments.map((s) => ({
          title: s.title,
          section: s.section,
          snippet: (s.text || "").slice(0, 240),
        })),
      },
    });
  }

  return res.status(200).json({
    bottomLine: responsePayload.bottomLine,
    steps: responsePayload.steps || [],
    cautions: responsePayload.cautions || [],
    requiredInfo: responsePayload.requiredInfo || undefined,
    followUpQuestion: responsePayload.followUpQuestion || undefined,
    sources: responsePayload.sources || [],
    confidence: responsePayload.confidence || "low",
  });
}

