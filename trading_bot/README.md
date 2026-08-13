# frank369-bot

A rule-based signal bot for NQ (Nasdaq-100 E-mini) futures, built around
ICT-style ("Inner Circle Trader") liquidity concepts — order flow tends to
sweep resting liquidity above/below prior swing points before reversing,
and price often confirms that reversal by leaving a short-term imbalance
behind as it re-expands.

The code and detailed writeup for this project are kept private. This page
is a high-level overview.

---

## Approach

At a high level, the bot's detection pipeline looks for a specific
sequence: price sweeps a prior reference level (a recent swing high/low),
the market shows signs of a structural shift in the reversal direction,
and a short-term imbalance forms during the resulting move — with the setup
optionally corroborated by how correlated instruments (ES, YM) behaved over
the same window. Reference levels are tracked across a few different
timeframes and cyclical/session breakdowns of the trading day, rather than
a single fixed window.

It runs against live TradingView market data via a local integration, and
is currently signal-only — it prints candidate setups to the console for
manual review rather than placing any orders.

## Stack

- Node.js (ESM)
- TradingView desktop, driven via a local MCP (Model Context Protocol)
  integration for live and historical (replay) OHLCV data
- A separate replay-based backtest harness for validating changes against
  historical data before they reach the live signal loop

## Status

Active research/development. The live signal loop and the backtest harness
currently implement somewhat different versions of the detection pipeline
as newer ideas get validated in backtest before being ported to live —
that convergence work is ongoing.

---

Questions about this project? Feel free to reach out.
