<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Market data comes from Binance public REST/WebSocket in the browser (no keys); signal logic stays pure in src/lib/engine.ts so it can be tested and later moved server-side.
- Market connectivity is isolated in use-market-data with REST fallback, stream recovery and freshness checks so stale prices cannot open paper trades.
- Backtests use completed five-minute candles and next-candle OHLC with conservative stop-first resolution when both exit levels are touched; this avoids claiming close-direction accuracy as trading performance.
- Signal filters (higher-timeframe EMA proxy, volume) live in applyFilters in engine.ts; dashboard backtests always deduct fees so results are not overstated.
