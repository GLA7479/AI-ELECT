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

function buildQueryVariants(q: string): string[] {
  const base = sanitize(q);
  const variants = new Set<string>();
  variants.add(base);
  variants.add(`${base} תקנות החשמל`);
  variants.add(`${base} חוק החשמל`);
  variants.add(`${base} לפי תקנות`);
  // light synonym boost (keep small)
  if (/(מקלח|מקלחת|אמבט|חדר רחצה|רטוב|אזורים)/i.test(base)) {
    variants.add(`${base} אזור 0 אזור 1 אזור 2`);
  }
  if (/(הארקה|איפוס|tt|tn|zs|ra|פחת|rcd)/i.test(base)) {
    variants.add(`${base} TT TN Zs RA RCD IΔn`);
  }
  return Array.from(variants).slice(0, 6);
}

function tokenOverlapScore(query: string, candidate: string): number {
  const qTokens = (sanitize(query).toLowerCase().match(/[\u0590-\u05ffA-Za-z0-9]{2,}/g) || []);
  if (!qTokens.length) return 0;
  const cSet = new Set((sanitize(candidate).toLowerCase().match(/[\u0590-\u05ffA-Za-z0-9]{2,}/g) || []));
  let matched = 0;
  for (const t of qTokens) if (cSet.has(t)) matched++;
  return matched / qTokens.length;
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
    if (error) return res.status(500).json({ error: `search_chunks failed: ${error.message}` });
    collected.push(...((data || []) as Hit[]));
  }

  // Dedupe quickly
  const seen = new Set<string>();
  let hits = collected.filter((h) => {
    const key = `${h.source_title}||${h.section || ""}||${(h.text || "").slice(0, 120)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

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

  // Rerank: prefer overlap with question + existing rank
  hits.sort((a, b) => {
    const oa = tokenOverlapScore(question, a.text || "");
    const ob = tokenOverlapScore(question, b.text || "");
    if (oa !== ob) return ob - oa;
    return (b.rank || 0) - (a.rank || 0);
  });

  const top = hits.slice(0, 5);

  const context = top.map((h) => ({
    title: h.source_title,
    section: h.section || "ללא סעיף",
    text: normalizeHebrewText(h.text || "").slice(0, 900),
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
  if (!apiKey) return res.status(500).json({ error: "Missing OPENAI_API_KEY" });

  try {
    const answer = await llmAnswer({ apiKey, model, question, context, sources, conversation: convo });
    answer.chatState = { ...(chatState || {}), lastUserQuestion: question };
    return res.status(200).json(answer);
  } catch (e: any) {
    return res.status(200).json({
      kind: "rag",
      title: "חוק ותקנות",
      bottomLine: "מצאתי מקורות, אבל לא הצלחתי לנסח תשובה כרגע. הנה המקורות כדי שתוכל לפתוח אותם.",
      steps: [],
      cautions: ["לפני עבודה בשטח—פועלים לפי תקנות/תקנים ונהלי בטיחות."],
      sources,
      followUpQuestion: "אם תרצה—כתוב מה בדיוק אתה רוצה לדעת/לאשר ואדייק על בסיס המקורות.",
      confidence: "low",
      chatState: { ...(chatState || {}), lastUserQuestion: question },
    });
  }
}
