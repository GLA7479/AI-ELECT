import type { SourceChunk } from "./db";

export const DEMO_PACK_ID = "pack_demo_basic";

export const demoChunks: SourceChunk[] = [
  {
    id: "chunk_1",
    title: "דמו: רישוי חשמלאים",
    section: "כלל",
    text: "כדי לאמת רישיון חשמלאי בישראל משתמשים במאגר רישיונות רשמי. בכל תשובה מקצועית יש לציין את המקור והסעיף/הפניה.",
    updatedAt: new Date().toISOString(),
    tags: ["רישוי", "אימות", "משרד העבודה"],
  },
  {
    id: "chunk_2",
    title: "דמו: בטיחות בעבודה (חשמל)",
    section: "עקרון",
    text: "כל עבודה בקרבת חשמל דורשת ניהול סיכונים, ציוד מגן מתאים ועמידה בתקנות בטיחות. אין לבצע פעולה מסוכנת ללא הסמכה.",
    updatedAt: new Date().toISOString(),
    tags: ["בטיחות", "ציוד מגן", "תקנות"],
  },
  {
    id: "chunk_3",
    title: "דמו: החזרת תשובה עם ציטוטים",
    section: "ציטוט",
    text: "המטרה: תשובות קצרות וברורות עם ציטוטים. אם לא נמצא מקור חד־משמעי—המערכת אומרת שלא נמצא מקור ולא מנחשת.",
    updatedAt: new Date().toISOString(),
    tags: ["ציטוטים", "אמינות", "RAG"],
  },
];

