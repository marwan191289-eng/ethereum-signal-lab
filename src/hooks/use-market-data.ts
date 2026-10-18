import { useEffect, useState } from "react";
import type { Candle } from "@/lib/engine";

const ENDPOINTS = ["https://api.binance.com", "https://data-api.binance.vision"];
export function useMarketData() {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [status, setStatus] = useState<"connecting" | "live" | "delayed" | "error">("connecting");
  const [updatedAt, setUpdatedAt] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    let loading = false;
    const load = async () => {
      if (loading || disposed) return;
      loading = true;
      for (const endpoint of ENDPOINTS) {
        try {
          const response = await fetch(`${endpoint}/api/v3/klines?symbol=ETHUSDT&interval=5m&limit=1000`, { signal: controller.signal });
          if (!response.ok) throw new Error("Market unavailable");
          const rows: unknown = await response.json();
          if (!Array.isArray(rows) || rows.length < 51) throw new Error("Incomplete candles");
          const next: Candle[] = rows.map((k) => ({ time: Number(k[0]) / 1000, open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) }));
          if (next.some((c) => Object.values(c).some((v) => !Number.isFinite(v)) || c.close <= 0)) throw new Error("Invalid candles");
          if (!disposed) {
            setCandles((previous) => previous.length && previous[previous.length - 1].time > next[next.length - 1].time ? previous : next);
            setUpdatedAt(Date.now());
            setStatus(socket?.readyState === WebSocket.OPEN ? "live" : "delayed");
          }
          loading = false;
          return;
        } catch { if (disposed) break; }
      }
      loading = false;
      if (!disposed && socket?.readyState !== WebSocket.OPEN) setStatus("error");
    };
    const connect = () => {
      if (disposed) return;
      socket = new WebSocket("wss://stream.binance.com:9443/ws/ethusdt@kline_5m");
      socket.onmessage = (event) => {
        try {
          const k = JSON.parse(event.data).k;
          const candle: Candle = { time: k.t / 1000, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v };
          if (Object.values(candle).some((v) => !Number.isFinite(v)) || candle.close <= 0) return;
          setCandles((prev) => {
            const last = prev[prev.length - 1];
            if (!last || candle.time < last.time) return prev;
            if (candle.time === last.time) return [...prev.slice(0, -1), candle];
            if (candle.time > last.time + 300) { void load(); return prev; }
            return [...prev.slice(-999), candle];
          });
          setUpdatedAt(Date.now());
          setStatus("live");
        } catch { /* Ignore malformed stream messages. */ }
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (disposed) return;
        setStatus("delayed");
        retry = setTimeout(() => { void load(); connect(); }, 5000);
      };
    };
    setStatus("connecting");
    void load();
    connect();
    const polling = setInterval(() => { void load(); }, 15000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { disposed = true; controller.abort(); socket?.close(); clearTimeout(retry); clearInterval(polling); clearInterval(clock); };
  }, [attempt]);
  const stale = !updatedAt || now - updatedAt > 30000;
  return { candles, status: stale && status === "live" ? "delayed" : status, updatedAt, stale, retry: () => setAttempt((n) => n + 1) };
}