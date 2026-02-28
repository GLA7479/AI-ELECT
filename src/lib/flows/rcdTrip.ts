import type { Answer } from "../../types/answer";

export type RcdTripInput = {
  when: "immediate" | "after_minutes" | "random";
  affects: "all_house" | "one_circuit";
  recentChange?: "none" | "new_appliance" | "new_work" | "rain_humidity";
  rcdRating?: "30mA" | "100mA" | "300mA" | "unknown";
};

export function flowRcdTrip(i: Partial<RcdTripInput>): Answer {
  const missing: string[] = [];
  if (!i.when) missing.push("מתי הפחת נופל? (מיידי / אחרי כמה דקות / אקראי)");
  if (!i.affects) missing.push("האם זה משפיע על כל הבית או רק על מעגל אחד?");

  if (missing.length) {
    return {
      kind: "flow",
      title: "אבחון נפילת פחת",
      bottomLine: "צריך 2 פרטים כדי להתחיל אבחון מדויק.",
      steps: [],
      requiredInfo: missing,
      followUpQuestion:
        "ענה בקצרה: (1) מתי הוא נופל, (2) כל הבית או מעגל אחד?",
      cautions: ["אם יש ריח שרוף/חימום חריג — נתק מתח והפסק עבודה."],
      confidence: "low",
    };
  }

  const steps: string[] = [];

  if (i.affects === "one_circuit") {
    steps.push("כבה את המא״ז של המעגל החשוד והחזר את הפחת.");
    steps.push("חבר עומסים אחד-אחד כדי לאתר צרכן/נקודה דולפת.");
  } else {
    steps.push("כבה את כל המא״זים המשניים, החזר פחת, והעלה מעגלים אחד-אחד.");
  }

  if (i.recentChange === "rain_humidity") {
    steps.push("בדוק מעגלי חוץ, קופסאות רטובות וגופי תאורה חיצוניים.");
  }
  if (i.recentChange === "new_appliance") {
    steps.push("נתק את הצרכן החדש ובדוק אם הנפילה נפסקת.");
  }

  steps.push("בצע מדידת בידוד/דלף עם ציוד מתאים לאימות סופי.");

  return {
    kind: "flow",
    title: "אבחון נפילת פחת",
    bottomLine: "בודדים מעגל/עומס דולף, מאמתים במדידה, ואז מתקנים.",
    steps,
    cautions: [
      "אין לעקוף או לבטל מפסק פחת.",
      "לפני פתיחת לוח/קופסה — עבודה במצב מנותק בלבד.",
    ],
    confidence: "medium",
  };
}
