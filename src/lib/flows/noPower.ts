import type { Answer } from "../../types/answer";

export type NoPowerInput = {
  scope: "whole_site" | "one_area" | "one_socket";
  breakerState?: "up" | "down" | "unknown";
  rcdState?: "up" | "down" | "unknown";
  hasMeterVoltage?: "yes" | "no" | "unknown";
};

export function flowNoPower(i: Partial<NoPowerInput>): Answer {
  if (!i.scope) {
    return {
      kind: "flow",
      title: "אבחון אין מתח",
      bottomLine: "צריך להבין קודם היקף תקלה.",
      steps: [],
      requiredInfo: ["כל האתר / אזור אחד / שקע יחיד"],
      followUpQuestion: "אין חשמל בכל האתר, באזור מסוים או בשקע אחד?",
      confidence: "low",
    };
  }

  const steps: string[] = [
    "בדוק מצב מפסק ראשי ומפסק פחת (למעלה/למטה).",
    "אם כל האתר ללא מתח — אמת נוכחות הזנה במונה/כניסה.",
    "אם רק אזור מסוים — אתר את המא״ז המזין ובדוק אם קפץ.",
    "אם שקע בודד — בדוק שקע נוסף באותו מעגל וחפש חיבור רופף.",
    "אמת מתח עם מכשיר מדידה מתאים (לא רק בודק מגע).",
  ];

  return {
    kind: "flow",
    title: "אבחון אין מתח",
    bottomLine: "אבחון לפי היקף התקלה: מקור הזנה → לוח → מעגל → נקודת קצה.",
    steps,
    cautions: ["אין לפתוח לוח חי ללא הסמכה והגנות מתאימות."],
    confidence: "medium",
  };
}
