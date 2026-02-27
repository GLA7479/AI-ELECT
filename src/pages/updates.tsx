import Layout from "../../components/Layout";

export default function Updates() {
  return (
    <Layout>
      <h1 className="h1">עדכונים</h1>
      <div className="card">
        <div className="small">
          בגרסה הזו זה דף תצוגה בלבד. בגרסה הבאה נחבר מנגנון שמושך עדכונים
          ממקורות רשמיים (gov.il / הכנסת / משרד העבודה), שומר גרסאות ומציג
          “מה השתנה”.
        </div>
        <hr />
        <div className="badge">סטטוס: MVP</div>
      </div>
    </Layout>
  );
}

