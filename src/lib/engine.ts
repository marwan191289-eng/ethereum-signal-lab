// Pure signal engine: indicators, 5-minute forecast, 1% risk sizing, backtest.
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  values.forEach((v, i) => out.push(i === 0 ? v : v * k + out[i - 1] * (1 - k)));
  return out;
}

export function rsi(values: number[], period = 14): number[] {
  const out: number[] = new Array(values.length).fill(50);
  let gain = 0, loss = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= period) {
      gain += g / period; loss += l / period;
    } else {
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
    }
    if (i >= period) out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function atr(c: Candle[], period = 14): number[] {
  const tr = c.map((x, i) =>
    i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)),
  );
  return ema(tr, period);
}

export function macd(values: number[]) {
  const f = ema(values, 12), s = ema(values, 26);
  const line = f.map((v, i) => v - s[i]);
  const signal = ema(line, 9);
  return { line, signal, hist: line.map((v, i) => v - signal[i]) };
}

export type Direction = "LONG" | "SHORT" | "NEUTRAL";
export type Signal = {
  direction: Direction;
  confidence: number; // 0..100
  score: number; // -1..1
  price: number;
  stop: number;
  target: number;
  forecast: number; // predicted price in 5 min
  reasons: string[];
  ema9: number; ema21: number; rsi: number; macdHist: number; atr: number;
};

/** Score the latest candle at index i (default last). */
export function computeSignal(c: Candle[], i = c.length - 1): Signal {
  if (!Number.isInteger(i) || i < 50 || i >= c.length) throw new RangeError("At least 51 candles are required");
  const sample = c.slice(0, i + 1);
  if (sample.some((x) => Object.values(x).some((v) => !Number.isFinite(v)) || x.low <= 0 || x.high < Math.max(x.open, x.close, x.low) || x.low > Math.min(x.open, x.close))) throw new RangeError("Invalid OHLC data");
  const closes = sample.map((x) => x.close);
  const e9 = ema(closes, 9), e21 = ema(closes, 21), r = rsi(closes), m = macd(closes), a = atr(sample);
  const price = closes[i];
  const reasons: string[] = [];
  let score = 0;

  const trend = (e9[i] - e21[i]) / price;
  score += Math.max(-1, Math.min(1, trend * 400)) * 0.35;
  reasons.push(e9[i] > e21[i] ? "EMA9 فوق EMA21 — اتجاه صاعد" : "EMA9 تحت EMA21 — اتجاه هابط");

  const cross = (e9[i] - e21[i]) * (e9[i - 1] - e21[i - 1]) < 0;
  if (cross) { score += e9[i] > e21[i] ? 0.2 : -0.2; reasons.push("تقاطع EMA جديد"); }

  const rv = r[i];
  if (rv < 30) { score += 0.2; reasons.push(`RSI ${rv.toFixed(0)} تشبع بيعي`); }
  else if (rv > 70) { score -= 0.2; reasons.push(`RSI ${rv.toFixed(0)} تشبع شرائي`); }
  else score += ((rv - 50) / 50) * 0.15;

  const h = m.hist[i], hp = m.hist[i - 1];
  score += Math.sign(h) * 0.15 + (h > hp ? 0.1 : -0.1);
  reasons.push(h > hp ? "زخم MACD يتزايد" : "زخم MACD يتراجع");

  const mom = (price - closes[i - 3]) / price;
  score += Math.max(-1, Math.min(1, mom * 200)) * 0.15;

  score = Math.max(-1, Math.min(1, score));
  const confidence = Math.round(Math.abs(score) * 100);
  const direction: Direction = a[i] <= 0 ? "NEUTRAL" : score > 0.3 ? "LONG" : score < -0.3 ? "SHORT" : "NEUTRAL";
  const av = a[i];
  const stop = direction === "SHORT" ? price + 1.5 * av : price - 1.5 * av;
  const target = direction === "SHORT" ? price - 2 * av : price + 2 * av;
  const forecast = price + score * av;
  return { direction, confidence, score, price, stop, target, forecast, reasons, ema9: e9[i], ema21: e21[i], rsi: rv, macdHist: h, atr: av };
}

/** 1% rule: position size so that hitting the stop loses exactly riskPct of equity. */
export function positionSize(equity: number, riskPct: number, entry: number, stop: number) {
  if (![equity, riskPct, entry, stop].every(Number.isFinite) || equity <= 0 || riskPct <= 0 || riskPct > 100 || entry <= 0 || stop <= 0) return { riskAmount: 0, qty: 0, notional: 0 };
  const riskAmount = equity * (riskPct / 100);
  const perUnit = Math.abs(entry - stop);
  const qty = perUnit > 0 ? riskAmount / perUnit : 0;
  return { riskAmount, qty, notional: qty * entry };
}

