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
  followUpQuestion?: string;
};

type ScopeMode = "law_only" | "law_plus_utility" | "all";

type AskHistoryItem = {
  q: string;
  createdAt?: string;
};

function shortSnippet(text: string, max = 260): string {
  const t = cleanAnswerText(text || "");
  if (t.length <= max) return t;
  return `${t.slice(0, max).trim()}...`;
}

function buildFallbackConversationalAnswer(params: {
  question: string;
  scope: ScopeMode;
  segments: AnswerSegment[];
}): { answer: string; followUpQuestion?: string } {
  const { question, scope, segments } = params;
  if (!segments.length) {
    return {
      answer:
        "לא מצאתי כרגע מקור חוקי מספיק מדויק לשאלה הזו. אפשר לנסח שאלה ממוקדת יותר לפי תקנה/סעיף או לפי סוג מתקן.",
      followUpQuestion:
        "כדי לדייק: מדובר במבנה מגורים, אתר רפואי, או מתקן תעשייתי?",
    };
  }

  const scopeLabel =
    scope === "law_only"
      ? "חוק ותקנות בלבד"
      : scope === "law_plus_utility"
        ? "חוק/תקנות + הנחיות מעגל"
        : "כל המקורות";

  const points = segments.slice(0, 3).map((s) => {
    const line = shortSnippet(s.text, 180);
    return `- ${s.section}: ${line}`;
  });

  return {
    answer:
      `לפי המקורות שבדקתי (${scopeLabel}), זו התמונה לשאלה "${question}":\n\n` +
      `${points.join("\n")}\n\n` +
      "אם תרצה, אנסח לך עכשיו תשובה מעשית לפי תרחיש מדויק (סוג מבנה/מתח/סביבת התקנה).",
    followUpQuestion:
      "כדי לדייק לפעולה בשטח: מה סוג המתקן ומה המתח הרלוונטי?",
  };
}

