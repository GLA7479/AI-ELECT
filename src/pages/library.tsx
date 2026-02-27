import { useEffect, useState } from "react";
import Layout from "../../components/Layout";
import { db, type SourceChunk } from "../../lib/db";
import { offlineSearch } from "../../lib/search";

export default function Library() {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<SourceChunk[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => setItems(await db.chunks.limit(20).toArray()))();
  }, []);

  async function search() {
    setLoading(true);
    try {
      if (!q.trim()) {
        setItems(await db.chunks.limit(50).toArray());
        return;
      }
      setItems(await offlineSearch(q.trim(), 20));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Layout>
      <h1 className="h1">מאגר (אוף־ליין)</h1>
      <div className="card">
        <div className="row">
          <input
            className="input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="חיפוש לפי מילות מפתח..."
          />
          <button className="btn" onClick={search} disabled={loading}>
            {loading ? "מחפש..." : "חפש"}
          </button>
        </div>
        <hr />
        {items.length === 0 ? (
          <div className="small">אין תוצאות.</div>
        ) : (
          <div className="row" style={{ flexDirection: "column" }}>
            {items.map((it) => (
              <div key={it.id} className="card" style={{ padding: 14 }}>
                <div style={{ fontWeight: 700 }}>{it.title}</div>
                <div className="small">{it.section}</div>
                <div style={{ marginTop: 6, lineHeight: 1.7 }}>{it.text}</div>
                <div className="small" style={{ marginTop: 8 }}>
                  תגיות: {it.tags.join(", ")}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}

