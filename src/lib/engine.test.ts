import { describe, it, expect } from "vitest";
import { backtest, computeSignal, evaluateNextCandle, positionSize, type Candle } from "./engine";

describe("1% risk rule", () => {
  it("risks exactly 1% of equity at the stop", () => {
    const p = positionSize(10000, 1, 2400, 2380);
    expect(p.riskAmount).toBe(100);
    expect(p.qty).toBeCloseTo(5);
  });
});

const bar = (open: number, high: number, low: number, close: number): Candle => ({ time: 0, open, high, low, close, volume: 100 });
describe("five-minute execution", () => {
  it("counts a long stop before a target when both are touched", () => {
    const result = evaluateNextCandle("LONG", 100, 97, 104, bar(100, 106, 96, 105));
    expect(result.r).toBe(-1);
    expect(result.exit).toBe(97);
  });
  it("counts a short stop before a target when both are touched", () => {
    expect(evaluateNextCandle("SHORT", 100, 103, 96, bar(100, 104, 95, 96)).r).toBe(-1);
  });
  it("uses the five-minute close if neither exit was touched", () => {
    expect(evaluateNextCandle("LONG", 100, 97, 104, bar(100, 102, 99, 101.5)).r).toBe(0.5);
  });
  it("exits at the target price rather than the candle close", () => {
    expect(evaluateNextCandle("LONG", 100, 97, 104, bar(100, 110, 99, 108)).r).toBeCloseTo(4 / 3);
  });
  it("does not use future candles in a historical signal", () => {
    const candles = Array.from({ length: 60 }, (_, i) => ({ ...bar(100 + i, 102 + i, 99 + i, 101 + i), time: i * 300 }));
    expect(computeSignal([...candles, bar(1000, 2000, 900, 1900)], 59)).toEqual(computeSignal(candles));
  });
  it("does not generate trades in a zero-volatility market", () => {
    expect(backtest(Array.from({ length: 60 }, () => bar(100, 100, 100, 100))).trades).toBe(0);
  });
  it("rejects insufficient signal history", () => {
    expect(() => computeSignal([bar(100, 101, 99, 100)])).toThrow(RangeError);
  });
  it("prevents positions with invalid capital", () => {
    expect(positionSize(-10000, 1, 2400, 2380).qty).toBe(0);
    expect(positionSize(NaN, 1, 2400, 2380).qty).toBe(0);
  });
});

import { applyFilters, backtestFiltered } from "./engine";
describe("filters", () => {
  const mk = (n: number, vol: (i: number) => number) => Array.from({ length: n }, (_, i) => {
    const p = 100 + i * 0.5; return { time: i * 300, open: p - 0.2, high: p + 0.5, low: p - 0.5, close: p, volume: vol(i) };
  });
  it("blocks a signal when volume is not above 1.2x average", () => {
    const c = mk(300, () => 10);
    const s = { ...computeSignal(c), direction: "LONG" as const };
    expect(applyFilters(c, 299, s, { htfTrend: false, volume: true }).direction).toBe("NEUTRAL");
  });
  it("keeps a long when higher timeframe is up and volume spikes", () => {
    const c = mk(300, (i) => (i === 299 ? 50 : 10));
    const s = { ...computeSignal(c), direction: "LONG" as const };
    expect(applyFilters(c, 299, s, { htfTrend: true, volume: true }).direction).toBe("LONG");
  });
  it("blocks a short against an up higher-timeframe trend", () => {
    const c = mk(300, (i) => (i === 299 ? 50 : 10));
    const s = { ...computeSignal(c), direction: "SHORT" as const };
    expect(applyFilters(c, 299, s, { htfTrend: true, volume: false }).direction).toBe("NEUTRAL");
  });
  it("fees reduce backtest result", () => {
    const c = mk(300, () => 10);
    const off = { htfTrend: false, volume: false };
    const a = backtestFiltered(c, off, 0), b = backtestFiltered(c, off, 0.1);
    if (a.trades) expect(b.pnlR).toBeLessThan(a.pnlR);
  });
});
