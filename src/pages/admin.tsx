"use client";

import { useEffect, useState } from "react";
import Layout from "../../components/Layout";
import { getSupabaseClient } from "../../lib/supabase";

type Source = {
  id: string;
  title: string;
  url: string | null;
  publisher: string | null;
  doc_type: string | null;
  version: string | null;
  created_at: string;
};

export default function AdminPage() {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(false);

  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [publisher, setPublisher] = useState("gov.il");
  const [docType, setDocType] = useState("law");
  const [envError, setEnvError] = useState<string | null>(null);

  async function refresh() {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from("sources")
      .select("id,title,url,publisher,doc_type,version,created_at")
      .order("created_at", { ascending: false })
      .limit(50);
    setSources((data || []) as any);
  }

  useEffect(() => {
    refresh().catch((err: unknown) => {
      setEnvError(err instanceof Error ? err.message : String(err));
    });
  }, []);

  async function addSource() {
    const t = title.trim();
    if (!t) return;
    setLoading(true);
    try {
      const supabase = getSupabaseClient();
      const { error } = await supabase.from("sources").insert({
        title: t,
        url: url.trim() || null,
        publisher: publisher.trim() || null,
        doc_type: docType.trim() || null,
        version: "v1",
      });
      if (error) throw error;
      setTitle("");
      setUrl("");
      await refresh();
    } catch (err: any) {
      alert(`שגיאה: ${err.message || String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Layout>
      <h1 className="h1">ניהול מאגר (Admin)</h1>

      {envError ? (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="small">שגיאת הגדרה: {envError}</div>
        </div>
      ) : null}

      <div className="card">
        <div className="h2">הוסף מקור</div>
        <div className="row">
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="כותרת מקור (למשל: חוק החשמל)"
          />
          <input
            className="input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="קישור (אופציונלי)"
          />
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <input
            className="input"
            value={publisher}
            onChange={(e) => setPublisher(e.target.value)}
            placeholder="publisher (gov.il / knesset / labor)"
          />
          <input
            className="input"
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
            placeholder="doc_type (law/regulation/guideline)"
          />
          <button className="btn" onClick={addSource} disabled={loading}>
            {loading ? "מוסיף..." : "הוסף מקור"}
          </button>
        </div>
      </div>

      <div style={{ height: 14 }} />

      <div className="card">
        <div className="h2">מקורות קיימים</div>
        {sources.length === 0 ? (
          <div className="small">אין מקורות עדיין.</div>
        ) : (
          <div className="row" style={{ flexDirection: "column" }}>
            {sources.map((s) => (
              <div key={s.id} className="card" style={{ padding: 14 }}>
                <div style={{ fontWeight: 800 }}>{s.title}</div>
                <div className="small">
                  {s.publisher || ""} · {s.doc_type || ""} ·{" "}
                  {new Date(s.created_at).toLocaleString("he-IL")}
                </div>
                {s.url ? (
                  <div className="small" style={{ marginTop: 6 }}>
                    <a href={s.url} target="_blank" rel="noreferrer">
                      פתח מקור
                    </a>
                  </div>
                ) : null}
                <div className="small" style={{ marginTop: 6 }}>
                  source_id: {s.id}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
