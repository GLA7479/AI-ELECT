import type { Answer } from "../../types/answer";

export type PowerCurrentInput = {
  phase: "1P" | "3P";
  voltageV: number;
  value: number;
  unit: "kW" | "kVA";
  cosPhi?: number;
  efficiency?: number;
};

export function calcPowerCurrent(i: PowerCurrentInput): Answer {
  const cosPhi = clamp(i.cosPhi ?? 0.9, 0.1, 1);
  const eff = clamp(i.efficiency ?? 0.95, 0.1, 1);
  const kVA = i.unit === "kVA" ? i.value : i.value / (cosPhi * eff);
  const VA = kVA * 1000;

  let currentA = 0;
  if (i.phase === "1P") currentA = VA / i.voltageV;
  else currentA = VA / (Math.sqrt(3) * i.voltageV);

  return {
    kind: "calc",
    title: "חישוב זרם מהספק",
    bottomLine: `הזרם המשוער: ${round(currentA, 2)}A`,
    steps: [
      "אמת את סוג ההזנה: חד-פאזי או תלת-פאזי.",
      "בעומסים מנועיים יש לאמת cosφ ונצילות לפי לוחית היצרן.",
      "זהו חישוב תכן ראשוני בלבד; בחירת הגנות וחתך מחייבת טבלאות ותנאי התקנה.",
    ],
    values: {
      פאזה: i.phase,
      מתח_וולט: i.voltageV,
      קלט: `${i.value} ${i.unit}`,
      cos_phi: cosPhi,
      נצילות: i.unit === "kW" ? eff : "לא רלוונטי",
      זרם_אמפר: round(currentA, 2),
    },
    cautions: [
      "לפני ביצוע בשטח יש לאמת מול תקן, שיטת התקנה, טמפרטורה וקיבוץ מעגלים.",
    ],
    confidence: "high",
  };
}

function round(x: number, d = 2) {
  const p = 10 ** d;
  return Math.round(x * p) / p;
}

function clamp(x: number, a: number, b: number) {
  return Math.max(a, Math.min(b, x));
}
