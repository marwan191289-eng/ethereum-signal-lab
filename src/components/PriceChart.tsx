import { useEffect, useRef } from "react";
import type { Candle } from "@/lib/engine";
import { ema } from "@/lib/engine";

// Resolve a CSS token to rgb() — the chart library can't parse oklch.
function cssColor(name: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return v;
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

export default function PriceChart({ candles }: { candles: Candle[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const api = useRef<any>(null);
  const latest = useRef(candles);
  const framed = useRef(false);
  latest.current = candles;

  const apply = () => {
    const c = latest.current;
    if (!api.current || !c.length) return;
    const closes = c.map((x) => x.close);
    const a = ema(closes, 9), b = ema(closes, 21);
    api.current.series.setData(c.map((x) => ({ time: x.time, open: x.open, high: x.high, low: x.low, close: x.close })));
    api.current.e9.setData(c.map((x, i) => ({ time: x.time, value: a[i] })));
    api.current.e21.setData(c.map((x, i) => ({ time: x.time, value: b[i] })));
    if (!framed.current) {
      api.current.chart.timeScale().setVisibleRange({ from: c[Math.max(0, c.length - 80)].time, to: c[c.length - 1].time });
      framed.current = true;
    }
  };

  useEffect(() => {
    let disposed = false;
    import("lightweight-charts").then(({ createChart }) => {
      if (disposed || !ref.current) return;
      const fg = cssColor("--muted-foreground"), grid = cssColor("--border");
      const up = cssColor("--bull"), down = cssColor("--bear"), acc = cssColor("--primary");
      const chart = createChart(ref.current, {
        autoSize: true,
        localization: { locale: "en-US", priceFormatter: (p: number) => p.toFixed(2), timeFormatter: (t: number) => new Date(t * 1000).toISOString().slice(11, 16) },
        layout: { background: { color: "transparent" }, textColor: fg, fontFamily: "JetBrains Mono" },
        grid: { vertLines: { color: grid }, horzLines: { color: grid } },
        timeScale: { timeVisible: true, borderColor: grid, tickMarkFormatter: (t: number) => new Date(t * 1000).toISOString().slice(11, 16) },
        rightPriceScale: { borderColor: grid },
      });
      const series = chart.addCandlestickSeries({ upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false });
      const e9 = chart.addLineSeries({ color: acc, lineWidth: 1, priceLineVisible: false });
      const e21 = chart.addLineSeries({ color: fg, lineWidth: 1, priceLineVisible: false });
      api.current = { chart, series, e9, e21 };
      apply();
    });
    return () => { disposed = true; api.current?.chart.remove(); api.current = null; framed.current = false; };
  }, []);

  useEffect(apply, [candles]);

  return <div ref={ref} dir="ltr" className="h-[440px] w-full" />;
}
