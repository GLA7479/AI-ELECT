"use client";

import { useMemo, useState } from "react";
import Layout from "../components/Layout";
import ExpandableText from "../components/ExpandableText";
import { db } from "../lib/db";
import { offlineSearch } from "../lib/search";
import { nanoid } from "../lib/utils";

type Citation = {
  title: string;
  section: string;
  url?: string;
};

type AnswerSegment = {
  title: string;
  section: string;
  text: string;
  url?: string;
};

type Answer = {
  text: string;
  citations: Citation[];
  segments?: AnswerSegment[];
  mode: "offline" | "online";
  confidence?: "high" | "medium" | "low";
};

async function askOnline(question: string) {
  const r = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });

  if (!r.ok) {
    const msg = await r.text();
    throw new Error(msg || "Online request failed");
  }

  const data = (await r.json()) as {
    answer: string;
    mode: "online";
    citations: Citation[];
    segments?: AnswerSegment[];
    confidence: "high" | "medium" | "low";
  };

  return data;
}

export default function HomePage() {
  const [q, setQ] = useState("");
  const [a, setA] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);

  const online = useMemo(
    () => (typeof window === "undefined" ? true : navigator.onLine),
    []
  );

  async function ask() {
    const question = q.trim();
    if (!question) return;

    setBusy(true);
    setA(null);

    try {
      // Prefer online when available
      if (typeof window !== "undefined" && navigator.onLine) {
        const data = await askOnline(question);

        setA({
          text: data.answer,
          citations: data.citations || [],
          segments: data.segments || [],
          mode: "online",
          confidence: data.confidence,
        });

        await db.history.add({
          id: nanoid(),
          q: question,
          a: data.answer,
          createdAt: new Date().toISOString(),
          mode: "online",
        });

        return;
      }

      // Offline fallback
      const hits = await offlineSearch(question, 4);

      if (hits.length === 0) {
        setA({
          text:
            "לא מצאתי במאגר המקומי מקור מספיק לשאלה הזו. כשיהיה חיבור, אנסה לתת תשובה מלאה עם ציטוטים ממקורות רשמיים.",
          citations: [],
          segments: [],
          mode: "offline",
          confidence: "low",
        });
      } else {
        setA({
          text:
            "מצאתי מידע רלוונטי במאגר האוף־ליין. זו תשובה התחלתית (דמו). בשלב הבא נחבר מקורות רשמיים מלאים ו־RAG אמיתי.",
          citations: hits.map((h) => ({ title: h.title, section: h.section })),
          segments: hits.map((h) => ({
            title: h.title,
            section: h.section,
            text: h.text,
          })),
          mode: "offline",
          confidence: "medium",
        });
      }

      await db.history.add({
        id: nanoid(),
        q: question,
        a: hits.length ? "Offline answer (demo) with citations." : "No offline match.",
        createdAt: new Date().toISOString(),
        mode: "offline",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Layout>
      <h1 className="h1">AI לחשמלאים</h1>

      <div className="card">
        <div className="h2">שאל את המומחה</div>

        <textarea
          className="textarea"
          placeholder="לדוגמה: מי מוסמך לחתום על טופס 3? מה הדרישות להארקה?"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />

        <div style={{ marginTop: 10 }} className="row">
          <button className="btn" onClick={ask} disabled={busy}>
            {busy ? "מחפש..." : "שאל"}
          </button>

          <span className="badge">{online ? "Online" : "Offline"}</span>
          {a?.confidence && (
            <span className="badge">ביטחון: {a.confidence}</span>
          )}
        </div>

        {a && (
          <>
            <hr />
            <div className="h2">תשובה ({a.mode})</div>
            {a.segments && a.segments.length > 0 ? (
              <div>
                {a.segments.map((seg, idx) => (
                  <div key={`${seg.title}-${seg.section}-${idx}`} style={{ marginBottom: 14 }}>
                    <div className="small" style={{ marginBottom: 6 }}>
                      • {seg.section} — {seg.title}
                    </div>
                    <ExpandableText text={seg.text} maxChars={320} />
                  </div>
                ))}
              </div>
            ) : (
              <ExpandableText text={a.text || ""} maxChars={600} />
            )}

            {a.citations.length > 0 && (
              <>
                <hr />
                <div className="h2">ציטוטים</div>
                <ul
                  className="small"
                  style={{ margin: 0, paddingInlineStart: 18 }}
                >
                  {a.citations.map((c, i) => (
                    <li key={i}>
                      {c.title} — {c.section}
                      {c.url ? (
                        <>
                          {" "}
                          ·{" "}
                          <a href={c.url} target="_blank" rel="noreferrer">
                            פתח מקור
                          </a>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </Layout>
  );
}

