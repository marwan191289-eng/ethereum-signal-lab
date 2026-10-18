import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ClientOnly } from "@tanstack/react-router";
import { useMarketData } from "@/hooks/use-market-data";
import { applyFilters, backtestFiltered, DEFAULT_FILTERS, type Filters, computeSignal, positionSize, type Direction } from "@/lib/engine";

const PriceChart = lazy(() => import("@/components/PriceChart"));

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ETH Intelligence — إشارات ETH/USDT لحظية" },
      { name: "description", content: "محرك إشارات وتنبؤات لحظية لـ ETH/USDT بأفق 5 دقائق ببيانات Binance الحية وإدارة مخاطرة 1%." },
      { property: "og:title", content: "ETH Intelligence — إشارات ETH/USDT لحظية" },
      { property: "og:description", content: "إشارات وتنبؤات 5 دقائق ببيانات Binance الحية ومخاطرة 1%." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

const RISK = 1;

type Trade = { id: number; dir: Direction; entry: number; stop: number; target: number; qty: number; time: number; exit?: number; pnl?: number };

const fmt = (n: number, d = 2) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const dirLabel: Record<Direction, string> = { LONG: "شراء", SHORT: "بيع", NEUTRAL: "انتظار" };

function Dashboard() {
  const [equity, setEquity] = useState(10000);
  const [alerts, setAlerts] = useState(true);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [history, setHistory] = useState<{ t: number; dir: Direction; conf: number; price: number }[]>([]);
  const lastDir = useRef<Direction>("NEUTRAL");

  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem("ethi") || "{}");
      if (s.equity) setEquity(s.equity);
      if (s.trades) setTrades(s.trades);
    } catch {}
  }, []);
  useEffect(() => { localStorage.setItem("ethi", JSON.stringify({ equity, trades })); }, [equity, trades]);

  const market = useMarketData();
  const { candles, stale, status } = market;
  const live = status === "live" && !stale;
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">("default");
  useEffect(() => { setPerm(typeof Notification === "undefined" ? "unsupported" : Notification.permission); }, []);

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const sig = useMemo(() => (candles.length > 50 ? applyFilters(candles, candles.length - 1, computeSignal(candles), filters) : null), [candles, filters]);
  const lastT = candles.length > 0 ? candles[candles.length - 1].time : 0;
  const bt = useMemo(() => (candles.length > 300 ? backtestFiltered(candles.slice(0, -1), filters, 0.1, 250) : null), [lastT, filters]);
  const btRaw = useMemo(() => (candles.length > 300 ? backtestFiltered(candles.slice(0, -1), { htfTrend: false, volume: false }, 0.1, 250) : null), [lastT]);
  const size = sig ? positionSize(equity, RISK, sig.price, sig.stop) : null;

  // Alerts on direction change
  useEffect(() => {
    if (!sig || sig.direction === lastDir.current) return;
    const prev = lastDir.current;
    lastDir.current = sig.direction;
    setHistory((h) => [{ t: Date.now(), dir: sig.direction, conf: sig.confidence, price: sig.price }, ...h].slice(0, 30));
    if (prev !== "NEUTRAL" || sig.direction !== "NEUTRAL") {
      if (alerts && !stale && sig.direction !== "NEUTRAL" && typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification(`ETH ${dirLabel[sig.direction]} — ثقة ${sig.confidence}%`, { body: `السعر ${fmt(sig.price)} | وقف ${fmt(sig.stop)} | هدف ${fmt(sig.target)}` });
      }
    }
  }, [sig?.direction]);

  // Close paper trades on stop / target
  useEffect(() => {
    if (!sig || stale) return;
    const p = sig.price;
    let realized = 0;
    const next = trades.map((t) => {
      if (t.exit !== undefined) return t;
      const hitStop = t.dir === "LONG" ? p <= t.stop : p >= t.stop;
      const hitTarget = t.dir === "LONG" ? p >= t.target : p <= t.target;
      if (!hitStop && !hitTarget) return t;
      const exit = hitStop ? t.stop : t.target;
      const pnl = (t.dir === "LONG" ? exit - t.entry : t.entry - exit) * t.qty;
      realized += pnl;
      return { ...t, exit, pnl };
    });
    if (realized !== 0) { setTrades(next); setEquity((e) => e + realized); }
  }, [sig?.price]);

  const closeTrade = (id: number) => {
    if (!sig || stale) return;
    const p = sig.price;
    let realized = 0;
    setTrades((all) => all.map((t) => {
      if (t.id !== id || t.exit !== undefined) return t;
      const pnl = (t.dir === "LONG" ? p - t.entry : t.entry - p) * t.qty;
      realized = pnl;
      return { ...t, exit: p, pnl };
    }));
    setEquity((e) => e + realized);
  };

  const openTrade = () => {
    if (stale || !sig || !size || sig.direction === "NEUTRAL") return;
    setTrades((t) => [{ id: Date.now(), dir: sig.direction, entry: sig.price, stop: sig.stop, target: sig.target, qty: size.qty, time: Date.now() }, ...t]);
  };

  const toggleAlerts = async () => {
    if (!alerts && typeof Notification !== "undefined" && Notification.permission === "default") {
      setPerm(await Notification.requestPermission());
    }
    setAlerts(!alerts);
  };

  const prevClose = candles.length > 1 ? candles[candles.length - 2].close : 0;
  const change = sig && prevClose ? ((sig.price - prevClose) / prevClose) * 100 : 0;
  const tone = (d?: Direction) => (d === "LONG" ? "text-bull" : d === "SHORT" ? "text-bear" : "text-muted-foreground");

  return (
    <div dir="rtl" className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-md bg-primary font-mono text-lg font-bold text-primary-foreground">Ξ</div>
            <div>
              <h1 className="text-lg font-bold leading-none">ETH Intelligence</h1>
              <p className="mt-1 font-mono text-xs text-muted-foreground">ETH/USDT · 5m · RISK {RISK}%</p>
            </div>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="flex items-center gap-2 rounded-full border border-border px-3 py-1 font-mono text-xs">
              <span className={`h-2 w-2 rounded-full ${live ? "bg-bull animate-pulse" : "bg-bear"}`} />
              {live ? "Binance LIVE" : status === "error" ? "انقطع الاتصال" : status === "connecting" ? "جارٍ الاتصال…" : "بيانات متأخرة"}
            </span>
            {(status === "error" || stale) && status !== "connecting" && (
              <button onClick={market.retry} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-secondary">إعادة الاتصال</button>
            )}
            <button onClick={toggleAlerts} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-secondary">
              التنبيهات: {!alerts ? "متوقفة" : perm === "granted" ? "مفعّلة" : perm === "denied" ? "محظورة من المتصفح" : perm === "unsupported" ? "غير مدعومة" : "بانتظار الإذن"}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-4 px-6 py-6 lg:grid-cols-[1fr_340px]">
        <section className="space-y-4">
          <div className="panel p-5">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-xs text-muted-foreground">السعر الحالي</p>
                <p className="font-mono text-4xl font-bold">{sig ? fmt(sig.price) : "—"}</p>
                <p className={`font-mono text-sm ${change >= 0 ? "text-bull" : "text-bear"}`}>{change >= 0 ? "+" : ""}{change.toFixed(3)}% (شمعة)</p>
              </div>
              <div className="text-left">
                <p className="text-xs text-muted-foreground">التنبؤ بعد 5 دقائق</p>
                <p className={`font-mono text-2xl font-semibold ${tone(sig?.direction)}`}>{sig ? fmt(sig.forecast) : "—"}</p>
              </div>
            </div>
            <div className="mt-4 overflow-hidden rounded-md">
              <ClientOnly fallback={<div className="h-[440px] animate-pulse bg-muted" />}>
                <Suspense fallback={<div className="h-[440px] animate-pulse bg-muted" />}>
                  <PriceChart candles={candles} />
                </Suspense>
              </ClientOnly>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-4">
            {[
              ["EMA 9 / 21", sig ? `${fmt(sig.ema9)} / ${fmt(sig.ema21)}` : "—"],
              ["RSI 14", sig ? sig.rsi.toFixed(1) : "—"],
              ["MACD Hist", sig ? sig.macdHist.toFixed(3) : "—"],
              ["ATR 14", sig ? fmt(sig.atr) : "—"],
            ].map(([k, v]) => (
              <div key={k} className="panel p-4">
                <p className="text-xs text-muted-foreground">{k}</p>
                <p className="mt-1 font-mono text-sm font-semibold" dir="ltr">{v}</p>
              </div>
            ))}
          </div>

          <div className="panel p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">اختبار رجعي (آخر 750 شمعة، شامل رسوم 0.1%)</h2>
              <div className="flex gap-2 text-xs">
                {([["htfTrend", "تأكيد الفريم الأعلى"], ["volume", "فلتر الحجم"]] as const).map(([k, l]) => (
                  <button key={k} onClick={() => setFilters((f) => ({ ...f, [k]: !f[k] }))}
                    className={`rounded-md border px-3 py-1 ${filters[k] ? "border-primary text-primary" : "border-border text-muted-foreground"}`}>
                    {filters[k] ? "✓ " : ""}{l}
                  </button>
                ))}
              </div>
            </div>
            {bt ? (
              <div className="grid grid-cols-2 gap-4 font-mono text-sm sm:grid-cols-5">
                <Stat k="عدد الإشارات" v={String(bt.trades)} />
                <Stat k="نسبة الإصابة" v={`${bt.winRate.toFixed(1)}%`} />
                <Stat k="الربح (R)" v={bt.pnlR.toFixed(2)} />
                <Stat k="التوقع / صفقة" v={`${bt.expectancy.toFixed(3)}R`} />
                <Stat k="أقصى تراجع" v={`${bt.maxDD.toFixed(2)}R`} />
              </div>
            ) : <p className="text-sm text-muted-foreground">جارٍ التحميل…</p>}
            {bt && btRaw && (
              <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                بدون فلاتر: {btRaw.trades} إشارة، {btRaw.pnlR.toFixed(2)}R.{" "}
                {bt.expectancy > 0 ? "النتيجة الحالية إيجابية على هذه الفترة فقط — لا تضمن المستقبل." : "لا توجد أفضلية مؤكدة بعد الرسوم — استخدمها للتحليل لا للتداول الحقيقي."}
              </p>
            )}
          </div>

          <div className="panel p-5">
            <h2 className="mb-3 font-semibold">التداول الورقي</h2>
            {trades.length === 0 ? <p className="text-sm text-muted-foreground">لا توجد صفقات بعد.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full font-mono text-xs">
                  <thead className="text-muted-foreground"><tr className="text-right">
                    <th className="py-2">الاتجاه</th><th>الدخول</th><th>الوقف</th><th>الهدف</th><th>الكمية</th><th>الخروج</th><th>الربح</th><th></th>
                  </tr></thead>
                  <tbody>
                    {trades.slice(0, 15).map((t) => (
                      <tr key={t.id} className="border-t border-border">
                        <td className={`py-2 ${tone(t.dir)}`}>{dirLabel[t.dir]}</td>
                        <td>{fmt(t.entry)}</td><td>{fmt(t.stop)}</td><td>{fmt(t.target)}</td><td>{t.qty.toFixed(4)}</td>
                        <td>{t.exit ? fmt(t.exit) : "مفتوحة"}</td>
                        <td className={t.pnl === undefined ? "" : t.pnl >= 0 ? "text-bull" : "text-bear"}>{t.pnl === undefined ? "—" : fmt(t.pnl)}</td>
                        <td>{t.exit === undefined && <button onClick={() => closeTrade(t.id)} disabled={stale} className="rounded border border-border px-2 py-0.5 text-xs hover:bg-secondary disabled:opacity-40">إغلاق</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        <aside className="space-y-4">
          <div className={`panel p-5 ${sig?.direction === "LONG" ? "glow-bull" : sig?.direction === "SHORT" ? "glow-bear" : ""}`}>
            <p className="text-xs text-muted-foreground">الإشارة الحالية</p>
            <p className={`mt-1 text-4xl font-bold ${tone(sig?.direction)}`}>{sig ? dirLabel[sig.direction] : "—"}</p>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
              <div className={`h-full ${sig?.direction === "SHORT" ? "bg-bear" : "bg-bull"}`} style={{ width: `${sig?.confidence ?? 0}%` }} />
            </div>
            <p className="mt-1 font-mono text-xs text-muted-foreground">الثقة {sig?.confidence ?? 0}%</p>
            <ul className="mt-4 space-y-1.5 text-sm">
              {sig?.reasons.map((r) => <li key={r} className="flex gap-2"><span className="text-primary">•</span>{r}</li>)}
            </ul>
          </div>

          <div className="panel p-5">
            <h2 className="mb-3 font-semibold">إدارة المخاطرة 1%</h2>
            <label className="text-xs text-muted-foreground">رأس المال (USDT)</label>
            <input type="number" value={Math.round(equity * 100) / 100} onChange={(e) => setEquity(+e.target.value || 0)}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm" dir="ltr" />
            <div className="mt-4 space-y-2 font-mono text-sm">
              <Row k="المخاطرة" v={size ? `${fmt(size.riskAmount)} USDT` : "—"} />
              <Row k="وقف الخسارة" v={sig ? fmt(sig.stop) : "—"} />
              <Row k="الهدف (1.33R)" v={sig ? fmt(sig.target) : "—"} />
              <Row k="الكمية" v={size ? `${size.qty.toFixed(4)} ETH` : "—"} />
              <Row k="حجم المركز" v={size ? `${fmt(size.notional)} USDT` : "—"} />
            </div>
            <button onClick={openTrade} disabled={stale || !sig || sig.direction === "NEUTRAL"}
              className="mt-4 w-full rounded-md bg-primary py-2.5 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40">
              فتح صفقة ورقية
            </button>
            {stale && <p className="mt-2 text-xs text-bear">الأسعار غير محدّثة — التداول الورقي متوقف مؤقتًا.</p>}
          </div>

          <div className="panel p-5">
            <h2 className="mb-3 font-semibold">سجل الإشارات</h2>
            <ul className="space-y-2 font-mono text-xs">
              {history.length === 0 && <li className="text-muted-foreground">بانتظار تغيّر الإشارة…</li>}
              {history.map((h) => (
                <li key={h.t} className="flex justify-between border-b border-border pb-1.5">
                  <span className={tone(h.dir)}>{dirLabel[h.dir]} {h.conf}%</span>
                  <span>{fmt(h.price)}</span>
                  <span className="text-muted-foreground">{new Date(h.t).toLocaleTimeString("en-GB")}</span>
                </li>
              ))}
            </ul>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">تنبيه: إشارات تحليلية تجريبية وليست نصيحة استثمارية. التداول الورقي فقط — لا تنفيذ أوامر حقيقية.</p>
        </aside>
      </main>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return <div><p className="font-sans text-xs text-muted-foreground">{k}</p><p className="mt-1 font-semibold" dir="ltr">{v}</p></div>;
}
function Row({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between"><span className="font-sans text-muted-foreground">{k}</span><span dir="ltr">{v}</span></div>;
}
