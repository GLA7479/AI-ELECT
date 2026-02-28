import type { NextApiRequest, NextApiResponse } from "next";
import { createClient } from "@supabase/supabase-js";
import { normalizeHebrewText } from "../../../lib/normalizeHebrewText";
import type { Answer, SourceRef } from "../../types/answer";
import { runEngine } from "../../lib/engine";
import type { ChatMessage, ChatState, ChatTopic, PendingSlot } from "../../types/chat";

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

const TECHNICAL_QUERY_TERMS =
  /(zs|ra|פחת|אמפר|כבל|חתך|נפילת מתח|מאמ"?ת|נתיך|tt|tn|אוהם|ω|rcd|לולאת תקלה|הארקה|מפסק)/i;

// ===== PARSERS FOR USER ANSWERS =====

function parseOhms(text: string): number | null {
  const s = (text || "").replace(/,/g, ".").toLowerCase();
  const m = s.match(/(\d+(\.\d+)?)/);
  if (!m) return null;
  if (!(s.includes("אום") || s.includes("ω") || s.includes("ohm") || s.includes("אוהם"))) return null;
  return Number(m[1]);
}

function parseAmpsOnly(text: string): number | null {
  const s = normalizeHebrewText(text || "").trim().replace(/,/g, ".");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n > 1000) return null;
  return n;
}

function parseMeasurementType(text: string): "RA" | "ZS" | "PE" | null {
  const t = normalizeHebrewText(text || "").toLowerCase();
  if (/ra|r_a|אלקטרוד|אלקטרודה/.test(t)) return "RA";
  if (/zs|לולאת תקלה|לולאה/.test(t)) return "ZS";
  if (/pe|רציפות/.test(t)) return "PE";
  return null;
}

function parseSystem(text: string): "TT" | "TN" | "UNKNOWN" | null {
  const t = normalizeHebrewText(text || "").toLowerCase();
  if (/\btt\b/.test(t)) return "TT";
  if (/\btn\b/.test(t)) return "TN";
  if (/לא יודע|לא ידוע|unknown/.test(t)) return "UNKNOWN";
  return null;
}

function parseRcd(text: string): 30 | 100 | 300 | null | undefined {
  const t = normalizeHebrewText(text || "").toLowerCase();
  if (/30/.test(t)) return 30;
  if (/100/.test(t)) return 100;
  if (/300/.test(t)) return 300;
  if (/אין|ללא/.test(t)) return null;
  return undefined;
}

// ===== SLOT FILLING LOGIC =====

function applyPendingAnswer(state: ChatState, userText: string): boolean {
  const t = userText.trim();

  // Always capture ohms if present (even if no pendingSlot)
  const ohm = parseOhms(t);
  if (ohm != null) {
    state.slots.value_ohm = ohm;
  }

  if (!state.pendingSlot) return false;

  if (state.pendingSlot === "measurement_type") {
    const parsed = parseMeasurementType(t);
    if (parsed) {
      state.slots.measurement_type = parsed;
      state.pendingSlot = undefined;
      return true;
    }
  }

  if (state.pendingSlot === "system") {
    const parsed = parseSystem(t);
    if (parsed) {
      state.slots.system = parsed;
      state.pendingSlot = undefined;
      return true;
    }
  }

  if (state.pendingSlot === "rcd") {
    const parsed = parseRcd(t);
    if (parsed !== undefined) {
      state.slots.rcd_ma = parsed;
      state.pendingSlot = undefined;
      return true;
    }
  }

  if (state.pendingSlot === "protection") {
    const parsed = parseProtection(t);
    if (parsed) {
      // If we had "?16" and now got "C16", replace it
      if (typeof state.slots.protection === "string" && /^\?\d+$/.test(state.slots.protection)) {
        // If parsed is just amps again, keep the "?16" format
        if (/^\?\d+$/.test(parsed)) {
          // Still just amps, keep it
          state.slots.protection = parsed;
        } else {
          // Got full protection type (e.g. "C16"), replace "?16"
          state.slots.protection = parsed;
        }
      } else {
        state.slots.protection = parsed;
      }
      state.pendingSlot = undefined;
      return true;
    }
  }

  if (state.pendingSlot === "voltage") {
    const parsed = parseVoltage(t);
    if (parsed) {
      state.slots.voltage = parsed;
      state.pendingSlot = undefined;
      return true;
    }
  }

  return false;
}

function nextEarthingQuestion(state: ChatState): Answer | null {
  const { slots } = state;

  // Missing measurement type
  if (!slots.measurement_type) {
    state.pendingSlot = "measurement_type";
    return {
      kind: "flow",
      title: "הארקה / לולאת תקלה",
      bottomLine: "כדי לקבוע 'ערך הארקה תקין' צריך לדעת מה בדיוק נמדד.",
      steps: [],
      requiredInfo: ["מה נמדד: RA / Zs / רציפות PE"],
      followUpQuestion: "מה נמדד: RA (אלקטרודה), Zs (לולאת תקלה) או רציפות PE?",
      cautions: [],
      sources: [],
      confidence: "low",
    };
  }

  // If user provided ohms but didn't tell system
  if (!slots.system || slots.system === "UNKNOWN") {
    state.pendingSlot = "system";
    return {
      kind: "flow",
      title: "הארקה / לולאת תקלה",
      bottomLine: "כדי לקבוע תקינות צריך לדעת שיטת איפוס (TT/TN).",
      steps: [],
      requiredInfo: ["שיטת איפוס: TT / TN"],
      followUpQuestion: "האם זו רשת TT או TN? (אם לא יודע — כתוב 'לא יודע')",
      cautions: [],
      sources: [],
      confidence: "low",
    };
  }

  // If TT and RA, ask RCD
  if (slots.measurement_type === "RA" && slots.system === "TT" && slots.rcd_ma == null) {
    state.pendingSlot = "rcd";
    return {
      kind: "flow",
      title: "הארקה / לולאת תקלה",
      bottomLine: "ב-TT הערכת תקינות RA תלויה בזרם הפחת (IΔn).",
      steps: [],
      requiredInfo: ["זרם פחת: 30mA / 100mA / 300mA / אין"],
      followUpQuestion: "איזה פחת מותקן? 30mA / 100mA / 300mA / אין",
      cautions: [],
      sources: [],
      confidence: "low",
    };
  }

  state.pendingSlot = undefined;
  return null;
}

