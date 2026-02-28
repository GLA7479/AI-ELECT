import type { Answer } from "../types/answer";
import { triage } from "./triage";
import { calcPowerCurrent } from "./calculators/powerCurrent";
import { calcVoltageDrop } from "./calculators/voltageDrop";
import { flowRcdTrip } from "./flows/rcdTrip";
import { flowNoPower } from "./flows/noPower";

export type AskPayload = {
  question: string;
  modeHint?: "auto" | "calc" | "flow" | "rag";
  calc?: any;
  flow?: any;
};

export function runEngine(p: AskPayload): { route: string; answer?: Answer } {
  const route = triage(p.question, p.modeHint === "auto" ? undefined : p.modeHint);

  if (route === "CALC_POWER_CURRENT") {
    if (!p.calc) {
      return {
        route,
        answer: {
          kind: "calc",
          title: "חישוב זרם מהספק",
          bottomLine: "כדי לחשב זרם דרושים נתוני כניסה.",
          steps: [],
          requiredInfo: [
            "פאזה (חד/תלת)",
            "מתח (230/400V)",
            "הספק ויחידות (kW/kVA)",
            "cosφ ונצילות אם יש",
          ],
          followUpQuestion:
            "שלח לי פאזה, מתח, הספק ויחידות כדי שאחזיר זרם מיידית.",
          confidence: "low",
        },
      };
    }
    return { route, answer: calcPowerCurrent(p.calc) };
  }

  if (route === "CALC_VDROP") {
    if (!p.calc) {
      return {
        route,
        answer: {
          kind: "calc",
          title: "חישוב נפילת מתח",
          bottomLine: "כדי לחשב נפילת מתח דרושים נתוני כניסה.",
          steps: [],
          requiredInfo: [
            "פאזה (חד/תלת)",
            "אורך כבל במטר",
            "זרם באמפר",
            "חתך בממ״ר",
            "חומר מוליך (Cu/Al)",
            "מתח הזנה",
          ],
          followUpQuestion:
            "שלח לי אורך, זרם, חתך, חומר ומתח כדי שאחשב נפילת מתח.",
          confidence: "low",
        },
      };
    }
    return { route, answer: calcVoltageDrop(p.calc) };
  }

  if (route === "FLOW_RCD_TRIP") return { route, answer: flowRcdTrip(p.flow || {}) };
  if (route === "FLOW_NO_POWER") return { route, answer: flowNoPower(p.flow || {}) };

  return { route };
}
