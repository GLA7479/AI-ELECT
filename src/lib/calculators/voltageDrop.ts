import type { Answer } from "../../types/answer";

export type VDropInput = {
  phase: "1P" | "3P";
  material: "Cu" | "Al";
  lengthM: number;
  currentA: number;
  areaMm2: number;
  voltageV: number;
};

export function calcVoltageDrop(i: VDropInput): Answer {
  const rho = i.material === "Cu" ? 0.0175 : 0.0282;
  const R = (rho * i.lengthM) / i.areaMm2;

  let dV = 0;
  if (i.phase === "1P") dV = i.currentA * (2 * R);
  else dV = Math.sqrt(3) * i.currentA * R;

  const pct = (dV / i.voltageV) * 100;

  return {
    kind: "calc",
    title: "חישוב נפילת מתח",
    bottomLine: `נפילת מתח משוערת: ${round(dV, 2)}V (${round(pct, 2)}%)`,
    steps: [
      "אמת שאורך הכבל הוא בכיוון אחד מהלוח לעומס.",
      "במרחקים גדולים או עומס אינדוקטיבי יש לחשב גם רכיב ריאקטיבי (R+X).",
      "השווה לאחוז הנפילה המותר לפי סוג הצרכן והשימוש.",
    ],
    values: {
      פאזה: i.phase,
      חומר: i.material,
      אורך_מטר: i.lengthM,
      זרם_אמפר: i.currentA,
      חתך_ממ2: i.areaMm2,
      מתח_וולט: i.voltageV,
      נפילה_וולט: round(dV, 2),
      נפילה_אחוז: round(pct, 2),
    },
    assumptions: ["מודל מקורב בטמפרטורת 20C וללא רכיב השראות."],
    confidence: "medium",
  };
}

function round(x: number, d = 2) {
  const p = 10 ** d;
  return Math.round(x * p) / p;
}