async function generateConversationalAnswer(params: {
  question: string;
  contextualQuestion: string;
  scope: ScopeMode;
  history: AskHistoryItem[];
  segments: AnswerSegment[];
}): Promise<{ answer: string; followUpQuestion?: string } | null> {
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

  const systemPrompt = [
    "אתה עוזר מקצועי לחשמלאים בישראל.",
    "ענה בעברית ברורה, אנושית, קצרה ומעשית.",
    "הבסס אך ורק על המקורות שסופקו. אין להמציא תקנות או סעיפים.",
    "אם חסר מידע עובדתי במקורות - אמור זאת מפורשות ובקש הבהרה ממוקדת.",
    "סגנון: יועץ מקצועי, לא העתקה רובוטית.",
    "מבנה תשובה:",
    "1) כותרת קצרה: 'בשורה התחתונה'",
    "2) 3-6 נקודות מעשיות",
    "3) שורת 'מקורות עיקריים' עם 1-3 סעיפים/כותרות",
    "4) אם צריך: 'שאלת הבהרה' אחת קצרה",
  ].join("\n");

  const userPrompt = [
    `שאלה נוכחית: ${params.question}`,
    `שאלה קונטקסטואלית לחיפוש: ${params.contextualQuestion}`,
    `מצב מיקוד: ${params.scope}`,
    historyText ? `היסטוריית שיחה אחרונה:\n${historyText}` : "",
    `מקורות:\n${contextBlocks}`,
    "תן תשובה מקצועית וקריאה. אל תצטט טקסט ארוך כמות שהוא.",
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
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const answer = data.choices?.[0]?.message?.content?.trim();
    if (!answer) return null;

    const followUpMatch = answer.match(/שאלת הבהרה[:：]\s*(.+)$/m);
    return {
      answer,
      followUpQuestion: followUpMatch?.[1]?.trim(),
    };
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
    {
      re: /אמבטיה|מקלחת|חדר רחצה|רטוב/i,
      add: ["אמבטיה", "מקלחת", "חדר רחצה", "הגנה מפני חישמול", "מרחקי בטיחות"],
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
    q.length <= 35 ||
    /^(ומה|ואם|ואיך|תסביר|תפרט|ועכשיו|לגבי|ומה לגבי)/.test(q) ||
    /\b(יותר|פחות|אותו|זה|זו)\b/.test(q);

  if (!isLikelyFollowUp) return q;
  return `${lastQ} ${q}`.trim();
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<AskResponse | { error: string }>
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { question, scope, history } = req.body as {
    question?: string;
    scope?: ScopeMode;
    history?: AskHistoryItem[];
  };
  const q = (question || "").trim();
  if (!q) {
    return res.status(400).json({ error: "Missing question" });
  }
  const selectedScope: ScopeMode = scope || "law_only";
  const safeHistory = Array.isArray(history) ? history.slice(-6) : [];
  const contextualQuestion = buildContextualQuestion(q, safeHistory);

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

  let expandedQuery = contextualQuestion;
  for (const [hebrew, english] of Object.entries(queryExpansions)) {
    if (contextualQuestion.includes(hebrew)) {
      expandedQuery = `${contextualQuestion} ${english}`;
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
      followUpQuestion:
        "כדי לדייק: על איזה סוג מתקן/סביבה אתה שואל (למשל אמבטיה, לוח, הארקה, אתר רפואי)?",
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
  const isMedicalIntent = /(רפואי|בית\s*חולים|מרפאה|קליניקה)/i.test(q);

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

  // Unless question is explicitly medical, suppress "אתרים רפואיים" sources.
  if (!isMedicalIntent) {
    const nonMedical = rankedHits.filter(
      (h) => !/(רפואי|אתרי רפואיים|מרפאה|קליניקה)/i.test(h.source_title || "")
    );
    if (nonMedical.length > 0) rankedHits = nonMedical;
  }

  // Scope mode from UI
  if (selectedScope === "law_only") {
    const legalOnly = rankedHits.filter((h) => getPriorityForHit(h) === 0);
    rankedHits = legalOnly;
  } else if (selectedScope === "law_plus_utility") {
    rankedHits = rankedHits.filter((h) => getPriorityForHit(h) <= 1);
  }

  // If this is not a utility-specific question and we have legal hits,
  // force legal sources to dominate the final answer.
  if (!isUtilityIntent) {
    const legalOnly = rankedHits.filter((h) => getPriorityForHit(h) === 0);
    if (legalOnly.length > 0) rankedHits = legalOnly;
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

    return true;
  };

  const readableHits = rankedHits.filter((h) => isReadableHit(h.text || ""));
  if (readableHits.length > 0) rankedHits = readableHits;

  // Hard rule: if question is not utility-specific, never answer from utility-only hits.
  if (!isUtilityIntent) {
    const legalHits = rankedHits.filter((h) => getPriorityForHit(h) === 0);
    if (legalHits.length > 0) {
      rankedHits = legalHits;
    } else {
      return res.status(200).json({
        mode: "online",
        confidence: "low",
        answer:
          'לא מצאתי במאגר החוקי קטעים רלוונטיים מספיק לשאלה זו. נסה ניסוח ממוקד יותר (למשל: "מרחק מאמבטיה לפי תקנות") או עדכן מקורות חוק/תקנות נוספים.',
        citations: [],
        segments: [],
        followUpQuestion:
          "כדי למקד: באיזה הקשר מדובר — בית מגורים, אתר רפואי, או מתקן אחר?",
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

  const llmResult = await generateConversationalAnswer({
    question: q,
    contextualQuestion,
    scope: selectedScope,
    history: safeHistory,
    segments,
  });

  const fallback = buildFallbackConversationalAnswer({
    question: q,
    scope: selectedScope,
    segments,
  });

  const answer = llmResult?.answer || fallback.answer;
  const followUpQuestion = llmResult?.followUpQuestion || fallback.followUpQuestion;

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
    followUpQuestion,
  });
}

