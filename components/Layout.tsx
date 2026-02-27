"use client";

import Link from "next/link";
import { ReactNode } from "react";

export default function Layout({ children }: { children: ReactNode }) {
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
      </div>

      {children}

      <div style={{ marginTop: 18 }} className="small">
        ⚠️ הכלי מציג מידע כללי ומחזיר ציטוטים כשיש. לפני עבודה בשטח—פועלים
        לפי התקנות/תקנים והנחיות בטיחות.
      </div>
    </div>
  );
}

