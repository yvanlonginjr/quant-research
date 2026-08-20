# frank369-bot

A rule-based signal bot for NQ (Nasdaq-100 E-mini) futures, built around
ICT-style ("Inner Circle Trader") liquidity concepts — order flow tends to
sweep resting liquidity above/below prior swing points before reversing,
and price often confirms that reversal by leaving a short-term imbalance
behind as it re-expands.

The code and detailed writeup for this project are kept private. This page
is a high-level overview, kept current as the project evolves.

---

## Approach

At a high level, the bot's detection pipeline looks for a specific
sequence: price sweeps a prior reference level (a recent swing high/low),
the market shows signs of a structural shift in the reversal direction,
and a short-term imbalance forms during the resulting move — with the setup
optionally corroborated by how correlated instruments (ES, YM) behaved over
the same window. Reference levels are tracked across a range of timeframes
and cyclical/session breakdowns of the trading day, rather than a single
fixed window.

Two pieces of the model have since been reworked to be more
context-sensitive rather than formulaic:

- **Invalidation (stop) placement** is now derived from whichever piece of
  price structure actually produced the setup — the originating imbalance,
  the confirming reversal candle, or a deeper structural level when one is
  present nearby — instead of a single fixed offset applied the same way
  every time.
- **Targets** are now areas of resting liquidity the market is likely to be
  drawn toward — the nearest and next unmitigated reference level across a
  hierarchy of timeframes from short-term cycles up through weekly/monthly
  levels — rather than a fixed reward-to-risk multiple of the stop
  distance.

It runs against live TradingView market data via a local integration, and
is currently signal-only — it identifies and visually marks candidate
setups for manual review rather than placing any orders. Trade management
(how a live position should be handled after entry — partial exits,
breakeven, invalidation as new information arrives) is the active area of
work.

## Engineering & validation

A meaningful part of this project has been building the infrastructure to
trust the signals, not just generate them:

- **One detection engine, two runners.** The backtest harness and the live
  signal loop now share the exact same detection code path — a backtest
  result is, by construction, what the live bot would have done on those
  same bars, not an approximation running a parallel implementation.
- **Replay-driven backtesting against real historical data**, walking
  forward bar-by-bar with no look-ahead, producing a plain-language report
  per run (headline stats, breakdowns by session/setup type, a full
  trade-by-trade log) alongside a spreadsheet export — built to be
  readable without needing to dig into raw output.
  - **Every signal is visually cross-referenced.** Each backtested trade is
    marked directly on the historical chart and captured as a screenshot at
    the moment it fired, so a signal's reasoning can be checked against
    what the chart actually looked like, not just trusted as a number.
- **Debugging the debugging tools.** Getting reliable chart automation
  meant chasing down a few genuinely subtle issues along the way — a race
  condition between two independent polling loops that shared one chart
  session, and a rendering pipeline that silently returned stale
  screenshots (the underlying commands were succeeding; the display
  compositor simply wasn't repainting an unfocused window) that looked
  like a data problem before it was traced to its actual cause.

## Stack

- Node.js (ESM)
- TradingView desktop, driven via a local MCP (Model Context Protocol)
  integration for live and historical (replay) OHLCV data
- A replay-based backtest harness sharing the live bot's detection engine,
  with automated Excel + Markdown reporting and per-trade chart screenshots

## Status

Active research/development. Live/backtest parity is done — both now run
identical detection logic. Stop and target logic have been reworked to be
structure- and liquidity-based rather than formulaic, and multiple backtest
passes have been run against the updated logic. Next up: trade management
for open positions, and continued iteration on entry quality.

---

Questions about this project? Feel free to reach out.
