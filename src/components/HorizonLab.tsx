import { useMemo, useState } from "react";
import { DEFAULT_FILTERS, NO_FILTERS, walkForward, type BacktestStats, type Candle, type Filters, type Horizon } from "@/lib/engine";

const SETS: { key: string; label: string; f: Filters }[] = [
  { key: "none", label: "بدون مرشحات", f: NO_FILTERS },
  { key: "base", label: "فريم أعلى + حجم", f: DEFAULT_FILTERS },
  { key: "pressure", label: "فريم أعلى + حجم + ضغط", f: { ...DEFAULT_FILTERS, pressure: true } },
  { key: "ponly", label: "ضغط فقط", f: { ...NO_FILTERS, pressure: true } },
];

const cell = (s: BacktestStats) => (
  <div className="font-mono text-xs leading-5" dir="ltr">
    <span className={s.expectancy > 0 ? "text-bull" : "text-bear"}>{s.expectancy.toFixed(3)}R</span>
    <span className="text-muted-foreground"> · {s.trades}t · {s.winRate.toFixed(0)}%</span>
  </div>
);

/** In-sample vs untouched out-of-sample comparison for 15m and 1h, net of fees, per filter set. */
export function HorizonLab({ data, feePct, onFeeChange }: { data: Record<"15m" | "1h", Candle[]>; feePct: number; onFeeChange: (v: number) => void }) {
  const [h, setH] = useState<"15m" | "1h">("15m");
  const c = data[h];
  const rows = useMemo(() => (c.length > 400 ? SETS.map((s) => ({ ...s, w: walkForward(c.slice(0, -1), s.f, feePct, h as Horizon) })) : null), [c, feePct, h]);
  const base = rows?.find((r) => r.key === "base");
  const withP = rows?.find((r) => r.key === "pressure");
  const delta = base && withP ? withP.w.outSample.expectancy - base.w.outSample.expectancy : 0;
  const fmtDate = (t: number) => new Date(t * 1000).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

  return (
    <div className="panel p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">مختبر الأفق — 15 دقيقة وساعة (بعد الرسوم)</h2>
        <div className="flex items-center gap-2 text-xs">
          {(["15m", "1h"] as const).map((x) => (
            <button key={x} onClick={() => setH(x)} className={`rounded-md border px-3 py-1 font-mono ${h === x ? "border-primary text-primary" : "border-border text-muted-foreground"}`}>{x}</button>
          ))}
          <label className="flex items-center gap-1 text-muted-foreground">
            الرسوم
            <select value={feePct} onChange={(e) => onFeeChange(+e.target.value)} className="rounded-md border border-input bg-background px-1 py-1 font-mono">
              {[0, 0.05, 0.1, 0.2].map((v) => <option key={v} value={v}>{v}%</option>)}
            </select>
          </label>
        </div>
      </div>
      {!rows ? <p className="text-sm text-muted-foreground">جارٍ تحميل {h === "15m" ? "~20 يومًا" : "~83 يومًا"} من الشموع…</p> : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground"><tr className="text-right">
                <th className="py-2">المرشحات</th>
                <th>فترة التدريب ({fmtDate(c[0].time)} – {fmtDate(rows[0].w.splitTime)})</th>
                <th>فترة مستقلة ({fmtDate(rows[0].w.splitTime)} – الآن)</th>
                <th>الحكم</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="border-t border-border">
                    <td className="py-2">{r.label}</td>
                    <td>{cell(r.w.inSample)}</td>
                    <td>{cell(r.w.outSample)}</td>
                    <td className="text-xs">{r.w.robust ? <span className="text-bull">صامد في الفترتين</span> : r.w.inSample.expectancy > 0 && r.w.outSample.expectancy <= 0 ? <span className="text-bear">إفراط ملاءمة محتمل</span> : <span className="text-muted-foreground">لا أفضلية</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            القيم: متوسط الربح لكل صفقة بوحدة R · عدد الصفقات · نسبة الإصابة. القواعد ثابتة ولا تُضبط على الفترة المستقلة (آخر 30%).{" "}
            أثر مرشح الضغط على الفترة المستقلة: <span className={delta > 0 ? "text-bull" : "text-bear"} dir="ltr">{delta >= 0 ? "+" : ""}{delta.toFixed(3)}R</span> لكل صفقة.
            {" "}الاختبار الرجعي يستخدم ضغط المشترين الفعلي (نسبة الشراء العدواني) لأن Binance لا يوفر سجلًا تاريخيًا لدفتر الأوامر؛ في الوقت الحي يُضاف شرط اختلال الدفتر.
          </p>
        </>
      )}
    </div>
  );
}
