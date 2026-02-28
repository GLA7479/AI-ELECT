"use client";

import { useMemo, useState } from "react";
import Layout from "../components/Layout";
import { db } from "../lib/db";
import { offlineSearch } from "../lib/search";
import { nanoid } from "../lib/utils";
import type { Answer } from "../src/types/answer";
import type { ChatMessage, ChatState } from "../src/types/chat";

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
  issueType: string,
  modeHint: "auto" | "calc" | "flow" | "rag",
  conversationId: string,
  messages: ChatMessage[],
  chatState: ChatState
) {
  const r = await fetch("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question,
      scope,
      history,
      issueType,
      modeHint,
      conversationId,
      messages,
      chatState,
    }),
  });

  if (!r.ok) {
    const msg = await r.text();
    throw new Error(msg || "Online request failed");
  }

  return (await r.json()) as Answer;
}

export default function HomePage() {
  const [q, setQ] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<ScopeMode>("law_only");
  const [issueType, setIssueType] = useState(ISSUE_TYPES[0]);
  const [modeHint, setModeHint] = useState<"auto" | "calc" | "flow" | "rag">(
    "auto"
  );
  const [conversationHistory, setConversationHistory] = useState<
    ConversationItem[]
  >([]);
  const [conversationId, setConversationId] = useState<string>(() => nanoid());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatState, setChatState] = useState<ChatState>({
    topic: "general",
    stage: "collecting",
    slots: {},
  });

  const online = useMemo(
    () => (typeof window === "undefined" ? true : navigator.onLine),
    []
  );

  async function ask() {
    const question = q.trim();
    if (!question) return;

    setBusy(true);
    setAnswer(null);
    const userMsg: ChatMessage = {
      role: "user",
      content: question,
      createdAt: new Date().toISOString(),
    };
    const nextMessages = [...messages, userMsg].slice(-20);
    setMessages(nextMessages);
    setQ("");

    try {
      // Prefer online when available
      if (typeof window !== "undefined" && navigator.onLine) {
        const data = await askOnline(
          question,
          scope,
          conversationHistory,
          issueType,
          modeHint,
          conversationId,
          nextMessages,
          chatState
        );
        setAnswer(data);
        if (data.chatState) setChatState(data.chatState);
        setMessages((prev) =>
          [
            ...prev,
            {
              role: "assistant" as const,
              content: data.bottomLine,
              createdAt: new Date().toISOString(),
            },
          ].slice(-20)
        );

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
        const offlineAnswer: Answer = {
          kind: "rag",
          title: "אוף־ליין",
          bottomLine:
            "לא מצאתי במאגר המקומי מקור מספיק לשאלה הזו. כשיהיה חיבור, אנסה לתת תשובה מלאה ממקורות רשמיים.",
          steps: [],
          cautions: [],
          requiredInfo: ["נסח שאלה מדויקת יותר או התחבר לאינטרנט."],
          sources: [],
          confidence: "low",
        };
        setAnswer(offlineAnswer);
        setMessages((prev) =>
          [
            ...prev,
            {
              role: "assistant" as const,
              content: offlineAnswer.bottomLine,
              createdAt: new Date().toISOString(),
            },
          ].slice(-20)
        );
      } else {
        const offlineAnswer: Answer = {
          kind: "rag",
          title: "אוף־ליין",
          bottomLine:
            "מצאתי מידע רלוונטי במאגר האוף־ליין. זו תשובה התחלתית בלבד.",
          steps: hits.slice(0, 3).map((h) => h.text.slice(0, 220)),
          cautions: ["זוהי תשובת אוף־ליין. אמת מול מקורות רשמיים לפני ביצוע עבודה."],
          sources: hits.map((h) => ({ title: h.title, section: h.section })),
          confidence: "medium",
        };
        setAnswer(offlineAnswer);
        setMessages((prev) =>
          [
            ...prev,
            {
              role: "assistant" as const,
              content: offlineAnswer.bottomLine,
              createdAt: new Date().toISOString(),
            },
          ].slice(-20)
        );
      }

      await db.history.add({
        id: nanoid(),
        q: question,
        a: hits.length ? "נמצאה תשובת אוף־ליין התחלתית עם מקורות." : "לא נמצאה התאמה מקומית.",
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
            style={{ width: 190, maxWidth: "100%" }}
            value={modeHint}
            onChange={(e) => setModeHint(e.target.value as "auto" | "calc" | "flow" | "rag")}
          >
            <option value="auto">מצב: אוטומטי</option>
            <option value="calc">מצב: מחשבונים</option>
            <option value="flow">מצב: אבחון תקלות</option>
            <option value="rag">מצב: תקנים/חוק</option>
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

          <span className="badge">{online ? "מחובר" : "אוף־ליין"}</span>
          {answer?.confidence && (
            <span className="badge">ביטחון: {answer.confidence}</span>
          )}
          <button
            className="btn"
            onClick={() => {
              setConversationHistory([]);
              setMessages([]);
              setConversationId(nanoid());
              setChatState({ topic: "general", stage: "collecting", slots: {} });
            }}
            disabled={busy || conversationHistory.length === 0}
            title="נקה הקשר שיחה"
          >
            נקה הקשר
          </button>
        </div>

        {messages.length > 0 && (
          <div className="card" style={{ marginTop: 10, padding: 12 }}>
            <div className="small" style={{ fontWeight: 700, marginBottom: 8 }}>
              שיחה
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {messages.slice(-8).map((m, i) => (
                <div
                  key={`${m.createdAt || i}-${i}`}
                  className="small"
                  style={{
                    alignSelf: m.role === "user" ? "end" : "start",
                    background: m.role === "user" ? "rgba(38,162,255,0.16)" : "rgba(255,255,255,0.06)",
                    border: "1px solid var(--border)",
                    borderRadius: 10,
                    padding: "8px 10px",
                    maxWidth: "92%",
                  }}
                >
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>
                    {m.role === "user" ? "אתה" : "העוזר"}
                  </div>
                  <div>{m.content}</div>
                </div>
              ))}
            </div>
          </div>
        )}

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
            <div className="h2">
              תשובה{answer.title ? ` — ${answer.title}` : ""}
            </div>
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

              {(answer.cautions?.length ?? 0) > 0 && (
                <div>
                  <div className="small" style={{ fontWeight: 700 }}>
                    זהירות:
                  </div>
                  <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                    {(answer.cautions || []).map((c, i) => (
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

            {(answer.sources?.length ?? 0) > 0 && (
              <>
                <hr />
                <div className="h2">מקורות</div>
                <ul
                  className="small"
                  style={{ margin: 0, paddingInlineStart: 18 }}
                >
                  {(answer.sources || []).map((c, i) => (
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
              רמת ביטחון: {answer.confidence}
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}

