import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ClientOnly } from "@tanstack/react-router";
import { useMarketData } from "@/hooks/use-market-data";
import { useHorizonData } from "@/hooks/use-horizon-data";
import { useOrderBook } from "@/hooks/use-order-book";
import { HorizonLab } from "@/components/HorizonLab";
import { PaperLab, type Trade } from "@/components/PaperLab";
import {
  applyFilters, backtestFiltered, DEFAULT_FILTERS, NO_FILTERS, type Filters, computeSignal, positionSize, type Direction,
  type Horizon, HTF_PERIODS, HORIZON_SECONDS, takerBuyRatio, pressureAgrees, walkForward,
} from "@/lib/engine";

const PriceChart = lazy(() => import("@/components/PriceChart"));

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "ETH Intelligence — إشارات ETH/USDT لحظية" },
      { name: "description", content: "محرك إشارات ETH/USDT بآفاق 5 و15 دقيقة وساعة، مع ضغط الشراء والبيع من Binance واختبار مستقل بعد الرسوم." },
      { property: "og:title", content: "ETH Intelligence — إشارات ETH/USDT لحظية" },
      { property: "og:description", content: "إشارات متعددة الآفاق، ضغط دفتر أوامر Binance، واختبار رجعي مستقل بعد الرسوم." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

const RISK = 1;

const fmt = (n: number, d = 2) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const dirLabel: Record<Direction, string> = { LONG: "شراء", SHORT: "بيع", NEUTRAL: "انتظار" };

function Dashboard() {
  const [equity, setEquity] = useState(10000);
  const [alerts, setAlerts] = useState(true);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [history, setHistory] = useState<{ t: number; dir: Direction; conf: number; price: number }[]>([]);
  const [feePct, setFeePct] = useState(0.1);
  const [horizon, setHorizon] = useState<Horizon>("5m");
  const lastDir = useRef<Direction>("NEUTRAL");

  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem("ethi") || "{}");
      if (s.equity) setEquity(s.equity);
      if (s.trades) setTrades(s.trades);
      if (s.filters) setFilters({ ...DEFAULT_FILTERS, ...s.filters });
    } catch {}
  }, []);

  const market = useMarketData();
  const h15 = useHorizonData("15m");
  const h1 = useHorizonData("1h");
  const book = useOrderBook();
  const { candles, stale, status } = market;
  const live = status === "live" && !stale;
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">("default");
  useEffect(() => { setPerm(typeof Notification === "undefined" ? "unsupported" : Notification.permission); }, []);

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  useEffect(() => { localStorage.setItem("ethi", JSON.stringify({ equity, trades, filters })); }, [equity, trades, filters]);

  // Horizon candles: 5m from the live stream; 15m/1h from REST with the in-progress candle's close replaced by the live price.
  const livePrice = candles.length ? candles[candles.length - 1].close : 0;
  const hc = useMemo(() => {
    const src = horizon === "5m" ? candles : horizon === "15m" ? h15.candles : h1.candles;
    if (horizon === "5m" || !src.length || !livePrice) return src;
    const last = src[src.length - 1];
    return [...src.slice(0, -1), { ...last, close: livePrice, high: Math.max(last.high, livePrice), low: Math.min(last.low, livePrice) }];
  }, [horizon, candles, h15.candles, h1.candles, livePrice]);

  const raw = useMemo(() => (hc.length > 50 ? computeSignal(hc) : null), [hc]);
  const sig = useMemo(() => (raw ? applyFilters(hc, hc.length - 1, raw, filters, { periods: HTF_PERIODS[horizon], book: book.imbalance }) : null), [raw, hc, filters, horizon, book.imbalance]);
  const taker = hc.length ? takerBuyRatio(hc, hc.length - 1) : null;
  const pressureOk = raw && raw.direction !== "NEUTRAL" ? pressureAgrees(raw.direction, taker, book.imbalance) : null;

  const lastT = candles.length > 0 ? candles[candles.length - 1].time : 0;
  const bt = useMemo(() => (candles.length > 300 ? backtestFiltered(candles.slice(0, -1), filters, feePct, 250) : null), [lastT, filters, feePct]);
  const btRaw = useMemo(() => (candles.length > 300 ? backtestFiltered(candles.slice(0, -1), NO_FILTERS, feePct, 250) : null), [lastT, feePct]);
  const expectedOOS = useMemo(() => {
    const c = horizon === "15m" ? h15.candles : horizon === "1h" ? h1.candles : candles;
    return c.length > 400 ? walkForward(c.slice(0, -1), filters, feePct, horizon).outSample.expectancy : null;
  }, [horizon, h15.candles, h1.candles, horizon === "5m" ? lastT : 0, filters, feePct]);
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

  const settle = (t: Trade, exit: number, outcome: NonNullable<Trade["outcome"]>): Trade => {
    const gross = (t.dir === "LONG" ? exit - t.entry : t.entry - exit) * t.qty;
    const fee = (t.entry * t.qty * (t.feePct ?? 0)) / 100;
    const risk = Math.abs(t.entry - t.stop) * t.qty;
    const pnl = gross - fee;
    return { ...t, exit, pnl, fee, r: risk > 0 ? pnl / risk : 0, outcome, closedAt: Date.now() };
  };

  // Close paper trades on stop / target / horizon expiry (same rule as the backtest).
  useEffect(() => {
    if (!livePrice || stale) return;
    const p = livePrice;
    let realized = 0;
    let changed = false;
    const now = Date.now();
    const next = trades.map((t) => {
      if (t.exit !== undefined) return t;
      const hitStop = t.dir === "LONG" ? p <= t.stop : p >= t.stop;
      const hitTarget = t.dir === "LONG" ? p >= t.target : p <= t.target;
      const expired = t.expiresAt !== undefined && now >= t.expiresAt;
      if (!hitStop && !hitTarget && !expired) return t;
      const done = settle(t, hitStop ? t.stop : hitTarget ? t.target : p, hitStop ? "stop" : hitTarget ? "target" : "timeout");
      realized += done.pnl!;
      changed = true;
      return done;
    });
    if (changed) { setTrades(next); setEquity((e) => e + realized); }
  }, [livePrice, lastT, Math.floor(Date.now() / 5000)]);

  const closeTrade = (id: number) => {
    if (!livePrice || stale) return;
    const t = trades.find((x) => x.id === id);
    if (!t || t.exit !== undefined) return;
    const done = settle(t, livePrice, "manual");
    setTrades((all) => all.map((x) => (x.id === id ? done : x)));
    setEquity((e) => e + done.pnl!);
  };

  const openTrade = () => {
    if (stale || !sig || !size || sig.direction === "NEUTRAL") return;
    const now = Date.now();
    setTrades((t) => [{
      id: now, dir: sig.direction, entry: sig.price, stop: sig.stop, target: sig.target, qty: size.qty, time: now,
      horizon, expiresAt: now + HORIZON_SECONDS[horizon] * 1000, feePct, confidence: sig.confidence,
      filters: { ...filters }, taker, book: book.imbalance, pressureOk: pressureOk ?? false, expectedR: expectedOOS,
    }, ...t]);
  };
  const clearClosed = () => setTrades((t) => t.filter((x) => x.exit === undefined));

  const toggleAlerts = async () => {
    if (!alerts && typeof Notification !== "undefined" && Notification.permission === "default") {
      setPerm(await Notification.requestPermission());
    }
    setAlerts(!alerts);
  };

  const prevClose = candles.length > 1 ? candles[candles.length - 2].close : 0;
  const change = livePrice && prevClose ? ((livePrice - prevClose) / prevClose) * 100 : 0;
  const tone = (d?: Direction) => (d === "LONG" ? "text-bull" : d === "SHORT" ? "text-bear" : "text-muted-foreground");
  const horizonLabel: Record<Horizon, string> = { "5m": "5 دقائق", "15m": "15 دقيقة", "1h": "ساعة" };

  return (
    <div dir="rtl" className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-md bg-primary font-mono text-lg font-bold text-primary-foreground">Ξ</div>
            <div>
              <h1 className="text-lg font-bold leading-none">ETH Intelligence</h1>
              <p className="mt-1 font-mono text-xs text-muted-foreground">ETH/USDT · {horizon} · RISK {RISK}%</p>
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
                <p className="font-mono text-4xl font-bold">{livePrice ? fmt(livePrice) : "—"}</p>
                <p className={`font-mono text-sm ${change >= 0 ? "text-bull" : "text-bear"}`}>{change >= 0 ? "+" : ""}{change.toFixed(3)}% (شمعة)</p>
              </div>
              <div className="text-left">
                <p className="text-xs text-muted-foreground">التنبؤ بعد {horizonLabel[horizon]}</p>
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
              <h2 className="font-semibold">اختبار رجعي 5 دقائق (آخر 750 شمعة، بعد رسوم {feePct}%)</h2>
              <div className="flex gap-2 text-xs">
                {([["htfTrend", "تأكيد الفريم الأعلى"], ["volume", "فلتر الحجم"], ["pressure", "ضغط الشراء/البيع"]] as const).map(([k, l]) => (
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

          <HorizonLab data={{ "15m": h15.candles, "1h": h1.candles }} feePct={feePct} onFeeChange={setFeePct} />

          <PaperLab trades={trades} stale={stale} onClose={closeTrade} onClear={clearClosed} />
        </section>

        <aside className="space-y-4">
          <div className="panel p-4">
            <p className="mb-2 text-xs text-muted-foreground">أفق الإشارة والصفقة الورقية</p>
            <div className="grid grid-cols-3 gap-2">
              {(["5m", "15m", "1h"] as const).map((x) => (
                <button key={x} onClick={() => setHorizon(x)} className={`rounded-md border py-1.5 font-mono text-sm ${horizon === x ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground hover:bg-secondary"}`}>{x}</button>
              ))}
            </div>
          </div>

          <div className="panel p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">ضغط الشراء والبيع</h2>
              <button onClick={() => setFilters((f) => ({ ...f, pressure: !f.pressure }))}
                className={`rounded-md border px-2 py-0.5 text-xs ${filters.pressure ? "border-primary text-primary" : "border-border text-muted-foreground"}`}>
                المرشح: {filters.pressure ? "يعمل" : "متوقف"}
              </button>
            </div>
            <Gauge label="دفتر الأوامر (±0.5%)" value={book.imbalance} />
            <Gauge label="الشراء العدواني (آخر 3 شموع)" value={taker === null ? null : (taker - 0.5) * 2} />
            <div className="mt-3 space-y-1 font-mono text-xs">
              <Row k="طلبات شراء" v={`${fmt(book.bidQty, 1)} ETH`} />
              <Row k="عروض بيع" v={`${fmt(book.askQty, 1)} ETH`} />
            </div>
            <p className={`mt-3 text-xs ${pressureOk === null ? "text-muted-foreground" : pressureOk ? "text-bull" : "text-bear"}`}>
              {pressureOk === null ? "لا توجد إشارة اتجاه لمقارنتها." : pressureOk ? "الضغط يتوافق مع الإشارة الخام." : "الضغط يعاكس الإشارة الخام."}
            </p>
          </div>

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
            <h2 className="mb-3 font-semibold">إدارة المخاطرة 1% · صفقة {horizonLabel[horizon]}</h2>
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

function Gauge({ label, value }: { label: string; value: number | null }) {
  const pct = value === null ? 50 : Math.round(((value + 1) / 2) * 100);
  return (
    <div className="mb-3">
      <div className="mb-1 flex justify-between text-xs"><span className="text-muted-foreground">{label}</span>
        <span dir="ltr" className={`font-mono ${value === null ? "text-muted-foreground" : value > 0 ? "text-bull" : "text-bear"}`}>{value === null ? "—" : `${value > 0 ? "+" : ""}${(value * 100).toFixed(0)}%`}</span></div>
      <div dir="ltr" className="relative h-2 overflow-hidden rounded-full bg-bear/40">
        <div className="absolute inset-y-0 left-0 bg-bull" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
