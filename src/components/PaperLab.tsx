import type { Direction, Filters, Horizon } from "@/lib/engine";

export type Trade = {
  id: number; dir: Direction; entry: number; stop: number; target: number; qty: number; time: number;
  exit?: number; pnl?: number; fee?: number; r?: number; outcome?: "stop" | "target" | "timeout" | "manual"; closedAt?: number;
  horizon?: Horizon; expiresAt?: number; feePct?: number; confidence?: number; filters?: Filters;
  taker?: number | null; book?: number | null; pressureOk?: boolean; expectedR?: number | null;
};

const fmt = (n: number, d = 2) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const dirLabel: Record<Direction, string> = { LONG: "شراء", SHORT: "بيع", NEUTRAL: "انتظار" };
const outLabel = { stop: "وقف", target: "هدف", timeout: "انتهاء الأفق", manual: "يدوي" };

/** Group closed paper trades by whether buy/sell pressure agreed at entry. */
export function summarize(closed: Trade[]) {
  const g = (xs: Trade[]) => ({
    n: xs.length,
    win: xs.length ? (xs.filter((t) => (t.pnl ?? 0) > 0).length / xs.length) * 100 : 0,
    avgR: xs.length ? xs.reduce((a, t) => a + (t.r ?? 0), 0) / xs.length : 0,
    exp: xs.filter((t) => t.expectedR != null).length ? xs.reduce((a, t) => a + (t.expectedR ?? 0), 0) / xs.filter((t) => t.expectedR != null).length : null,
  });
  return { all: g(closed), agree: g(closed.filter((t) => t.pressureOk)), against: g(closed.filter((t) => t.pressureOk === false)) };
}

export function PaperLab({ trades, stale, onClose, onClear }: { trades: Trade[]; stale: boolean; onClose: (id: number) => void; onClear: () => void }) {
  const closed = trades.filter((t) => t.exit !== undefined);
  const s = summarize(closed);
  const tone = (d: Direction) => (d === "LONG" ? "text-bull" : d === "SHORT" ? "text-bear" : "");

  return (
    <div className="panel p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">التداول الورقي ومقارنة المرشحات</h2>
        {closed.length > 0 && <button onClick={onClear} className="text-xs text-muted-foreground hover:text-foreground">مسح المغلقة</button>}
      </div>

      <details className="mb-4 rounded-md border border-border p-3 text-sm" open={trades.length === 0}>
        <summary className="cursor-pointer font-medium">كيف تجرّب صفقة ورقية قبل الاعتماد على الإشارة؟</summary>
        <ol className="mt-3 list-decimal space-y-1.5 pr-5 leading-relaxed text-muted-foreground">
          <li>اختر الأفق (5m أو 15m أو 1h) من أعلى العمود الجانبي، وراجع جدول «مختبر الأفق»: هل التوقع موجب في <b>الفترة المستقلة</b>؟</li>
          <li>اترك مرشح ضغط الشراء/البيع <b>متوقفًا</b> أولًا. التطبيق يسجّل مع كل صفقة هل كان الضغط متوافقًا أم لا، حتى لو كان المرشح متوقفًا.</li>
          <li>عند ظهور «شراء» أو «بيع» اضغط «فتح صفقة ورقية». تُغلق الصفقة تلقائيًا عند الوقف أو الهدف أو انتهاء الأفق، وتُخصم الرسوم.</li>
          <li>كرر ذلك حتى تجمع 20–30 صفقة على الأقل، ثم قارن الصفين أدناه: «الضغط متوافق» مقابل «الضغط معاكس».</li>
          <li>قارن متوسط R الفعلي مع «المتوقع من الاختبار المستقل». اعتمد على المرشح فقط إذا كان المتوافق أفضل بوضوح <b>والفعلي قريب من المتوقع وموجب</b>.</li>
        </ol>
      </details>

      <div className="mb-4 overflow-x-auto">
        <table className="w-full font-mono text-xs">
          <thead className="font-sans text-muted-foreground"><tr className="text-right"><th className="py-1.5">المجموعة</th><th>صفقات</th><th>إصابة</th><th>متوسط R الفعلي</th><th>المتوقع (مستقل)</th></tr></thead>
          <tbody>
            {([["الكل", s.all], ["الضغط متوافق", s.agree], ["الضغط معاكس", s.against]] as const).map(([k, g]) => (
              <tr key={k} className="border-t border-border">
                <td className="py-1.5 font-sans">{k}</td><td>{g.n}</td><td>{g.n ? `${g.win.toFixed(0)}%` : "—"}</td>
                <td className={!g.n ? "" : g.avgR > 0 ? "text-bull" : "text-bear"} dir="ltr">{g.n ? `${g.avgR.toFixed(2)}R` : "—"}</td>
                <td dir="ltr">{g.exp === null ? "—" : `${g.exp.toFixed(2)}R`}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {s.all.n > 0 && s.all.n < 20 && <p className="mt-2 text-xs text-muted-foreground">العينة صغيرة ({s.all.n} صفقة) — النتائج غير موثوقة إحصائيًا بعد.</p>}
      </div>

      {trades.length === 0 ? <p className="text-sm text-muted-foreground">لا توجد صفقات بعد.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full font-mono text-xs">
            <thead className="font-sans text-muted-foreground"><tr className="text-right">
              <th className="py-2">الاتجاه</th><th>الأفق</th><th>الدخول</th><th>الخروج</th><th>الضغط</th><th>المرشحات</th><th>النتيجة</th><th>R</th><th></th>
            </tr></thead>
            <tbody>
              {trades.slice(0, 20).map((t) => (
                <tr key={t.id} className="border-t border-border">
                  <td className={`py-2 ${tone(t.dir)}`}>{dirLabel[t.dir]} {t.confidence ? `${t.confidence}%` : ""}</td>
                  <td>{t.horizon ?? "5m"}</td>
                  <td>{fmt(t.entry)}</td>
                  <td>{t.exit !== undefined ? fmt(t.exit) : t.expiresAt ? `حتى ${new Date(t.expiresAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : "مفتوحة"}</td>
                  <td className={t.pressureOk === undefined ? "" : t.pressureOk ? "text-bull" : "text-bear"}>{t.pressureOk === undefined ? "—" : t.pressureOk ? "متوافق" : "معاكس"}</td>
                  <td className="font-sans">{t.filters ? [t.filters.htfTrend && "فريم", t.filters.volume && "حجم", t.filters.pressure && "ضغط"].filter(Boolean).join("+") || "لا شيء" : "—"}</td>
                  <td className="font-sans">{t.outcome ? outLabel[t.outcome] : "—"}</td>
                  <td className={t.r === undefined ? "" : t.r >= 0 ? "text-bull" : "text-bear"} dir="ltr">{t.r === undefined ? (t.pnl !== undefined ? fmt(t.pnl) : "—") : t.r.toFixed(2)}</td>
                  <td>{t.exit === undefined && <button onClick={() => onClose(t.id)} disabled={stale} className="rounded border border-border px-2 py-0.5 text-xs hover:bg-secondary disabled:opacity-40">إغلاق</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
