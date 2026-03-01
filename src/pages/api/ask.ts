// pages/api/ask.ts
import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { normalizeHebrewText } from "../../../lib/normalizeHebrewText";

type ScopeMode = "law_only" | "law_plus_utility" | "all";

type SourceRef = { title: string; section: string; url?: string };
type Answer = {
  kind: "rag";
  title: string;
  bottomLine: string;
  steps: string[];
  cautions: string[];
  sources: SourceRef[];
  followUpQuestion?: string;
  confidence: "high" | "medium" | "low";
  chatState?: any;
};

type Hit = {
  source_title: string;
  source_url: string | null;
  section: string | null;
  locator: any;
  text: string;
  rank: number;
};

const SYSTEM = `
You are a professional assistant for electricians in Israel.
You must answer ONLY using the provided sources (Hebrew PDFs: law/regulations/guidance).
Give a fast, concrete answer in Hebrew (2-6 short bullet points), then provide sources (title + section).
Do NOT paste raw excerpts. Paraphrase rules.
Ask at most ONE optional follow-up question ONLY if needed to be more precise.
If sources are insufficient, say so briefly and ask ONE clarifying question (optional).
Do NOT provide step-by-step field procedures; keep it legal/regulatory.
Return ONLY valid JSON matching the schema.
`;

function sanitize(input: string) {
  let q = normalizeHebrewText(input || "");
  q = q.replace(/["'`)\]}»"]+$/g, "").trim();
  q = q.replace(/[!?.,;:]{2,}/g, (m) => m.slice(0, 1));
  return q;
}

