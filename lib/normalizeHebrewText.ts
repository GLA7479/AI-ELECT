export function normalizeHebrewText(input: string): string {
  let t = input ?? "";

  // Remove hard control characters that often appear in broken PDF extraction
  // (examples: \u001A, \u001B, \u0001)
  t = t.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ");

  // Normalize whitespace/newlines from PDF extraction noise.
  t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  t = t.replace(/\n+/g, " ");
  t = t.replace(/\s+/g, " ").trim();

  // Keep punctuation readable.
  t = t.replace(/([,:;!?])/g, "$1 ");
  t = t.replace(/\s+([,.:;!?])/g, "$1");

  // Parentheses spacing.
  t = t.replace(/([א-ת])\(/g, "$1 (");
  t = t.replace(/\)([א-ת])/g, ") $1");
  t = t.replace(/\)\(/g, ") (");

  // Hebrew <-> digits/latin boundaries.
  t = t.replace(/([א-ת])([0-9A-Za-z])/g, "$1 $2");
  t = t.replace(/([0-9A-Za-z])([א-ת])/g, "$1 $2");

  // Operators spacing.
  t = t.replace(/\s*\+\s*/g, " + ");
  t = t.replace(/\s*=\s*/g, " = ");
  t = t.replace(/\s*\/\s*/g, " / ");

  // Common broken numbering patterns from OCR/PDF:
  // "1)(2)" -> "1) (2", "1(2" -> "1 (2"
  t = t.replace(/(\d)\)\s*(\d)/g, "$1) $2");
  t = t.replace(/(\d)\s*\(\s*(\d)/g, "$1 ($2");
  t = t.replace(/\)\s*\(/g, ") (");

  // "מתח+5050" -> "מתח + 5050"
  t = t.replace(/([א-ת])\s*\+\s*(\d)/g, "$1 + $2");

  // OCR junk cleanup.
  t = t.replace(/\*+/g, " ");
  t = t.replace(/[|]{2,}/g, " ");
  t = t.replace(/[�]/g, " ");
  t = t.replace(/[ \t]{2,}/g, " ").trim();

  return t;
}
