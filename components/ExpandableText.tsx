import { useMemo, useState } from "react";
import { normalizeHebrewText } from "../lib/normalizeHebrewText";

export default function ExpandableText({
  text,
  maxChars = 600,
}: {
  text: string;
  maxChars?: number;
}) {
  const [expanded, setExpanded] = useState(false);

  const { shownText, isLong } = useMemo(() => {
    const t = normalizeHebrewText(text || "");

    const long = t.length > maxChars;
    const shown = expanded || !long ? t : t.slice(0, maxChars) + "…";
    return { shownText: shown, isLong: long };
  }, [text, maxChars, expanded]);

  return (
    <div>
      <div
        dir="rtl"
        style={{
          lineHeight: 1.85,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          overflowWrap: "anywhere",
          direction: "rtl",
          textAlign: "right",
          unicodeBidi: "plaintext",
        }}
      >
        {shownText}
      </div>

      {isLong && (
        <div style={{ marginTop: 10 }}>
          <button className="btn" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "הצג פחות" : "המשך לקרוא"}
          </button>
        </div>
      )}
    </div>
  );
}
