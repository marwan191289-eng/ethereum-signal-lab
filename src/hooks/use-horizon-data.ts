import { useEffect, useState } from "react";
import type { Candle, Horizon } from "@/lib/engine";

const ENDPOINTS = ["https://api.binance.com", "https://data-api.binance.vision"];

/** Fetch up to `pages`×1000 ETHUSDT candles (oldest first) with taker-buy volume. */
export async function fetchKlines(interval: Horizon, pages = 2, signal?: AbortSignal): Promise<Candle[]> {
  for (const endpoint of ENDPOINTS) {
    try {
      let end: number | undefined;
      let all: Candle[] = [];
      for (let p = 0; p < pages; p++) {
        const url = `${endpoint}/api/v3/klines?symbol=ETHUSDT&interval=${interval}&limit=1000${end ? `&endTime=${end}` : ""}`;
        const res = await fetch(url, { signal });
        if (!res.ok) throw new Error("Market unavailable");
        const rows: unknown = await res.json();
        if (!Array.isArray(rows) || !rows.length) break;
        const batch: Candle[] = rows.map((k) => ({ time: Number(k[0]) / 1000, open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], takerBuy: +k[9] }));
        if (batch.some((c) => Object.values(c).some((v) => !Number.isFinite(v)) || c.close <= 0)) throw new Error("Invalid candles");
        all = [...batch, ...all];
        end = batch[0].time * 1000 - 1;
      }
      if (all.length > 300) return all;
    } catch (e) { if (signal?.aborted) throw e; }
  }
  throw new Error("Market unavailable");
}

/** Completed-candle history for 15m / 1h horizons, refreshed every minute. Last (open) candle is dropped. */
export function useHorizonData(interval: Horizon, pages = 2) {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const load = () => fetchKlines(interval, pages, controller.signal)
      .then((c) => { setCandles(c); setError(false); })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    void load();
    const t = setInterval(load, 60000);
    return () => { controller.abort(); clearInterval(t); };
  }, [interval, pages]);
  return { candles, error };
}
