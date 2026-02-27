import { useEffect, useState } from "react";
import Layout from "../../components/Layout";
import { db } from "../../lib/db";
import { DEMO_PACK_ID, demoChunks } from "../../lib/demoPack";

export default function Offline() {
  const [installed, setInstalled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(0);

  async function refresh() {
    const pack = await db.packs.get(DEMO_PACK_ID);
    setInstalled(!!pack);
    setCount(await db.chunks.count());
  }

  useEffect(() => {
    refresh();
  }, []);

  async function installDemo() {
    setBusy(true);
    try {
      await db.transaction("rw", db.packs, db.chunks, async () => {
        await db.packs.put({
          id: DEMO_PACK_ID,
          name: "חבילת דמו בסיסית",
          version: "0.1.0",
          installedAt: new Date().toISOString(),
        });
        // replace existing demo chunks
        await db.chunks.clear();
        await db.chunks.bulkAdd(demoChunks);
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function removeAll() {
    setBusy(true);
    try {
      await db.transaction("rw", db.packs, db.chunks, async () => {
        await db.packs.clear();
        await db.chunks.clear();
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Layout>
      <h1 className="h1">אוף־ליין</h1>
      <div className="card">
        <div className="small">
          כאן ננהל “חבילות ידע” שמורידים מראש למכשיר כדי לעבוד גם בלי קליטה.
        </div>
        <hr />
        <div className="row">
          <button className="btn" onClick={installDemo} disabled={busy}>
            {busy ? "מעדכן..." : "התקן חבילת דמו"}
          </button>
          <button className="btn" onClick={removeAll} disabled={busy}>
            מחק הכל
          </button>
          <span className="badge">
            {installed ? "דמו מותקן" : "אין חבילות מותקנות"}
          </span>
          <span className="badge">פריטים במאגר: {count}</span>
        </div>
      </div>
    </Layout>
  );
}

