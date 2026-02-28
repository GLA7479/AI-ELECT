"use client";

import { useMemo, useState } from "react";
import Layout from "../components/Layout";
import { db } from "../lib/db";
import { offlineSearch } from "../lib/search";
import { nanoid } from "../lib/utils";
import type { AskResponse } from "../src/types/ask";

type ScopeMode = "law_only" | "law_plus_utility" | "all";
type ConversationItem = { q: string; createdAt?: string };
const ISSUE_TYPES = [
  "הארקה / לולאת תקלה",
  "פחת (RCD)",
  "קצר / מפסקים קופצים",
  "חימום כבלים / עומס",
  "לוח חשמל / זיהוי פאזה",
];

async function askOnline(
  question: string,
  scope: ScopeMode,
  history: Array<{ q: string; createdAt?: string }>,
  issueType: string
) {
  const r = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, scope, history, issueType }),
  });

  if (!r.ok) {
    const msg = await r.text();
    throw new Error(msg || "Online request failed");
  }

  return (await r.json()) as AskResponse;
}

export default function HomePage() {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<AskResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<ScopeMode>("law_only");
  const [issueType, setIssueType] = useState(ISSUE_TYPES[0]);
  const [conversationHistory, setConversationHistory] = useState<
    ConversationItem[]
  >([]);

  const online = useMemo(
    () => (typeof window === "undefined" ? true : navigator.onLine),
    []
  );

  async function ask() {
    const question = q.trim();
    if (!question) return;

    setBusy(true);
    setAnswer(null);

    try {
      // Prefer online when available
      if (typeof window !== "undefined" && navigator.onLine) {
        const data = await askOnline(question, scope, conversationHistory, issueType);
        setAnswer(data);

        await db.history.add({
          id: nanoid(),
          q: question,
          a: data.bottomLine,
          createdAt: new Date().toISOString(),
          mode: "online",
        });
        setConversationHistory((prev) =>
          [...prev, { q: question, createdAt: new Date().toISOString() }].slice(
            -6
          )
        );

        return;
      }

      // Offline fallback
      const hits = await offlineSearch(question, 4);

      if (hits.length === 0) {
        setAnswer({
          bottomLine:
            "לא מצאתי במאגר המקומי מקור מספיק לשאלה הזו. כשיהיה חיבור, אנסה לתת תשובה מלאה ממקורות רשמיים.",
          steps: [],
          cautions: [],
          requiredInfo: ["נסח שאלה מדויקת יותר או התחבר לאינטרנט."],
          sources: [],
          confidence: "low",
        });
      } else {
        setAnswer({
          bottomLine:
            "מצאתי מידע רלוונטי במאגר האוף־ליין. זו תשובה התחלתית בלבד.",
          steps: hits.slice(0, 3).map((h) => h.text.slice(0, 220)),
          cautions: ["זוהי תשובת אוף־ליין. אמת מול מקורות רשמיים לפני ביצוע עבודה."],
          sources: hits.map((h) => ({ title: h.title, section: h.section })),
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
      setConversationHistory((prev) =>
        [...prev, { q: question, createdAt: new Date().toISOString() }].slice(-6)
      );
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

          <select
            className="input"
            style={{ width: 210, maxWidth: "100%" }}
            value={scope}
            onChange={(e) => setScope(e.target.value as ScopeMode)}
          >
            <option value="law_only">מיקוד: חוק/תקנות בלבד</option>
            <option value="law_plus_utility">מיקוד: חוק + המעגל</option>
            <option value="all">מיקוד: כל המקורות</option>
          </select>
          <select
            className="input"
            style={{ width: 220, maxWidth: "100%" }}
            value={issueType}
            onChange={(e) => setIssueType(e.target.value)}
          >
            {ISSUE_TYPES.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>

          <span className="badge">{online ? "Online" : "Offline"}</span>
          {answer?.confidence && (
            <span className="badge">ביטחון: {answer.confidence}</span>
          )}
          <button
            className="btn"
            onClick={() => setConversationHistory([])}
            disabled={busy || conversationHistory.length === 0}
            title="נקה הקשר שיחה"
          >
            נקה הקשר
          </button>
        </div>

        {conversationHistory.length > 0 && (
          <div className="small" style={{ marginTop: 8 }}>
            הקשר שיחה פעיל:{" "}
            {conversationHistory
              .slice(-2)
              .map((h) => h.q)
              .join("  •  ")}
          </div>
        )}

        {answer && (
          <>
            <hr />
            <div className="h2">תשובה</div>
            <div className="space-y-3" style={{ marginBottom: 12 }}>
              <div className="h2" style={{ fontSize: 20 }}>
                {answer.bottomLine}
              </div>

              {answer.steps?.length > 0 && (
                <div>
                  <div className="small" style={{ fontWeight: 700 }}>
                    צעדים:
                  </div>
                  <ol style={{ margin: 0, paddingInlineStart: 20 }}>
                    {answer.steps.map((s, i) => (
                      <li key={i}>{s}</li>
                    ))}
                  </ol>
                </div>
              )}

              {answer.cautions?.length > 0 && (
                <div>
                  <div className="small" style={{ fontWeight: 700 }}>
                    זהירות:
                  </div>
                  <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                    {answer.cautions.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                </div>
              )}

              {answer.requiredInfo?.length ? (
                <div>
                  <div className="small" style={{ fontWeight: 700 }}>
                    חסר מידע כדי לקבוע:
                  </div>
                  <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                    {answer.requiredInfo.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            {answer.followUpQuestion ? (
              <div className="card" style={{ marginTop: 10, padding: 12 }}>
                <div className="small" style={{ fontWeight: 700 }}>
                  שאלת המשך:
                </div>
                <div style={{ marginTop: 4 }}>{answer.followUpQuestion}</div>
              </div>
            ) : null}

            {answer.sources.length > 0 && (
              <>
                <hr />
                <div className="h2">מקורות</div>
                <ul
                  className="small"
                  style={{ margin: 0, paddingInlineStart: 18 }}
                >
                  {answer.sources.map((c, i) => (
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
            <div className="small" style={{ marginTop: 8, opacity: 0.8 }}>
              Confidence: {answer.confidence}
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}

