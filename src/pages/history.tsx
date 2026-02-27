import { useEffect, useState } from "react";
import Layout from "../../components/Layout";
import { db, type ChatHistory } from "../../lib/db";

export default function HistoryPage() {
  const [items, setItems] = useState<ChatHistory[]>([]);

  useEffect(() => {
    (async () => {
      const rows = await db.history
        .orderBy("createdAt")
        .reverse()
        .limit(50)
        .toArray();
      setItems(rows);
    })();
  }, []);

  return (
    <Layout>
      <h1 className="h1">היסטוריה</h1>
      <div className="card">
        {items.length === 0 ? (
          <div className="small">אין עדיין היסטוריה.</div>
        ) : (
          <div className="row" style={{ flexDirection: "column" }}>
            {items.map((it) => (
              <div key={it.id} className="card" style={{ padding: 14 }}>
                <div className="small">
                  {new Date(it.createdAt).toLocaleString("he-IL")} · {it.mode}
                </div>
                <div style={{ marginTop: 6, fontWeight: 700 }}>שאלה:</div>
                <div style={{ lineHeight: 1.7 }}>{it.q}</div>
                <div style={{ marginTop: 8, fontWeight: 700 }}>
                  תשובה (תקציר):
                </div>
                <div className="small" style={{ lineHeight: 1.7 }}>
                  {it.a}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}