// Extract key terms from query (max 20 chars each)
function extractKeyTerms(q: string): string[] {
  const t = sanitize(q);
  const terms: string[] = [];
  
  // Extract Hebrew words (2+ chars)
  const hebrewWords = t.match(/[\u0590-\u05ff]{2,}/g) || [];
  terms.push(...hebrewWords);
  
  // Extract technical terms
  const techTerms = t.match(/\b(zs|ra|tt|tn|rcd|iΔn|פחת|מאמ"ת|נתיך|אוהם|ω|ohm)\b/gi) || [];
  terms.push(...techTerms.map(x => x.toLowerCase()));
  
  // Extract numbers with units
  const numUnits = t.match(/\d+\s*(אמפר|אום|ω|ma|v|kw|kva)/gi) || [];
  terms.push(...numUnits);
  
  // Special handling for zone questions
  if (/(מקלח|מקלחת|אמבט|חדר רחצה|אזורים)/i.test(t)) {
    terms.push("אזור 0", "אזור 1", "אזור 2", "מקלחת", "אמבט");
  }
  
  // Remove duplicates and keep only short terms (max 20 chars)
  return Array.from(new Set(terms))
    .filter(x => x.length > 0 && x.length <= 20)
    .slice(0, 8);
}

function buildQueryVariants(q: string): string[] {
  const base = sanitize(q);
  const variants = new Set<string>();
  
  // If query is long (>40 chars), break into key terms
  if (base.length > 40) {
    const keyTerms = extractKeyTerms(base);
    // Add individual terms
    keyTerms.forEach(term => variants.add(term));
    // Add 2-3 word combinations
    for (let i = 0; i < Math.min(keyTerms.length, 3); i++) {
      for (let j = i + 1; j < Math.min(keyTerms.length, i + 3); j++) {
        variants.add(`${keyTerms[i]} ${keyTerms[j]}`);
      }
    }
  } else {
    // Short query: use as-is + variants
    variants.add(base);
    variants.add(`${base} תקנות החשמל`);
    variants.add(`${base} חוק החשמל`);
  }
  
  // Domain-specific boosts (keep short)
  if (/(מקלח|מקלחת|אמבט|חדר רחצה|אזורים)/i.test(base)) {
    variants.add("אזור 0");
    variants.add("אזור 1");
    variants.add("אזור 2");
    variants.add("מקלחת");
    variants.add("אמבט");
  }
  if (/(הארקה|איפוס|tt|tn|zs|ra|פחת|rcd)/i.test(base)) {
    variants.add("TT");
    variants.add("TN");
    variants.add("Zs");
    variants.add("RA");
    variants.add("RCD");
  }
  
  // Filter: keep only queries <= 30 chars (safe for search_chunks)
  return Array.from(variants)
    .filter(v => v.length > 0 && v.length <= 30)
    .slice(0, 10);
}

function tokenOverlapScore(query: string, candidate: string): number {
  const qTokens = (sanitize(query).toLowerCase().match(/[\u0590-\u05ffA-Za-z0-9]{2,}/g) || []);
  if (!qTokens.length) return 0;
  const cSet = new Set((sanitize(candidate).toLowerCase().match(/[\u0590-\u05ffA-Za-z0-9]{2,}/g) || []));
  let matched = 0;
  for (const t of qTokens) if (cSet.has(t)) matched++;
  return matched / qTokens.length;
}

// Filter out junk snippets (page references, medical contexts, etc.)
function isJunkSnippet(text: string, question: string): boolean {
  const s = normalizeHebrewText(text || "").trim();
  if (!s || s.length < 10) return true;
  
  // Page references like "ר' ... עמ' 716" or "עמ' 716"
  if (/^ר[’']?\s*[^\u0590-\u05ff]*עמ[’']?\s*\d+/.test(s)) return true;
  if (/^עמ[’']?\s*\d+/.test(s) && s.length < 50) return true;
  
  // Medical contexts (unless question asks for medical)
  const qNorm = normalizeHebrewText(question).toLowerCase();
  const userAskedMedical = /(רפואי|בית\s*חולים|מרפאה|קליניקה|מטופל|אתר\s*רפואי)/i.test(qNorm);
  if (!userAskedMedical) {
    if (/פסיכיאטריה|EEG|EMG|ECT|אתר\s*רפואי|מטופל|חדר\s*ניתוח/i.test(s)) return true;
  }
  
  // Just symbols/numbers without meaningful Hebrew words
  const hebrewWords = s.match(/[\u0590-\u05ff]{2,}/g) || [];
  if (hebrewWords.length < 2 && s.length > 20) return true;
  
  // Lines starting with "++" or similar markers
  if (/^\+{2,}/.test(s)) return true;
  
  // Just a list of standards/codes without explanation
  if (/^(din|iec|iso|en|bs|ansi|ul|vde|ת"י)\s*[\d\s\/,]+$/i.test(s)) return true;
  
  return false;
}

// Check if text looks like page header/metadata only
function looksLikePageHeaderOnly(text: string): boolean {
  const s = normalizeHebrewText(text || "").trim();
  if (!s) return true;
  // Headers/references without content
  if (/ר\s*[’']?\s*ב/i.test(s) && /עמ[’']?\s*\d+/.test(s) && s.length < 80) return true;
  // Many + signs or table without words
  if (/^\+{2,}/.test(s.trim())) return true;
  // Just page numbers and metadata
  if (/^רשומות|^עמ[’']?\s*\d+/.test(s) && s.length < 100) return true;
  return false;
}

// Expand hits with neighbor chunks (context window)
async function expandWithNeighborChunks(
  supabase: any,
  top: Hit[],
  windowSize = 1 // 1 => prev+current+next
): Promise<Hit[]> {
  const expanded: Hit[] = [];
  const seenKeys = new Set<string>();
  
  for (const h of top) {
    const srcTitle = h.source_title;
    const idxRaw = h.locator?.chunk_index ?? h.locator?.chunk ?? null;
    const idx = Number(idxRaw);
    
    // If no chunk_index, just add the original hit
    if (!Number.isFinite(idx) || idx < 0) {
      const key = `${srcTitle}||${h.section || ""}||${(h.text || "").slice(0, 120)}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        expanded.push(h);
      }
      continue;
    }

    // Get source_id to fetch neighbors
    const { data: srcRow } = await supabase
      .from("sources")
      .select("id, title, url")
      .eq("title", srcTitle)
      .maybeSingle();

    if (!srcRow?.id) {
      const key = `${srcTitle}||${h.section || ""}||${(h.text || "").slice(0, 120)}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        expanded.push(h);
      }
      continue;
    }

    // Fetch neighbor chunks
    const minIdx = Math.max(0, idx - windowSize);
    const maxIdx = idx + windowSize;

    const { data: neigh } = await supabase
      .from("chunks")
      .select("section, locator, text, chunk_index")
      .eq("source_id", srcRow.id)
      .gte("chunk_index", minIdx)
      .lte("chunk_index", maxIdx)
      .order("chunk_index", { ascending: true });

    if (Array.isArray(neigh) && neigh.length) {
      for (const n of neigh) {
        const key = `${srcRow.title}||${n.section || ""}||${(n.text || "").slice(0, 120)}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        
        expanded.push({
          source_title: srcRow.title,
          source_url: srcRow.url,
          section: n.section || h.section || `Chunk ${n.chunk_index}`,
          locator: { ...(n.locator || {}), chunk_index: n.chunk_index },
          text: n.text || "",
          rank: h.rank, // Keep rank of primary hit
        } as Hit);
      }
    } else {
      const key = `${srcTitle}||${h.section || ""}||${(h.text || "").slice(0, 120)}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        expanded.push(h);
      }
    }
  }
  return expanded;
}

async function llmAnswer(params: {
  apiKey: string;
  model: string;
  question: string;
  context: { title: string; section: string; text: string; url?: string }[];
  sources: SourceRef[];
  conversation: { role: "user" | "assistant"; content: string }[];
}): Promise<Answer> {
  const ctxBlocks = params.context
    .slice(0, 5)
    .map((c, i) => `SOURCE ${i + 1}\nTITLE: ${c.title}\nSECTION: ${c.section}\nTEXT: ${c.text}`)
    .join("\n\n");

  const user = `
QUESTION: ${params.question}

RECENT CHAT (last 6):
${params.conversation.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n")}

SOURCES:
${ctxBlocks}

CITATIONS (use only these in sources list):
${JSON.stringify(params.sources)}
`;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${params.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: params.model,
      temperature: 0.1,
      max_tokens: 650,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!resp.ok) throw new Error(`OpenAI error: ${resp.status}`);
  const data = await resp.json();
  const txt = data?.choices?.[0]?.message?.content?.trim();
  if (!txt) throw new Error("Empty model response");
  return JSON.parse(txt) as Answer;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Answer | { error: string }>) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { message, question: questionParam, scope, chatState, messages } = req.body as {
    message?: string;
    question?: string;
    scope?: ScopeMode;
    chatState?: any;
    messages?: Array<{ role: "user" | "assistant"; content: string }>;
  };

  const question = sanitize(message || questionParam || "");
  if (!question) return res.status(400).json({ error: "Missing message" });

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) return res.status(500).json({ error: "Missing Supabase env" });

  const supabase = createClient(url, service, { auth: { persistSession: false } });

  const selectedScope: ScopeMode = scope || "law_only";
  const variants = buildQueryVariants(question);

  const collected: Hit[] = [];
  for (const qv of variants) {
    const { data, error } = await supabase.rpc("search_chunks", { q: qv, k: 16 });
    if (error) {
      console.warn(`search_chunks failed for "${qv}": ${error.message}`);
      continue; // Skip failed queries, continue with others
    }
    if (data && Array.isArray(data)) {
      collected.push(...(data as Hit[]));
    }
  }

  // Dedupe quickly
  const seen = new Set<string>();
  let hits = collected.filter((h) => {
    const key = `${h.source_title}||${h.section || ""}||${(h.text || "").slice(0, 120)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // FALLBACK: If no results from search_chunks, try ILIKE text search
  if (hits.length === 0) {
    const keyTerms = extractKeyTerms(question);
    if (keyTerms.length > 0) {
      // Build ILIKE query using Supabase .or() syntax
      const ilikeFilters = keyTerms.slice(0, 5).map(term => `text.ilike.%${term}%`);
      
      const { data: ilikeData, error: ilikeError } = await supabase
        .from("chunks")
        .select("source_id, section, locator, text")
        .or(ilikeFilters.join(","))
        .limit(50);

      if (!ilikeError && ilikeData && ilikeData.length > 0) {
        // Fetch source titles for ILIKE results
        const sourceIds = [...new Set(ilikeData.map((c: any) => c.source_id))];
        const { data: sourcesData } = await supabase
          .from("sources")
          .select("id, title, url")
          .in("id", sourceIds);

        const sourceMap = new Map((sourcesData || []).map((s: any) => [s.id, s]));

        // Convert ILIKE results to Hit format
        hits = ilikeData.map((c: any) => {
          const source = sourceMap.get(c.source_id);
          return {
            source_title: source?.title || "Unknown",
            source_url: source?.url || null,
            section: c.section || null,
            locator: c.locator || null,
            text: c.text || "",
            rank: 0.5, // Lower rank for ILIKE results
          } as Hit;
        });
      }
    }
  }

  // Fetch meta for filtering
  const titles = [...new Set(hits.map((h) => h.source_title))];
  const sourceMeta: Record<string, { doc_type: string; publisher: string; url: string }> = {};
  if (titles.length) {
    const { data } = await supabase.from("sources").select("title,doc_type,publisher,url").in("title", titles);
    for (const s of data || []) {
      sourceMeta[s.title] = { doc_type: s.doc_type || "", publisher: s.publisher || "", url: s.url || "" };
    }
  }

  // Filter to law/regulation/guidance only (your PDFs)
  hits = hits.filter((h) => {
    const m = sourceMeta[h.source_title];
    if (!m) return false;
    const dt = (m.doc_type || "").toLowerCase();
    if (selectedScope === "law_only") {
      return dt.startsWith("law_") || dt.startsWith("regulation_") || dt.startsWith("safety_") || dt.startsWith("guidance_");
    }
    return true;
  });

  if (!hits.length) {
    return res.status(200).json({
      kind: "rag",
      title: "חוק ותקנות",
      bottomLine: "לא מצאתי במאגר סעיף רלוונטי מספיק לשאלה הזו.",
      steps: [],
      cautions: ["לפני עבודה בשטח—פועלים לפי תקנות/תקנים ונהלי בטיחות."],
      followUpQuestion: "כדי לדייק (אופציונלי): באיזה הקשר מדובר ומה בדיוק אתה רוצה לדעת/לאשר?",
      sources: [],
      confidence: "low",
      chatState: { ...(chatState || {}), lastUserQuestion: question },
    });
  }

  // CONTEXT FILTERING: Remove irrelevant medical/industrial contexts unless explicitly asked
  const qNorm = normalizeHebrewText(question).toLowerCase();
  const userAskedMedical = /(רפואי|בית\s*חולים|מרפאה|קליניקה|מטופל|אתר\s*רפואי)/i.test(qNorm);
  const userAskedIndustrial = /(תעשייתי|מפעל|חקלאי|בריכה|אתר\s*בניה|ארעי)/i.test(qNorm);

  // HARD BLOCK: Remove medical contexts unless user asked for medical
  if (!userAskedMedical) {
    hits = hits.filter((h) => {
      const hay = normalizeHebrewText(`${h.source_title || ""} ${h.section || ""} ${h.text || ""}`).toLowerCase();
      const isMedical = /(אתר\s*רפואי|אתרים\s*רפואיים|מטופל|חדר\s*ניתוח|ecg|eeg|emg|ect|פסיכיאטריה|טיפול\s*נמרץ|מכשיר\s*רפואי)/i.test(hay);
      return !isMedical;
    });
  }

  // FILTER JUNK SNIPPETS: Remove page references, medical contexts, and meaningless snippets
  hits = hits.filter((h) => {
    const snippet = normalizeHebrewText(h.text || "").trim();
    if (isJunkSnippet(snippet, question)) return false;
    if (looksLikePageHeaderOnly(snippet)) return false;
    return true;
  });

  // CONTEXT PREFERENCE: If not specified, prefer residential context (90% of questions)
  const assumeResidential = !userAskedMedical && !userAskedIndustrial;

  // Rerank: prefer overlap with question + existing rank + context preference
  hits.sort((a, b) => {
    // PRIORITY 1: Prefer חוק החשמל (Electricity Law) over all other sources
    const aIsLaw = /חוק[\s-]?החשמל/i.test(a.source_title || "");
    const bIsLaw = /חוק[\s-]?החשמל/i.test(b.source_title || "");
    if (aIsLaw && !bIsLaw) return -1; // a comes first
    if (!aIsLaw && bIsLaw) return 1;  // b comes first
    
    // PRIORITY 2: context preference (residential boost)
    if (assumeResidential) {
      const ha = normalizeHebrewText(`${a.source_title} ${a.section} ${a.text}`).toLowerCase();
      const hb = normalizeHebrewText(`${b.source_title} ${b.section} ${b.text}`).toLowerCase();
      const ba = /(דירתי|דירה|מגורים|בניין|לוח\s*דירתי|מיתקן\s*דירתי)/i.test(ha) ? 1 : 0;
      const bb = /(דירתי|דירה|מגורים|בניין|לוח\s*דירתי|מיתקן\s*דירתי)/i.test(hb) ? 1 : 0;
      if (ba !== bb) return bb - ba; // Prefer residential
    }

    // PRIORITY 3: token overlap with question
    const oa = tokenOverlapScore(question, a.text || "");
    const ob = tokenOverlapScore(question, b.text || "");
    if (oa !== ob) return ob - oa;

    // PRIORITY 4: original rank
    return (b.rank || 0) - (a.rank || 0);
  });

  // Select top 2 primary hits, then expand with neighbor chunks for context
  const topPrimary = hits.slice(0, 2);
  
  // Expand with neighbor chunks (context window)
  const topExpanded = await expandWithNeighborChunks(supabase, topPrimary, 1);
  
  // Filter expanded chunks to remove junk and dedupe
  const topFiltered = topExpanded.filter((h) => {
    const snippet = normalizeHebrewText(h.text || "").trim();
    if (isJunkSnippet(snippet, question)) return false;
    if (looksLikePageHeaderOnly(snippet)) return false;
    return true;
  });
  
  // Dedupe and take top 4-5
  const seenTop = new Set<string>();
  const top = topFiltered.filter((h) => {
    const key = `${h.source_title}||${h.section || ""}||${(h.text || "").slice(0, 120)}`;
    if (seenTop.has(key)) return false;
    seenTop.add(key);
    return true;
  }).slice(0, 5);

  const context = top.map((h) => ({
    title: h.source_title,
    section: h.section || "ללא סעיף",
    text: normalizeHebrewText(h.text || "").slice(0, 1400), // Increased from 900 to 1400
    url: h.source_url || sourceMeta[h.source_title]?.url || undefined,
  }));

  const sources: SourceRef[] = top.map((h) => ({
    title: h.source_title,
    section: h.section || "ללא סעיף",
    url: h.source_url || sourceMeta[h.source_title]?.url || undefined,
  }));

  // Build recent conversation (keep short)
  const convo = Array.isArray(messages) ? messages.slice(-6) : [];

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  // If OpenAI key is available, use LLM for better phrasing
  if (apiKey) {
    try {
      const answer = await llmAnswer({ apiKey, model, question, context, sources, conversation: convo });
      answer.chatState = { ...(chatState || {}), lastUserQuestion: question };
      return res.status(200).json(answer);
    } catch (e: any) {
      console.warn("LLM call failed, using fallback:", e.message);
      // Fall through to fallback below
    }
  }

  // FALLBACK: Build answer directly from sources without LLM
  // This allows the system to work 100% without OpenAI API key
  const summaryLines: string[] = [];
  const seenSections = new Set<string>();

  for (const ctx of context.slice(0, 3)) {
    if (seenSections.has(ctx.section)) continue;
    seenSections.add(ctx.section);
    
    // Extract key sentence from context (first meaningful sentence)
    const text = normalizeHebrewText(ctx.text).trim();
    
    // Skip junk snippets
    if (isJunkSnippet(text, question)) continue;
    
    // Find first meaningful sentence (not just page refs or standards list)
    const sentences = text.split(/[.!?]\s+/);
    let firstSentence = "";
    for (const sent of sentences) {
      const clean = sent.trim();
      if (clean.length < 20) continue;
      if (isJunkSnippet(clean, question)) continue;
      firstSentence = clean;
      break;
    }
    
    // If no good sentence found, try first 200 chars
    if (!firstSentence) {
      firstSentence = text.slice(0, 200).trim();
      if (isJunkSnippet(firstSentence, question)) continue;
    }
    
    if (firstSentence.length > 20 && firstSentence.length < 300) {
      // Clean up: remove section prefix if present, keep only the meaningful text
      const cleanSentence = firstSentence.replace(/^[^\u0590-\u05ff]*[\u0590-\u05ff]+\s*[:\-]\s*/, "").trim();
      if (cleanSentence.length > 20 && !isJunkSnippet(cleanSentence, question)) {
        summaryLines.push(cleanSentence);
      }
    }
  }

  const bottomLine = summaryLines.length > 0
    ? summaryLines[0]
    : `מצאתי ${sources.length} מקור${sources.length > 1 ? "ות" : ""} רלוונטי${sources.length > 1 ? "ים" : ""} לשאלה שלך.`;

  const steps = summaryLines.slice(1, 3); // Max 2 additional sentences, no bullet points

  // Determine confidence based on source quality
  let confidence: "high" | "medium" | "low" = "medium";
  if (sources.length >= 3 && top.some(h => (h.rank || 0) > 0.5)) {
    confidence = "high";
  } else if (sources.length === 0) {
    confidence = "low";
  }

  // Optional follow-up question if confidence is low
  const followUpQuestion = confidence === "low" && sources.length > 0
    ? "כדי לדייק (אופציונלי): באיזה הקשר מדובר ומה בדיוק אתה רוצה לדעת/לאשר?"
    : undefined;

  return res.status(200).json({
    kind: "rag",
    title: "חוק ותקנות",
    bottomLine,
    steps,
    cautions: ["לפני עבודה בשטח—פועלים לפי תקנות/תקנים ונהלי בטיחות."],
    sources,
    followUpQuestion,
    confidence,
    chatState: { ...(chatState || {}), lastUserQuestion: question },
  });
}
