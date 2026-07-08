# frank369-bot v1.0

Rule-based NQ futures signal bot implementing Frank369/Zeussy's **369 trading model**.

v1.0 outputs signals to the **console only** — no order execution.

---

## Model Pillars

| # | Pillar | Description |
|---|--------|-------------|
| 1 | **90-Min Cycle Engine** | Day divided into 90-min blocks from 2:30 AM ET. Prev-cycle H/L = key liquidity levels |
| 2 | **Killzone Filter** | Signals only fire during NY AM (9:30–11:00) and NY PM (1:30–3:00) ET |
| 3 | **Liquidity Sweep** | Price takes out prev-cycle H or L by configurable threshold, then closes back inside |
| 4 | **MSS Confirmation** | Strong momentum candle (≥50% body) in reversal direction after sweep |
| 5 | **FVG Entry** | 3-candle imbalance formed during expansion; entry triggers on retrace into gap |
| 6 | **SMT Divergence** | NQ makes new cycle extreme but ES/YM fail to confirm (intermarket confluence) |
| 7 | **Risk Management** | Daily loss kill-switch + max-trades-per-session cap |

---

## Prerequisites

- **TradingView Desktop** open with `--remote-debugging-port=9222`
- **Node.js** >= 18
- MCP server at `~/tradingview-mcp-jackson/` (configured in `config.js`)

---

## Setup

```bash
cd ~/frank369-bot
npm install
npm start
```

Health check only:
```bash
npm run health
```

---

## Signal Output Format

Every signal printed to console shows:

```
Direction : ▲ LONG / ▼ SHORT
Entry     : FVG midpoint
Stop      : below/above sweep extreme + buffer
Target 1  : entry ± (risk × 2R)
Target 2  : entry ± (risk × 3R)  [extension]
R:R       : calculated ratio
Killzone  : NY AM / NY PM
Cycle     : index + prev H/L
Sweep     : type + level
FVG       : zone [low – high]
SMT       : divergence status
```

---

## Configuration

All tunable parameters are in `config.js`:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `sweep.thresholdPoints` | 3 | Points beyond cycle H/L for valid sweep |
| `mss.minBodyPct` | 0.50 | Minimum body-to-range ratio for MSS candle |
| `fvg.minGapPoints` | 2 | Minimum FVG gap width in NQ points |
| `risk.minRR` | 2.0 | Signals below this R:R are discarded |
| `risk.dailyLossLimitPoints` | -50 | Kill-switch threshold (-$1,000/contract) |
| `risk.maxTradesPerSession` | 3 | Max signals per trading day |
| `smt.enabled` | true | Toggle SMT divergence checking |
| `smt.requireBoth` | false | Both ES AND YM must diverge |
| `pollIntervalMs` | 5000 | Main loop poll cadence (ms) |

---

## Architecture

```
index.js          — boot, main loop, SMT loop
config.js         — all tunable parameters
src/
  mcp-client.js   — TradingView MCP wrapper (stdio)
  candle-buffer.js— OHLCV accumulator + query helpers
  logger.js       — color-coded timestamped output
  engines/
    cycle-engine.js   — 90-min cycle math + H/L extraction
    killzone.js       — NY AM / PM window gating
    fvg-detector.js   — sweep, MSS, FVG detection
    smt-detector.js   — ES/YM divergence tracking
    signal-engine.js  — full pipeline orchestrator
```

---

## Phase Roadmap

| Phase | Description | Hook Location |
|-------|-------------|---------------|
| **v1.0** | Console signals (current) | — |
| **Phase 2** | Claude AI HTF context scoring | `signal-engine.js htfContextScore()` + `index.js boot()` |
| **Phase 3** | Tradovate live order execution | `signal-engine.js` Phase 3 hook comment block |

---

## NQ Contract Notes

- **Symbol**: `NQ1!` (continuous front-month)
- **Point value**: $20 per point per contract
- **Minimum tick**: 0.25 points ($5)
- ES and YM are loaded for SMT reference only — never traded
