export type Route =
  | "CALC_POWER_CURRENT"
  | "CALC_VDROP"
  | "CALC_SIMPLE_CABLE_HINT"
  | "FLOW_RCD_TRIP"
  | "FLOW_NO_POWER"
  | "RAG_CODE"
  | "RAG_GENERAL";

export function triage(q: string, modeHint?: string): Route {
  const s = (q || "").toLowerCase();

  if (modeHint === "calc") {
    if (/נפילת מתח|voltage drop|vd%|אחוז נפילה/.test(s)) return "CALC_VDROP";
    if (/kw|kva|הספק|תלת|חד|cos/.test(s)) return "CALC_POWER_CURRENT";
    if (/כבל|חתך|mm2|mm²|זרם מותר/.test(s)) return "CALC_SIMPLE_CABLE_HINT";
  }

  if (modeHint === "flow") {
    if (/פחת|rcd|fid|ממסר/.test(s)) return "FLOW_RCD_TRIP";
    if (/אין חשמל|אין מתח|לא מגיע מתח|נפל/.test(s)) return "FLOW_NO_POWER";
  }

  if (/נפילת מתח|voltage drop|vd%|אחוז נפילה/.test(s)) return "CALC_VDROP";
  if (/kw|kva|הספק|תלת|חד|cos/.test(s)) return "CALC_POWER_CURRENT";
  if (/פחת|rcd|fid|ממסר/.test(s)) return "FLOW_RCD_TRIP";
  if (/אין חשמל|אין מתח|לא מגיע מתח|נפל/.test(s)) return "FLOW_NO_POWER";
  if (/תקן|תקנות|חוק|ת\"י|israel standard/.test(s)) return "RAG_CODE";

  return "RAG_GENERAL";
}
