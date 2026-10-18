import { useEffect, useState } from "react";
import { bookImbalance } from "@/lib/engine";

const ENDPOINTS = ["https://api.binance.com", "https://data-api.binance.vision"];

/** Polls the Binance ETHUSDT order book every 3s and returns bid/ask imbalance within ±0.5% of mid. */
export function useOrderBook(enabled = true) {
  const [imbalance, setImbalance] = useState<number | null>(null);
  const [bidQty, setBid] = useState(0);
  const [askQty, setAsk] = useState(0);
  const [updatedAt, setUpdatedAt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const load = async () => {
      for (const ep of ENDPOINTS) {
        try {
          const res = await fetch(`${ep}/api/v3/depth?symbol=ETHUSDT&limit=500`, { signal: controller.signal });
          if (!res.ok) throw new Error();
          const d = await res.json();
          const bids: [number, number][] = d.bids.map((x: string[]) => [+x[0], +x[1]]);
          const asks: [number, number][] = d.asks.map((x: string[]) => [+x[0], +x[1]]);
          const mid = (bids[0][0] + asks[0][0]) / 2;
          setImbalance(bookImbalance(bids, asks));
          setBid(bids.filter(([p]) => p >= mid * 0.995).reduce((a, [, q]) => a + q, 0));
          setAsk(asks.filter(([p]) => p <= mid * 1.005).reduce((a, [, q]) => a + q, 0));
          setUpdatedAt(Date.now());
          return;
        } catch { if (controller.signal.aborted) return; }
      }
    };
    void load();
    const t = setInterval(load, 3000);
    return () => { controller.abort(); clearInterval(t); };
  }, [enabled]);
  const fresh = Date.now() - updatedAt < 15000;
  return { imbalance: fresh ? imbalance : null, bidQty, askQty, updatedAt };
}