function parseProtection(text: string): string | null {
  const t = normalizeHebrewText(text || "").toLowerCase();

  // C16 / B20 / D10
  const m1 = t.match(/\b([bcd])\s*(\d+)\b/i);
  if (m1) return `${m1[1].toUpperCase()}${m1[2]}`;

  // "מאמ"ת C16"
  const m2 = t.match(/מאמ"?ת\s*([bcd])\s*(\d+)/i);
  if (m2) return `${m2[1].toUpperCase()}${m2[2]}`;

  // "נתיך 16" / "fuse 16"
  const m3 = t.match(/נתיך\s*(\d+)/i) || t.match(/fuse\s*(\d+)/i);
  if (m3) return `נתיך ${m3[1]}`;

  // JUST "16" -> store as unknown type with amps
  const amps = parseAmpsOnly(t);
  if (amps != null) return `?${amps}`;

  return null;
}

function parseVoltage(text: string): 230 | 400 | null {
  const t = normalizeHebrewText(text || "").toLowerCase();
  if (/230|220|חד\s*פאזי|single/i.test(t)) return 230;
  if (/400|380|תלת\s*פאזי|three|3\s*phase/i.test(t)) return 400;
  return null;
}

function nextLoopFaultQuestion(state: ChatState): Answer | null {
  const { slots } = state;

  // Missing system
  if (!slots.system || slots.system === "UNKNOWN") {
    state.pendingSlot = "system";
    return {
      kind: "flow",
      title: "לולאת תקלה (Zs)",
      bottomLine: "כדי לחשב/לבדוק Zs צריך לדעת שיטת איפוס.",
      steps: [],
      requiredInfo: ["שיטת איפוס: TT / TN"],
      followUpQuestion: "זה TT או TN?",
      cautions: [],
      sources: [],
      confidence: "low",
    };
  }

  // If user gave only amps (e.g. "16") and we stored "?16" -> ask only for type/curve
  if (typeof slots.protection === "string" && /^\?\d+$/.test(slots.protection)) {
    const amps = Number(slots.protection.slice(1));
    state.pendingSlot = "protection"; // נשאר אותו slot, אבל עכשיו מחכים ל-B/C/D/נתיך
    return {
      kind: "flow",
      title: "לולאת תקלה (Zs)",
      bottomLine: `קיבלתי ${amps}A. חסר רק סוג ההגנה כדי להמשיך.`,
      steps: [],
      requiredInfo: ['סוג הגנה: מאמ"ת B/C/D או נתיך'],
      followUpQuestion: `זה מאמ"ת B${amps}/C${amps}/D${amps} או נתיך ${amps}? אם לא יודע—בדירות לרוב זה C.`,
      cautions: [],
      sources: [],
      confidence: "high",
    };
  }

  // Missing protection
  if (!slots.protection) {
    state.pendingSlot = "protection";
    return {
      kind: "flow",
      title: "לולאת תקלה (Zs)",
      bottomLine: "כדי לחשב Zs מקסימלי צריך לדעת סוג ההגנה והזרם הנקוב.",
      steps: [],
      requiredInfo: ['סוג הגנה: מאמ"ת B/C/D או נתיך'],
      followUpQuestion: 'איזה מאמ"ת? (B/C/D והזרם, למשל C16) או נתיך (למשל נתיך 16)',
      cautions: [],
      sources: [],
      confidence: "low",
    };
  }

  // Missing voltage
  if (!slots.voltage) {
    state.pendingSlot = "voltage";
    return {
      kind: "flow",
      title: "לולאת תקלה (Zs)",
      bottomLine: "כדי לחשב Zs מקסימלי צריך לדעת מתח רשת.",
      steps: [],
      requiredInfo: ["מתח רשת: 230V או 400V"],
      followUpQuestion: "230V או 400V?",
      cautions: [],
      sources: [],
      confidence: "low",
    };
  }

  state.pendingSlot = undefined;
  return null;
}

// ===== COMMAND HANDLER FOR SHORT WORDS =====

type ShortCommand = "calc" | "source" | "explain" | "continue" | "ok" | null;

function detectShortCommand(question: string): ShortCommand {
  const shortCmd = normalizeHebrewText(question || "").trim();
  if (shortCmd.length > 15) return null;

  const isCalcCmd = /^(חישוב|תחשב|תחשבי|calculate|calc)$/i.test(shortCmd);
  const isSourceCmd = /^(מקור|ציטוט|סעיף|source|cite)$/i.test(shortCmd);
  const isExplainCmd = /^(הסבר|תסביר|explain)$/i.test(shortCmd);
  const isOkCmd = /^(אוקיי|סבבה|ok|יאללה|continue|תמשיך|אז|אז\?)$/i.test(shortCmd);

  if (isCalcCmd) return "calc";
  if (isSourceCmd) return "source";
  if (isExplainCmd) return "explain";
  if (isOkCmd) return "continue";
  return null;
}

function handleShortCommand(
  cmd: ShortCommand,
  state: ChatState,
  question: string
): Answer | null {
  if (!cmd || !state.topic) return null;

  if (state.topic === "loop_fault") {
    if (cmd === "calc") {
      // Start slot filling for Zs calculation
      const nextQ = nextLoopFaultQuestion(state);
      if (nextQ) {
        return {
          ...nextQ,
          bottomLine: "מעולה, נחשב Zs מקסימלי. " + nextQ.bottomLine,
        };
      }
      // All slots filled - can proceed to calculation
      return {
        kind: "flow",
        title: "חישוב Zs מקסימלי",
        bottomLine: `לפי הנתונים: ${state.slots.system}, ${state.slots.protection}, ${state.slots.voltage}V.`,
        steps: [
          "Zs מקסימלי מחושב לפי: Zs = Uo / Ia",
          `כאשר Uo = ${state.slots.voltage}V (מתח פאזה-אדמה)`,
          `ו-Ia הוא זרם הניתוק של ההגנה לפי סוג (B/C/D) וזרם נקוב`,
          "יש לבדוק מול טבלאות תקן או מפרטי יצרן את Ia המדויק",
        ],
        requiredInfo: ["יש לבדוק את Ia המדויק מהטבלאות/מפרטי יצרן"],
        followUpQuestion: "רוצה מקור מהתקנות?",
        cautions: ["חישוב זה הוא אומדן. יש לבדוק מול תקן/יצרן לפני עבודה."],
        sources: [],
        confidence: "medium",
      };
    }
    if (cmd === "source") {
      return {
        kind: "rag",
        title: "מקור — לולאת תקלה",
        bottomLine: "מחפש מקורות בתקנות על Zs (לולאת תקלה)...",
        steps: [],
        requiredInfo: ["מחפש מקורות רלוונטיים..."],
        followUpQuestion: "רוצה חישוב או רק מקור?",
        cautions: [],
        sources: [],
        confidence: "low",
      };
    }
    if (cmd === "explain") {
      return {
        kind: "flow",
        title: "הסבר — לולאת תקלה",
        bottomLine:
          "Zs (לולאת תקלה) היא האימפדנס של מסלול התקלה (פאזה→תקלה→PE/PEN/אדמה→מקור), שמשפיע על זרם התקלה וזמן הניתוק של ההגנה.",
        steps: [
          "אם המטרה היא תקין/לא תקין: משווים לדרישת זמן ניתוק של ההגנה לפי סוג הרשת (TN/TT).",
          "ב-TT עם RCD, לרוב בודקים גם RA×IΔn מול מתח מגע מותר.",
          "כדי לחשב Zs מקסימלי צריך: סוג הגנה (B/C/D/נתיך), זרם נקוב, מתח וזמן ניתוק יעד.",
        ],
        requiredInfo: [],
        followUpQuestion: "רוצה חישוב או מקור מהתקנות?",
        cautions: [],
        sources: [],
        confidence: "high",
      };
    }
    if (cmd === "continue") {
      const nextQ = nextLoopFaultQuestion(state);
      if (nextQ) return nextQ;
      return {
        kind: "flow",
        title: "לולאת תקלה",
        bottomLine: "מה תרצה לעשות? חישוב, מקור, או הסבר נוסף?",
        steps: [],
        requiredInfo: [],
        followUpQuestion: "כתוב: חישוב / מקור / הסבר",
        cautions: [],
        sources: [],
        confidence: "high",
      };
    }
  }

  if (state.topic === "earthing") {
    if (cmd === "calc") {
      const nextQ = nextEarthingQuestion(state);
      if (nextQ) {
        return {
          ...nextQ,
          bottomLine: "מעולה, נחשב. " + nextQ.bottomLine,
        };
      }
      // All slots filled - can provide answer
      return {
        kind: "flow",
        title: "חישוב ערך הארקה",
        bottomLine: `לפי הנתונים: ${state.slots.measurement_type}, ${state.slots.system}, ${state.slots.value_ohm ? state.slots.value_ohm + "Ω" : "לא נמדד"}.`,
        steps: [
          "יש לבדוק מול תקנות את הערך המותר לפי סוג המדידה והרשת",
          state.slots.system === "TT" && state.slots.rcd_ma
            ? `ב-TT עם פחת ${state.slots.rcd_ma}mA, יש לבדוק RA×IΔn מול מתח מגע מותר`
            : "",
        ].filter(Boolean),
        requiredInfo: ["יש לבדוק מול תקנות את הערך המותר המדויק"],
        followUpQuestion: "רוצה מקור מהתקנות?",
        cautions: ["חישוב זה הוא אומדן. יש לבדוק מול תקן לפני עבודה."],
        sources: [],
        confidence: "medium",
      };
    }
    if (cmd === "source") {
      return {
        kind: "rag",
        title: "מקור — הארקה",
        bottomLine: "מחפש מקורות בתקנות על ערכי הארקה...",
        steps: [],
        requiredInfo: ["מחפש מקורות רלוונטיים..."],
        followUpQuestion: "רוצה חישוב או רק מקור?",
        cautions: [],
        sources: [],
        confidence: "low",
      };
    }
    if (cmd === "explain") {
      return {
        kind: "flow",
        title: "הסבר — הארקה",
        bottomLine: "ערך הארקה תלוי בסוג המדידה (RA/Zs/PE) ובשיטת האיפוס (TT/TN).",
        steps: [
          "RA = התנגדות אלקטרודת הארקה (רלוונטי ל-TT)",
          "Zs = לולאת תקלה (רלוונטי ל-TN)",
          "רציפות PE = בדיקה אחרת לגמרי",
        ],
        requiredInfo: [],
        followUpQuestion: "רוצה חישוב או מקור מהתקנות?",
        cautions: [],
        sources: [],
        confidence: "high",
      };
    }
    if (cmd === "continue") {
      const nextQ = nextEarthingQuestion(state);
      if (nextQ) return nextQ;
      return {
        kind: "flow",
        title: "הארקה",
        bottomLine: "מה תרצה לעשות? חישוב, מקור, או הסבר נוסף?",
        steps: [],
        requiredInfo: [],
        followUpQuestion: "כתוב: חישוב / מקור / הסבר",
        cautions: [],
        sources: [],
        confidence: "high",
      };
    }
  }

  return null;
}

function normalizeChatState(raw: any): ChatState {
  const base: ChatState = {
    topic: "general",
    stage: "collecting",
    slots: {},
  };
  if (!raw || typeof raw !== "object") return base;
  return {
    topic: raw.topic || base.topic,
    stage: raw.stage || base.stage,
    pendingSlot: raw.pendingSlot || undefined,
    slots: raw.slots && typeof raw.slots === "object" ? raw.slots : {},
    pendingQuestion: typeof raw.pendingQuestion === "string" ? raw.pendingQuestion : undefined,
    lastSummary: typeof raw.lastSummary === "string" ? raw.lastSummary : undefined,
  };
}

function topicFromIssueType(issueType?: string): ChatTopic | null {
  const t = normalizeHebrewText(issueType || "");
  if (!t) return null;
  if (/לולאת תקלה/i.test(t)) return "loop_fault";
  if (/הארקה/i.test(t)) return "earthing";
  if (/פחת|rcd/i.test(t)) return "rcd";
  if (/חימום כבלים|כבל|עומס/i.test(t)) return "cable";
  if (/לוח חשמל|פאזה/i.test(t)) return "general";
  return null;
}

function detectChatTopic(question: string, current: ChatTopic | undefined): ChatTopic {
  const q = normalizeHebrewText(question || "");
  if (/(לולאת תקלה|\bzs\b|fault loop)/i.test(q)) return "loop_fault";
  if (/(הארקה|ra|r_a|אלקטרודה|השוואת פוטנציאלים)/i.test(q)) return "earthing";
  if (/(פחת|rcd|fid|ממסר)/i.test(q)) return "rcd";
  if (/(כבל|חתך|נפילת מתח|vd%|זרם מותר)/i.test(q)) return "cable";
  if (/(אין חשמל|אין מתח|לא מגיע מתח|נפל)/i.test(q)) return "general";
  return current || "general";
}

function isShortFollowupQuestion(question: string): boolean {
  const q = normalizeHebrewText(question || "").trim();
  return q.length <= 25 && !TECHNICAL_QUERY_TERMS.test(q);
}

function buildTopicClarifyAnswer(topic: ChatTopic): Answer {
  if (topic === "loop_fault") {
    return {
      kind: "flow",
      title: "שאלת הבהרה",
      bottomLine: "כדי להשוות צריך לדעת בין מה למה.",
      steps: [],
      requiredInfo: ["מה שני הדברים להשוואה"],
      followUpQuestion:
        'בין מה למה תרצה להשוות? למשל: Zs (לולאת תקלה) מול RA (אלקטרודה), או TT מול TN, או מאמ"ת B16 מול C16.',
      cautions: [],
      sources: [],
      confidence: "high",
    };
  }
  if (topic === "earthing") {
    return {
      kind: "flow",
      title: "שאלת הבהרה",
      bottomLine: "כדי לתת תשובה מדויקת צריך לדעת מה בדיוק להשוות או לבדוק.",
      steps: [],
      requiredInfo: ["האם מדובר ב-RA / Zs / רציפות PE", "מה סוג הרשת TT/TN"],
      followUpQuestion:
        "תכתוב בדיוק מה נמדד ומה תרצה להשוות (למשל RA מול ערך יעד, או TT מול TN).",
      cautions: [],
      sources: [],
      confidence: "high",
    };
  }
  return {
    kind: "flow",
    title: "שאלת הבהרה",
    bottomLine: "כדי להמשיך בשיחה צריך עוד פרט קצר.",
    steps: [],
    requiredInfo: ["מה בדיוק אתה רוצה שאבצע עכשיו"],
    followUpQuestion:
      "תכתוב במשפט קצר: מה הפעולה הבאה שאתה רוצה — השוואה, חישוב, או הסבר?",
    cautions: [],
    sources: [],
    confidence: "high",
  };
}

type AskDebugPayload = {
  retrievedTitles: Array<{ title: string; section: string }>;
  retrievedSnippets: Array<{ title: string; section: string; snippet: string }>;
};

type AskDebugResponse = Answer & {
  debug: AskDebugPayload;
};

const SYSTEM_JSON = `
You are a careful assistant for electricians in Israel.
Answer ONLY from the provided sources. If sources are insufficient, say so and ask for missing info.
Return ONLY valid JSON in this exact schema:

{
  "kind": "rag",
  "title": string,
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

function isEarthingValueQuestion(q: string) {
  const s = normalizeHebrewText(q || "");
  return /הארק|הארקה/i.test(s) && /(ערך|כמה|תקין|מותר|אוהם|Ω|ohm|התנגדות)/i.test(s);
}

function isLoopFaultQuestion(q: string) {
  const s = normalizeHebrewText(q || "");
  return /(לולאת תקלה|\bzs\b|fault loop)/i.test(s);
}

function isGlossaryLoopFaultQuestion(q: string) {
  const s = normalizeHebrewText(q || "").trim();
  const noPunct = s.replace(/[?؟.!]/g, "").trim();
  return noPunct.length <= 20 && /(לולאת תקלה|\bzs\b)/i.test(noPunct);
}

function hasEarthingMeasurementInfo(params: {
  question: string;
  flow?: any;
}): boolean {
  const q = normalizeHebrewText(params.question || "").toLowerCase();
  const flow = params.flow || {};
  const measured = String(flow.measuredType || flow.measurementType || "").toLowerCase();
  const system = String(flow.systemType || flow.earthingSystem || "").toLowerCase();
  const hasMeasured =
    /\b(ra|r_a|zs|pe)\b/.test(measured) || /(ra|r_a|zs|רציפות\s*pe|אלקטרוד)/i.test(q);
  const hasSystem = /\b(tt|tn)\b/.test(system) || /\b(tt|tn)\b/i.test(q);
  return hasMeasured && hasSystem;
}

function scoreChunkForEarthingValueQuestion(question: string, text: string): number {
  const q = normalizeHebrewText(question || "").toLowerCase();
  const s = normalizeHebrewText(text || "").toLowerCase();
  let score = 0;

  if (/הארק/.test(q)) {
    score += /(הארק|מוליך הארקה|השוואת פוטנציאלים|pe)/i.test(s) ? 2 : -2;
  }
  if (/(אוהם|ω|ohm|התנגדות)/i.test(q)) {
    score += /(אוהם|ω|ohm|התנגדות|ra|r_a|zs)/i.test(s) ? 5 : -5;
  }
  if (/(ra|r_a|zs|tt|tn|iδn|iδn|מפסק מגן|פחת|לולאת תקלה)/i.test(s)) score += 3;
  if (/(סוג ציוד|חיים מבודדים|בידוד בסיסי|בידוד כפול)/i.test(s)) score -= 3;
  if (/\d+(\.\d+)?\s*(ω|ohm|ma|%|שנ|sec|v)\b/i.test(s)) score += 2;

  return score;
}

function numericEvidenceExists(question: string, allSourcesText: string): boolean {
  const needsNumeric = /(ערך|כמה|תקין|מותר|לא יעלה|לכל היותר|אוהם|ω|ohm|%|ma|mA)/i.test(
    question || ""
  );
  if (!needsNumeric) return true;
  return (
    /(\d+(\.\d+)?)\s*(ω|ohm|ma|%|שנ|sec|v)\b/i.test(allSourcesText || "") ||
    /(לא יעלה על|לכל היותר|עד\b)/i.test(allSourcesText || "")
  );
}

function earthingTermEvidenceExists(allSourcesText: string): boolean {
  return /(אוהם|Ω|ohm|התנגדות|R_A|RA\b|Zs\b|לולאת תקלה|TT\b|TN\b|מפסק מגן|פחת|IΔn|iδn)/i.test(
    allSourcesText || ""
  );
}

function loopFaultEvidenceExists(allSourcesText: string): boolean {
  return /(לולאת תקלה|\bzs\b|fault loop|impedance|אימפדנס|התנגדות לולאה)/i.test(
    allSourcesText || ""
  );
}

function legalDocTier(docTypeRaw: string): number {
  const docType = (docTypeRaw || "").toLowerCase();
  if (docType.startsWith("regulation_") || docType.startsWith("safety_")) return 0;
  if (docType.startsWith("law_")) return 1;
  return 2;
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
  sources: SourceRef[];
}): Answer {
  const { question, segments, confidence, sources } = params;
  if (!segments.length) {
    return {
      kind: "rag",
      title: "חוק ותקנות",
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
    kind: "rag",
    title: "חוק ותקנות",
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
  sources: SourceRef[];
  confidence: "high" | "medium" | "low";
}): Promise<Answer | null> {
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
    const parsed = JSON.parse(modelText) as Answer;
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
const ELECTRIC_LAW_HINTS = [
  "חוק החשמל",
  "תקנות החשמל",
  "מינהל החשמל",
  "רשיונות חשמל",
  "רישוי חשמל",
  "הארקות יסוד",
  "מתקני חשמל",
  "בודק חשמל",
  "חשמלאי",
  'ת"י 019',
  'ת"י 60364',
  "iec 60364",
];

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

function isElectricLawish(title: string, url: string) {
  const t = (title || "").toLowerCase();
  const u = (url || "").toLowerCase();
  return ELECTRIC_LAW_HINTS.some(
    (k) => t.includes(k.toLowerCase()) || u.includes(k.toLowerCase())
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
  if (/(הארקה|מוליך הארקה|השוואת פוטנציאלים|\bpe\b|לולאת תקלה|\bzs\b)/.test(q))
    return "grounding";
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
      return hasAny([
        /הארקה/,
        /מוליך הארקה/,
        /השוואת פוטנציאלים/,
        /\bpe\b/,
        /לולאת תקלה/,
        /\bzs\b/,
        /fault loop/i,
      ])
        ? 1
        : 0;
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
  res: NextApiResponse<Answer | AskDebugResponse | { error: string }>
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { question, scope, history, modeHint = "auto", calc, flow } = req.body as {
    question?: string;
    scope?: ScopeMode;
    history?: AskHistoryItem[];
    issueType?: string;
    modeHint?: "auto" | "calc" | "flow" | "rag";
    calc?: any;
    flow?: any;
    conversationId?: string;
    messages?: ChatMessage[];
    chatState?: ChatState;
  };
  // Debug incoming payload to diagnose UI-side wrong question forwarding.
  // eslint-disable-next-line no-console
  console.log("[ASK payload]", JSON.stringify(req.body, null, 2));
  const q = (question || "").trim();
  if (!q) {
    return res.status(400).json({ error: "Missing question" });
  }
  const issueTypeRaw = String(req.body?.issueType || "").trim();
  const incomingState = normalizeChatState(req.body?.chatState);
  const topicByIssueType = topicFromIssueType(issueTypeRaw);
  const activeTopic = detectChatTopic(q, topicByIssueType || incomingState.topic);
  const hasActiveTopic = !!activeTopic && activeTopic !== "general";
  const baseChatState: ChatState = {
    ...incomingState,
    topic: activeTopic,
    stage: incomingState.stage || "collecting",
  };

  // ===== COMMAND HANDLER: Short words like "חישוב", "מקור", "הסבר" =====
  const shortCmd = detectShortCommand(q);
  if (shortCmd && hasActiveTopic && !baseChatState.pendingSlot) {
    const cmdAnswer = handleShortCommand(shortCmd, baseChatState, q);
    if (cmdAnswer) {
      return res.status(200).json({
        ...cmdAnswer,
        chatState: baseChatState,
      });
    }
  }

  // ===== SLOT FILLING: If there's a pending slot, treat user message as ANSWER, not new intent =====
  if (baseChatState.pendingSlot) {
    if (baseChatState.topic === "earthing") {
      const applied = applyPendingAnswer(baseChatState, q);
      if (applied) {
        // Slot was filled, now ask next question or provide answer
        const nextQ = nextEarthingQuestion(baseChatState);
        if (nextQ) {
          return res.status(200).json({
            ...nextQ,
            chatState: baseChatState,
          });
        }
        // All slots filled - continue to RAG/answer generation below
      } else {
        // Couldn't parse answer - ask again
        const retryQ = nextEarthingQuestion(baseChatState);
        if (retryQ) {
          return res.status(200).json({
            ...retryQ,
            chatState: baseChatState,
          });
        }
      }
    } else if (baseChatState.topic === "loop_fault") {
      const applied = applyPendingAnswer(baseChatState, q);
      if (applied) {
        // Slot was filled, now ask next question or provide answer
        const nextQ = nextLoopFaultQuestion(baseChatState);
        if (nextQ) {
          return res.status(200).json({
            ...nextQ,
            chatState: baseChatState,
          });
        }
        // All slots filled - continue to RAG/answer generation below
      } else {
        // Couldn't parse answer - ask again
        const retryQ = nextLoopFaultQuestion(baseChatState);
        if (retryQ) {
          return res.status(200).json({
            ...retryQ,
            chatState: baseChatState,
          });
        }
      }
    }
  }

  // ===== If no pending slot, check if we need to start slot filling for earthing =====
  if (baseChatState.topic === "earthing" && !baseChatState.pendingSlot) {
    const earthingValueIntent = isEarthingValueQuestion(q);
    if (earthingValueIntent) {
      const nextQ = nextEarthingQuestion(baseChatState);
      if (nextQ) {
        return res.status(200).json({
          ...nextQ,
          chatState: baseChatState,
        });
      }
    }
  }

  // ===== Short follow-up questions: only if NO pending slot and NO short command =====
  if (!baseChatState.pendingSlot && !shortCmd && isShortFollowupQuestion(q) && hasActiveTopic) {
    // אם יש שאלה תלויה קודמת – תתייחס לזה כתשובה לאותה שאלה (ולא "השוואה")
    if (baseChatState.pendingQuestion) {
      // תנסה לנתח כאילו היה pendingSlot הגיוני לפי topic
      // במקרה loop_fault: אם המשתמש כתב "TT"/"TN" או מספר או "C16" – זה תשובה
      const applied = applyPendingAnswer(baseChatState, q);
      if (applied) {
        const nextQ =
          baseChatState.topic === "loop_fault"
            ? nextLoopFaultQuestion(baseChatState)
            : baseChatState.topic === "earthing"
              ? nextEarthingQuestion(baseChatState)
              : null;

        if (nextQ) {
          return res.status(200).json({
            ...nextQ,
            chatState: baseChatState,
          });
        }
      }
    }

    // אחרת – הבהרה כללית (לא "השוואה")
    return res.status(200).json({
      kind: "flow",
      title: "שאלת הבהרה",
      bottomLine: "כדי להמשיך צריך פרט אחד קצר.",
      steps: [],
      requiredInfo: ["מה בדיוק אתה רוצה שאבצע עכשיו"],
      followUpQuestion: "כתוב בקצרה: חישוב / תקין? / מקור / הסבר",
      cautions: [],
      sources: [],
      confidence: "high",
      chatState: { ...baseChatState, stage: "collecting" },
    });
  }

  const engine = runEngine({
    question: q,
    modeHint,
    calc,
    flow,
  });
  if (engine.answer) {
    return res.status(200).json({
      ...engine.answer,
      chatState: {
        ...incomingState,
        topic: activeTopic,
        stage: "answering",
        pendingQuestion: undefined,
        lastSummary: engine.answer.bottomLine,
      },
    });
  }
  const normalizedQuestion = sanitizeUserQuestion(q);
  const selectedScope: ScopeMode = scope || "law_only";
  const safeHistory = Array.isArray(history) ? history.slice(-6) : [];
  const contextualQuestion = buildContextualQuestion(normalizedQuestion, safeHistory);
  const domainIntent = detectDomainIntent(contextualQuestion);
  const earthingValueIntent = isEarthingValueQuestion(contextualQuestion);
  const loopFaultIntent = isLoopFaultQuestion(contextualQuestion);

  if (isGlossaryLoopFaultQuestion(normalizedQuestion)) {
    return res.status(200).json({
      kind: "flow",
      title: "לולאת תקלה (Zs)",
      bottomLine:
        "Zs (לולאת תקלה) היא האימפדנס של מסלול התקלה (פאזה→תקלה→PE/PEN/אדמה→מקור), שמשפיע על זרם התקלה וזמן הניתוק של ההגנה.",
      steps: [
        "אם המטרה היא תקין/לא תקין: משווים לדרישת זמן ניתוק של ההגנה לפי סוג הרשת (TN/TT).",
        "ב-TT עם RCD, לרוב בודקים גם RA×IΔn מול מתח מגע מותר.",
        "כדי לחשב Zs מקסימלי צריך: סוג הגנה (B/C/D/נתיך), זרם נקוב, מתח וזמן ניתוק יעד.",
      ],
      requiredInfo: [
        "האם אתה רוצה הגדרה בלבד או חישוב",
        "סוג רשת: TT/TN",
        "סוג ההגנה והזרם הנקוב",
      ],
      followUpQuestion:
        'אתה רוצה הגדרה בלבד, או חישוב Zs מקסימלי? אם חישוב — מה סוג ההגנה (B/C/D/נתיך) והזרם הנקוב?',
      cautions: ["לא עובדים בלוח חי ללא הסמכה, ציוד מתאים ונהלי בטיחות."],
      sources: [],
      confidence: "high",
      chatState: {
        ...baseChatState,
        topic: "loop_fault",
        stage: "collecting",
        pendingQuestion:
          'אתה רוצה הגדרה בלבד, או חישוב Zs מקסימלי? אם חישוב — מה סוג ההגנה (B/C/D/נתיך) והזרם הנקוב?',
      },
    });
  }

  // Hard flow gate for "earthing value" questions:
  // avoid guessing from generic legal chunks when RA/Zs/PE context is missing.
  // NOTE: This is now handled by slot-filling above, but keeping as fallback for non-slot paths
  if (earthingValueIntent && !hasEarthingMeasurementInfo({ question: contextualQuestion, flow }) && !baseChatState.pendingSlot) {
    if (baseChatState.topic === "earthing") {
      const nextQ = nextEarthingQuestion(baseChatState);
      if (nextQ) {
        return res.status(200).json({
          ...nextQ,
          chatState: baseChatState,
        });
      }
    }
  }

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
  const isEarthingIssueType = /הארקה|לולאת תקלה/i.test(issueTypeRaw);
  if (
    earthingValueIntent ||
    looksLikeEarthingOhmsQuestion(contextualQuestion) ||
    (isEarthingIssueType && /אוהם|Ω|ohm|התנגדות/i.test(contextualQuestion))
  ) {
    retrievalQuery = `${expandedQuery} RA R_A התנגדות אלקטרודה Zs לולאת תקלה TT TN מפסק מגן פחת IΔn מתח מגע זמן ניתוק Ω ohm ערך מותר לא יעלה`;
  }
  if (loopFaultIntent) {
    retrievalQuery +=
      ' Zs impedance fault loop לולאת תקלה התנגדות לולאה זמן ניתוק מאמ"ת B C D נתיך Ia Uo';
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
      kind: "rag",
      title: "חוק ותקנות",
      bottomLine:
        "לא מצאתי במאגר המקוון קטעים רלוונטיים מספיק. נסה ניסוח אחר או נוסיף מקורות נוספים.",
      steps: [],
      cautions: [],
      requiredInfo: ["סוג מתקן", "מתח", "נקודת מדידה / ערך מדידה"],
      followUpQuestion:
        "כדי לדייק: על איזה סוג מתקן/סביבה אתה שואל (למשל אמבטיה, לוח, הארקה, אתר רפואי)?",
      sources: [],
      confidence: "low",
      chatState: {
        ...baseChatState,
        stage: "collecting",
      },
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
    const title = (h.source_title || "").toLowerCase();
    const isLawDocType =
      docType.startsWith("law_") ||
      docType.startsWith("regulation_") ||
      docType.startsWith("safety_");
    const isKnownLawPublisher =
      publisher.includes("knesset") ||
      publisher.includes("nevo") ||
      url.includes("knesset.gov.il") ||
      url.includes("nevo.co.il");
    const isGovElectricLaw =
      (publisher.includes("gov") || url.includes("gov.il")) &&
      isElectricLawish(title, url);

    if (isLawDocType || isKnownLawPublisher || isGovElectricLaw) {
      return legalDocTier(docType) - 2; // regulation/safety first, then law
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
    rankedHits = rankedHits.filter((h) => {
      const docType = (sourceDocTypes[h.source_title] || "").toLowerCase();
      const url = (h.source_url || "").toLowerCase();
      const title = (h.source_title || "").toLowerCase();

      const isLawDocType =
        docType.startsWith("law_") ||
        docType.startsWith("regulation_") ||
        docType.startsWith("safety_");
      const isNevoOrKnesset =
        url.includes("nevo.co.il") || url.includes("knesset.gov.il");
      const isElectricLaw = isElectricLawish(title, url);

      if (isLawDocType) return true;
      if (isNevoOrKnesset && isElectricLaw) return true;
      if (url.includes("gov.il") && isElectricLaw) return true;
      return false;
    });

    // In strict legal mode, prefer regulation/safety chunks over generic law chunks.
    rankedHits = rankedHits.sort((a, b) => {
      const aType = (sourceDocTypes[a.source_title] || "").toLowerCase();
      const bType = (sourceDocTypes[b.source_title] || "").toLowerCase();
      const aOrder = aType.startsWith("regulation_") || aType.startsWith("safety_") ? 0 : aType.startsWith("law_") ? 1 : 2;
      const bOrder = bType.startsWith("regulation_") || bType.startsWith("safety_") ? 0 : bType.startsWith("law_") ? 1 : 2;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return (b.rank || 0) - (a.rank || 0);
    });
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
      kind: "rag",
      title: "חוק ותקנות",
      bottomLine:
        "לא מצאתי כרגע במאגר החוקי קטע ברור מספיק על 'אמבטיה' בהקשר שביקשת.",
      steps: [],
      cautions: ["כדי לא להטעות, נדרש מיקוד קצר לפני הנחיה מעשית."],
      requiredInfo: ["סוג המתקן", "מה בדיוק נדרש: מרחק/שקע/הגנה"],
      followUpQuestion:
        "בחר הקשר: בית מגורים / אתר רפואי / מתקן אחר, ומה בדיוק נדרש: מרחק, סוג שקע, או דרישת הגנה.",
      sources: [],
      confidence: "low",
      chatState: {
        ...baseChatState,
        stage: "collecting",
      },
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
        kind: "rag",
        title: "חוק ותקנות",
        bottomLine:
          'לא מצאתי במאגר החוקי קטעים רלוונטיים מספיק לשאלה זו. נסה ניסוח ממוקד יותר (למשל: "מרחק מאמבטיה לפי תקנות") או עדכן מקורות חוק/תקנות נוספים.',
        steps: [],
        cautions: [],
        requiredInfo: ["סוג המתקן", "מתח", "פרטי המקרה המדויקים"],
        followUpQuestion:
          "כדי למקד: באיזה הקשר מדובר — בית מגורים, אתר רפואי, או מתקן אחר?",
        sources: [],
        confidence: "low",
        chatState: {
          ...baseChatState,
          stage: "collecting",
        },
      });
    }
  }

  if (earthingValueIntent && rankedHits.length > 0) {
    const beforeTop = rankedHits.slice(0, 8).map((h) => ({
      title: h.source_title,
      chunk_index: (h.locator && (h.locator.chunk || h.locator.chunk_index)) || null,
      section: h.section || "",
      rank: Number(h.rank || 0).toFixed(3),
    }));
    // eslint-disable-next-line no-console
    console.log("[EARTHING before rerank]", JSON.stringify(beforeTop, null, 2));

    rankedHits = [...rankedHits].sort((a, b) => {
      const sa = scoreChunkForEarthingValueQuestion(contextualQuestion, a.text || "");
      const sb = scoreChunkForEarthingValueQuestion(contextualQuestion, b.text || "");
      if (sa !== sb) return sb - sa;
      return (b.rank || 0) - (a.rank || 0);
    });

    const afterTop = rankedHits.slice(0, 8).map((h) => ({
      title: h.source_title,
      chunk_index: (h.locator && (h.locator.chunk || h.locator.chunk_index)) || null,
      section: h.section || "",
      rank: Number(h.rank || 0).toFixed(3),
      score: scoreChunkForEarthingValueQuestion(contextualQuestion, h.text || ""),
    }));
    // eslint-disable-next-line no-console
    console.log("[EARTHING after rerank]", JSON.stringify(afterTop, null, 2));
  }

  // Prefer cleaner and more diverse hits (avoid multiple near-identical menu pages).
  const sortedByQuality = [...rankedHits].sort((a, b) => {
    const tierA = legalDocTier(sourceDocTypes[a.source_title] || "");
    const tierB = legalDocTier(sourceDocTypes[b.source_title] || "");
    if (tierA !== tierB) return tierA - tierB;
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

  const sources: SourceRef[] = top.map((h) => ({
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
  const allSourcesEvidenceText = top
    .map((h) => normalizeHebrewText(h.text || ""))
    .join("\n");

  if (looksLikeEarthingOhmsQuestion(q)) {
    const ok = sourcesContainAny(allSourcesText, [
      /אוהם|Ω|ohm/i,
      /התנגדות/i,
      /R_A|RA\b/i,
      /Zs\b|לולאת תקלה/i,
    ]);

    if (!ok) {
      return res.status(200).json({
        kind: "rag",
        title: "חוק ותקנות",
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
        chatState: {
          ...baseChatState,
          topic: "earthing",
          stage: "collecting",
        },
      });
    }
  }

  if (earthingValueIntent && !earthingTermEvidenceExists(allSourcesEvidenceText)) {
    return res.status(200).json({
      kind: "flow",
      title: "הארקה / לולאת תקלה",
      bottomLine:
        "במקורות שנשלפו לא נמצאו מונחים טכניים מספיקים (RA/Zs/Ω), לכן אי אפשר לקבוע ערך תקין כרגע.",
      steps: [],
      cautions: ["כדי לא להטעות, לא ניתן לתת ערך תקינות בלי מקור רלוונטי מפורש."],
      requiredInfo: [
        "מה נמדד: RA / Zs / רציפות PE",
        "שיטת איפוס: TT / TN",
        "נתון פחת (IΔn) אם קיים",
      ],
      followUpQuestion:
        "מה נמדד בפועל (RA/Zs/PE), ומה שיטת האיפוס (TT/TN)?",
      sources: [],
      confidence: "low",
      chatState: {
        ...baseChatState,
        topic: "earthing",
        stage: "collecting",
      },
    });
  }

  if (loopFaultIntent && !loopFaultEvidenceExists(allSourcesEvidenceText)) {
    return res.status(200).json({
      kind: "rag",
      title: "לולאת תקלה (Zs)",
      bottomLine:
        "לא הצלחתי לשלוף מהמאגר סעיף שמדבר על לולאת תקלה (Zs), לכן אני לא נותן תשובה מבוססת תקנות כרגע.",
      steps: [],
      cautions: ["אל תסתמך על תשובה ללא סעיף מתאים. עבודה בחשמל מסכנת חיים."],
      requiredInfo: [
        "סוג רשת (TT/TN)",
        'סוג ההגנה (מאמ"ת B/C/D או נתיך + זרם נקוב)',
        "מתח רשת (230/400)",
        "האם נדרשת הגדרה או חישוב Zs מקסימלי",
      ],
      followUpQuestion:
        "אתה רוצה הגדרה של Zs או חישוב Zs מקסימלי? ואם חישוב — מה סוג ההגנה והזרם הנקוב?",
      sources: [],
      confidence: "low",
      chatState: {
        ...baseChatState,
        topic: "loop_fault",
        stage: "collecting",
      },
    });
  }

  let confidence: "high" | "medium" | "low" =
    rankedHits[0].rank >= 1.2
      ? "high"
      : rankedHits[0].rank >= 0.7
        ? "medium"
        : "low";

  if (!numericEvidenceExists(contextualQuestion, allSourcesEvidenceText)) {
    confidence = "low";
  }
  if (earthingValueIntent && !earthingTermEvidenceExists(allSourcesEvidenceText)) {
    confidence = "low";
  }
  if (loopFaultIntent && !loopFaultEvidenceExists(allSourcesEvidenceText)) {
    confidence = "low";
  }

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

  const basePayload = llmResult || fallback;
  const responsePayload: Answer = {
    ...basePayload,
    kind: basePayload.kind || "rag",
    title: basePayload.title || "חוק ותקנות",
  };
  const DEBUG = process.env.DEBUG_RAG === "1";

  if (DEBUG) {
    return res.status(200).json({
      ...responsePayload,
      chatState: {
        ...baseChatState,
        stage: "answering",
        pendingQuestion: responsePayload.followUpQuestion,
        lastSummary: responsePayload.bottomLine,
      },
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
    kind: responsePayload.kind || "rag",
    title: responsePayload.title || "חוק ותקנות",
    bottomLine: responsePayload.bottomLine,
    steps: responsePayload.steps || [],
    cautions: responsePayload.cautions || [],
    requiredInfo: responsePayload.requiredInfo || undefined,
    followUpQuestion: responsePayload.followUpQuestion || undefined,
    sources: responsePayload.sources || [],
    confidence: responsePayload.confidence || "low",
    chatState: {
      ...baseChatState,
      stage: responsePayload.followUpQuestion ? "collecting" : "answering",
      pendingQuestion: responsePayload.followUpQuestion || undefined,
      lastSummary: responsePayload.bottomLine,
    },
  });
}