/** Five-minute OHLC exit; stop wins ties because intrabar order is unknown. */
export function evaluateNextCandle(direction: Exclude<Direction, "NEUTRAL">, entry: number, stop: number, target: number, next: Candle) {
  const hitStop = direction === "LONG" ? next.low <= stop : next.high >= stop;
  const hitTarget = direction === "LONG" ? next.high >= target : next.low <= target;
  const exit = hitStop ? stop : hitTarget ? target : next.close;
  const risk = Math.abs(entry - stop);
  return { exit, r: risk > 0 ? (direction === "LONG" ? exit - entry : entry - exit) / risk : 0, outcome: hitStop ? "stop" : hitTarget ? "target" : "timeout" };
}

/** Walk-forward, enter at the next open and exit within its five-minute candle. Fees excluded. */
export function backtest(c: Candle[], start = 50) {
  let trades = 0, wins = 0, pnlR = 0, peak = 0, maxDD = 0;
  for (let i = Math.max(50, Number.isFinite(start) ? Math.floor(start) : 50); i < c.length - 1; i++) {
    const s = computeSignal(c, i);
    if (s.direction === "NEUTRAL") continue;
    trades++;
    const entry = c[i + 1].open;
    const stop = entry + (s.direction === "SHORT" ? 1 : -1) * 1.5 * s.atr;
    const target = entry + (s.direction === "SHORT" ? -1 : 1) * 2 * s.atr;
    const { r } = evaluateNextCandle(s.direction, entry, stop, target, c[i + 1]);
    if (r > 0) wins++;
    pnlR += r;
    peak = Math.max(peak, pnlR);
    maxDD = Math.max(maxDD, peak - pnlR);
  }
  return { trades, winRate: trades ? (wins / trades) * 100 : 0, pnlR, expectancy: trades ? pnlR / trades : 0, maxDD };
}

export type Filters = { htfTrend: boolean; volume: boolean };
export const DEFAULT_FILTERS: Filters = { htfTrend: true, volume: true };

/** Higher-timeframe proxy: EMA96 (~8h) vs EMA240 (~20h) on 5m closes; volume must beat 1.2x the 20-candle average. */
export function applyFilters(c: Candle[], i: number, s: Signal, f: Filters, closesEma?: { fast: number[]; slow: number[] }): Signal {
  if (s.direction === "NEUTRAL") return s;
  const reasons = [...s.reasons];
  let blocked = false;
  if (f.htfTrend) {
    const closes = c.map((x) => x.close);
    const fast = closesEma?.fast ?? ema(closes.slice(0, i + 1), 96);
    const slow = closesEma?.slow ?? ema(closes.slice(0, i + 1), 240);
    const up = c[i].close > slow[i] && fast[i] > slow[i];
    const down = c[i].close < slow[i] && fast[i] < slow[i];
    const ok = i >= 240 && (s.direction === "LONG" ? up : down);
    reasons.push(ok ? "الفريم الأعلى يؤكد الاتجاه" : "الفريم الأعلى لا يؤكد — تم الحجب");
    if (!ok) blocked = true;
  }
  if (f.volume) {
    const avg = c.slice(Math.max(0, i - 20), i).reduce((a, x) => a + x.volume, 0) / Math.min(20, Math.max(1, i));
    const ok = c[i].volume > 1.2 * avg;
    reasons.push(ok ? "حجم التداول أعلى من المتوسط" : "حجم تداول ضعيف — تم الحجب");
    if (!ok) blocked = true;
  }
  return blocked ? { ...s, direction: "NEUTRAL", reasons } : { ...s, reasons };
}

/** Same as backtest() but with filters and a round-trip fee (percent of entry) deducted from every trade. */
export function backtestFiltered(c: Candle[], f: Filters, feePct = 0.1, start = 50) {
  const closes = c.map((x) => x.close);
  const pre = { fast: ema(closes, 96), slow: ema(closes, 240) };
  let trades = 0, wins = 0, pnlR = 0, peak = 0, maxDD = 0;
  for (let i = Math.max(50, Math.floor(start)); i < c.length - 1; i++) {
    const s = applyFilters(c, i, computeSignal(c, i), f, pre);
    if (s.direction === "NEUTRAL") continue;
    const entry = c[i + 1].open;
    const risk = 1.5 * s.atr;
    const stop = entry + (s.direction === "SHORT" ? 1 : -1) * risk;
    const target = entry + (s.direction === "SHORT" ? -1 : 1) * 2 * s.atr;
    const { r } = evaluateNextCandle(s.direction, entry, stop, target, c[i + 1]);
    const net = r - (entry * feePct) / 100 / risk;
    trades++;
    if (net > 0) wins++;
    pnlR += net;
    peak = Math.max(peak, pnlR);
    maxDD = Math.max(maxDD, peak - pnlR);
  }
  return { trades, winRate: trades ? (wins / trades) * 100 : 0, pnlR, expectancy: trades ? pnlR / trades : 0, maxDD };
}
