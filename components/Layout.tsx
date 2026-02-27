"use client";

import Link from "next/link";
import { ReactNode, useEffect, useState } from "react";

function useOnlineStatus() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return online;
}

export default function Layout({ children }: { children: ReactNode }) {
  const online = useOnlineStatus();

  return (
    <div className="container">
      <div className="nav">
        <div className="navLinks">
          <Link href="/" className="badge">
            שאל את המומחה
          </Link>
          <Link href="/library" className="badge">
            מאגר
          </Link>
          <Link href="/offline" className="badge">
            אוף־ליין
          </Link>
          <Link href="/updates" className="badge">
            עדכונים
          </Link>
          <Link href="/history" className="badge">
            היסטוריה
          </Link>
          <Link href="/admin" className="badge">
            ניהול מאגר
          </Link>
        </div>
        <span className="badge navStatus">{online ? "מחובר" : "אוף־ליין"}</span>
      </div>

      {children}

      <div style={{ marginTop: 18 }} className="small">
        ⚠️ הכלי מציג מידע כללי ומחזיר ציטוטים כשיש. לפני עבודה בשטח—פועלים
        לפי התקנות/תקנים והנחיות בטיחות.
      </div>
    </div>
  );
}

