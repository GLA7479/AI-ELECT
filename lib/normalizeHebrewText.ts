export function normalizeHebrewText(input: string): string {
  let t = input ?? "";

  // Remove hard control characters that often appear in broken PDF extraction
  // (examples: \u001A, \u001B, \u0001)
  t = t.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ");

  // Normalize whitespace/newlines from PDF extraction noise.
  t = t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  t = t.replace(/\n+/g, " ");
  
  // First normalize multiple spaces to single space
  t = t.replace(/\s{2,}/g, " ");
  
  // CONSERVATIVE FIX: Only fix obvious broken words (3+ Hebrew letters with single spaces)
  // This is safer - we only fix clear cases of broken words, not all spaces between Hebrew letters
  // "ר א שי" -> "ראשי" (3+ letters with spaces = broken word)
  // But "חוק החשמל" stays as "חוק החשמל" (preserve word boundaries)
  
  // Fix sequences of 3+ Hebrew letters separated by single spaces (iteratively)
  let changed = true;
  let iterations = 0;
  while (changed && iterations < 5) {
    const before = t;
    // Match 3+ Hebrew letters with spaces between them
    t = t.replace(/([\u0590-\u05ff])\s+([\u0590-\u05ff])\s+([\u0590-\u05ff])/g, "$1$2$3");
    changed = (before !== t);
    iterations++;
  }
  
  // Normalize remaining whitespace
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
  t = t.replace(/[]/g, " ");
  
  // Fix common OCR errors: "£" -> nothing (often appears in broken PDFs)
  t = t.replace(/£/g, "");
  
  // Final whitespace cleanup
  t = t.replace(/[ \t]{2,}/g, " ").trim();

  return t;
}
