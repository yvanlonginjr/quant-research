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

## Trade Execution Logic

This section describes exactly what the bot evaluates every time it considers firing a signal — in the precise order the code runs it. Every poll loop tick (every 5 seconds) runs through all of the following layers in sequence. The first layer that fails short-circuits the rest; nothing downstream is evaluated.

### How the bot runs

The bot runs two concurrent loops:

- **Main loop** (every 5 seconds): fetches the latest 300 1-min NQ candles from TradingView, updates the candle buffer, and runs the full signal evaluation pipeline below.
- **SMT loop** (every 30 seconds): briefly switches the TradingView chart to ES, fetches candles, switches to YM, fetches candles, then restores NQ. This keeps the SMT reference data fresh without disrupting the main loop.

The signal pipeline in the main loop is fully synchronous and top-down. If any layer returns early, the remaining layers are skipped entirely.

---

### Layer 0 — Time Gates

These two checks run before any price data is touched. If either fails, the bot returns immediately and logs a debug message.

#### 1. Killzone gate

The very first thing evaluated on every tick. The bot checks whether the current ET clock time falls inside one of two hard trading windows:

- **NY AM:** 9:30 AM – 11:00 AM ET
- **NY PM:** 1:30 PM – 3:00 PM ET

These are the only minutes of the day the bot can fire a signal. Outside these windows — including London session, Asia session, and the pre-open — the pipeline returns null immediately. No price action, no cycles, nothing else is looked at. The logic: institutional order flow worth trading only concentrates around these windows in Frank's model.

#### 2. Risk gate

Once inside a killzone, the bot checks its session-level risk state:

- **Daily loss kill switch:** If cumulative paper P&L for the current ET calendar day has hit or gone below −50 NQ points (equivalent to −$1,000 per contract at $20/pt), all signals are blocked for the rest of that day. Counter resets at the start of the next ET session date.
- **Max trades per session:** If the bot has already fired 3 signals today (across AM and PM combined), no further signals are generated. This prevents overtrading on choppy days regardless of how many valid setups appear.

Both counters are reset automatically when the ET date changes (detected at the start of each evaluation cycle).

---

### Layer 1 — Cycle Identification and Reference Levels

If the time gates pass, the bot identifies where in the 369 cycle structure the current moment sits and extracts the key price levels it will use for the rest of the analysis.

#### 3. Cycle determination

The trading day is anchored at **6:00 PM ET** each evening and is divided into 15 cycles:

| Cycle | Window (ET) | Duration |
|-------|------------|----------|
| 1 | 6:00 PM – 7:00 PM | 60 min (opening cycle) |
| 2 | 7:00 PM – 8:30 PM | 90 min |
| 3 | 8:30 PM – 10:00 PM | 90 min |
| 4 | 10:00 PM – 11:30 PM | 90 min |
| 5 | 11:30 PM – 1:00 AM | 90 min |
| 6 | 1:00 AM – 2:30 AM | 90 min |
| 7 | 2:30 AM – 4:00 AM | 90 min |
| 8 | 4:00 AM – 5:30 AM | 90 min |
| 9 | 5:30 AM – 7:00 AM | 90 min |
| 10 | 7:00 AM – 8:30 AM | 90 min |
| 11 | 8:30 AM – 10:00 AM | 90 min |
| 12 | 10:00 AM – 11:30 AM | 90 min |
| 13 | 11:30 AM – 1:00 PM | 90 min |
| 14 | 1:00 PM – 2:30 PM | 90 min |
| 15 | 2:30 PM – 4:00 PM | 90 min |
| Dead zone | 4:00 PM – 6:00 PM | No signals |

From the current timestamp the bot calculates: which cycle number is active right now, its exact start/end timestamps, and — critically — the start and end timestamps of the **previous completed cycle**. The previous cycle's range is what everything downstream pivots off of.

Each 90-min cycle is also subdivided (not currently used for entry logic, but tracked):
- 3 × 30-min sub-cycles per 90-min cycle
- 3 × 10-min sub-cycles per 30-min sub-cycle

#### 4. Previous cycle high/low extraction

The bot scans the NQ candle buffer and extracts the **highest high** and **lowest low** printed during the previous complete 90-min cycle. These two prices become the reference liquidity levels:

- **Previous cycle high** → Buy-Side Liquidity (BSL). Stops from late long positions cluster above this level.
- **Previous cycle low** → Sell-Side Liquidity (SSL). Stops from late short positions cluster below this level.

If there isn't enough candle history to define the previous cycle's range (e.g., just after startup), the pipeline exits here.

---

### Layer 2 — Price Action Sequence

This is the core of the model. Three things must happen in order — sweep, then MSS, then FVG — and each one must complete before the next is evaluated. The bot scans the candle buffer for evidence of each, starting from the current cycle's open timestamp.

#### 5. Liquidity sweep detection

The bot scans every candle from the current cycle open forward, looking for a **wick that pierces one of the two reference levels** and then **closes back through it**.

**For a long setup (sweeping the prev-cycle low):**
- A candle's wick must reach at least 0.25 points below `prevCycleLow`
- That same candle — or one of the next 5 candles — must close back above `prevCycleLow`
- If price breaks below and no candle closes back within 5 bars → genuine breakdown, not a sweep → skip

**For a short setup (sweeping the prev-cycle high):**
- A candle's wick must reach at least 0.25 points above `prevCycleHigh`
- That same candle — or one of the next 5 candles — must close back below `prevCycleHigh`
- No close-back within 5 bars → genuine breakout → skip

The **sweep style** is noted — "wick" if the same candle both pierced and rejected, "body" if a subsequent candle provided the close-back. Both are valid.

The **sweep candle** is defined as whichever candle in the [pierce → close-back] window had the most extreme wick (lowest low for a long setup, highest high for a short setup). This candle is what the stop loss gets anchored to.

If no sweep is found, the pipeline exits here and logs the current prev-cycle levels for reference.

#### 6. Market Structure Shift (MSS) via CISD

After a sweep is confirmed, the bot needs to see the market confirm the reversal before committing. It looks for a **Change in State of Delivery (CISD)** — the candle or sequence that proves smart money has flipped their hand.

The logic runs three paths in order, stopping at the first that succeeds:

**V-shape fast path (checked first):**
The sweep candle itself closes in the reversal direction — it wicked down to take the low but closed bullish (for a long), or wicked up to take the high but closed bearish (for a short). When this happens, the reversal is immediate and the sweep candle IS the MSS candle. No further candles needed.

**CISD path (standard):**
If the sweep candle didn't close in the reversal direction:
1. Look backward from the sweep candle up to 20 bars to find the last **opposing delivery candle** — the last bearish candle (for a long setup) or the last bullish candle (for a short setup). Its **open price** becomes the CISD threshold.
2. Look forward from the sweep candle up to 15 bars for the first candle that closes **beyond** that delivery candle's open — above it for a long, below it for a short. That candle is the MSS.

The delivery candle's open is the key level because it marks the price where the opposing side was in control of delivery. A close beyond it means the reversal side has overtaken that level.

**Body-ratio fallback:**
If no opposing delivery candle is found (rare — can happen on gap opens or very one-sided moves), the bot falls back to the simpler rule: the first candle with a body/range ratio ≥ 50% in the reversal direction is accepted as the MSS.

If none of the three paths produce an MSS within their respective windows, the pipeline exits here.

#### 7. Fair Value Gap (FVG) detection

With the MSS candle index established, the bot scans forward from that point looking for a **3-candle Fair Value Gap** — an imbalance in price delivery where the impulse move was fast enough that a gap formed between candle bodies.

**Bullish FVG (long setup):**
- Condition: `candle[i-1].high < candle[i+1].low`
- The gap zone is `[candle[i-1].high, candle[i+1].low]`
- Candle[i] is the impulse bar that "jumped" the gap — its body doesn't fill the space between the prior candle's high and the next candle's low

**Bearish FVG (short setup):**
- Condition: `candle[i-1].low > candle[i+1].high`
- The gap zone is `[candle[i+1].high, candle[i-1].low]`
- Same pattern but inverted — a bearish impulse leaves a gap below

Additional filters:
- Minimum gap size: **4 NQ points**. Sub-4pt FVGs are treated as noise and skipped.
- Search window: up to **15 candles** forward from the MSS candle index. If no qualifying FVG forms within 15 bars, the pipeline exits.
- The first qualifying FVG found is used. The bot doesn't wait for the "best" one.

The FVG represents the zone where price moved so aggressively that it left orders unfilled. The expectation is that price will retrace into this zone before continuing in the sweep/reversal direction.

#### 8. Entry trigger — price inside FVG

This is the final price action check. The bot evaluates the current price (using the live bar's close, or the last closed bar's close if the live bar hasn't printed) against the FVG zone.

Entry triggers when:
```
currentPrice >= FVG midpoint  AND  currentPrice <= FVG high
```

In other words, price must be in the **upper half of the FVG**. This applies to both long and short setups — the "upper half" in both cases refers to the `[midpoint, fvgHigh]` portion of the zone regardless of direction.

The reasoning: waiting for price to reach the midpoint rather than the bottom of the FVG filters out noise and ensures the retrace is real. A touch of the very top of the FVG (fvgHigh) gets the optimal entry.

If price hasn't retraced into the FVG yet, the pipeline exits and the same setup will be re-evaluated on the next poll (5 seconds later). The setup remains "pending" until either the entry triggers, the killzone closes, or the session ends.

---

### Layer 3 — Signal Validation and Output

If all three price action conditions are met in sequence, the bot moves to validation and signal construction.

#### 9. De-duplication check

The bot maintains a set of "fired" signal keys for the current session. Key format: `YYYY-MM-DD_cycleIndex_direction`. For example: `2026-07-09_11_long`.

If this exact combination has already been fired today, the pipeline exits silently. This prevents the same setup from firing again on a subsequent tick while the price still happens to be inside the FVG.

#### 10. Risk computation and R:R gate

The bot calculates the exact trade parameters:

| Field | Calculation |
|-------|------------|
| **Entry** | FVG midpoint: `(fvgLow + fvgHigh) / 2` |
| **Stop (long)** | `sweepCandle.low − 2 pts` (2-pt buffer beyond the sweep extreme) |
| **Stop (short)** | `sweepCandle.high + 2 pts` |
| **Target 1** | `entry ± (riskPoints × 2.0)` — primary take-profit |
| **Target 2** | `entry ± (riskPoints × 3.0)` — extension target (logged, not executed) |
| **R:R** | `abs(entry − target1) / abs(entry − stop)` |

**Final filter:** If the calculated R:R is below **2.0**, the signal is discarded entirely. This happens when the stop has to be placed unusually wide relative to the available target (e.g., a very deep sweep with a small FVG high above it). No signal is logged.

The stop is always placed beyond the most extreme candle in the sweep window — not just the pierce candle — so that the stop accounts for the full wick excursion.

#### 11. SMT confluence annotation

The bot checks its SMT reference data at signal time. This data is maintained by the separate SMT loop running in parallel:

- The SMT loop switches the TradingView chart to ES, fetches candles, switches to YM, fetches candles, then restores NQ — all every 30 seconds.
- At signal evaluation, the bot calls `checkDivergence()` with the prev-cycle time window and checks whether ES and/or YM also made a new extreme in that same window.
- **SMT divergence** is present when NQ swept its cycle extreme but the correlated indices did not confirm it — implying the NQ sweep was a liquidity grab rather than genuine directional momentum.

**Important v1.0 note:** Automatic SMT divergence detection is a placeholder. The divergence booleans in the code are not yet computed (the intermarket ratio normalization is Phase 2 work). However, the ES and YM high/low levels for the cycle window are collected and logged alongside every signal so you can confirm visually on your charts. SMT is **not a hard gate** — the signal fires regardless of SMT status.

If ES/YM data is unavailable (e.g., the SMT loop hasn't run yet or the chart switch failed), the signal is annotated with `SMT: N/A` and is not blocked.

#### 12. Signal output

The signal object is built, the signal key is marked as fired, the trade counter increments, and the full signal is printed to the console:

```
Direction : ▲ LONG / ▼ SHORT
Entry     : FVG midpoint
Stop      : below/above sweep extreme + 2pt buffer
Target 1  : entry ± (risk × 2R)
Target 2  : entry ± (risk × 3R)  [extension]
R:R       : calculated ratio
Killzone  : NY AM / NY PM
Cycle     : index + cycle start time + prev H/L
Sweep     : type (HIGH_SWEEP / LOW_SWEEP) + level + sweep style (wick/body)
FVG       : zone [low – high] + gap size
SMT       : ES and YM levels + divergence status
```

No orders are placed in v1.0. The signal is informational only.

---

### Decision tree summary

```
Every 5 seconds:
│
├─ In killzone? (NY AM 9:30–11 or NY PM 1:30–3 ET)
│   └─ No → exit, wait
│
├─ Risk gate clear? (daily loss < 50pts AND trades < 3)
│   └─ No → exit, wait until tomorrow
│
├─ Cycle identified + prev-cycle H/L available?
│   └─ No → exit, need more candle history
│
├─ Sweep detected since cycle open?
│   └─ No → exit, log prevH/prevL for reference
│
├─ MSS confirmed after sweep? (V-shape, CISD, or body fallback)
│   └─ No → exit, watching for reversal candle
│
├─ FVG formed within 15 bars of MSS? (min 4pt gap)
│   └─ No → exit, expansion didn't leave an imbalance
│
├─ Current price inside upper half of FVG?
│   └─ No → exit, retrace not yet complete (re-check in 5s)
│
├─ Signal already fired for this cycle×direction today?
│   └─ Yes → exit, de-duped
│
├─ R:R ≥ 2.0?
│   └─ No → discard, stop too wide for available target
│
└─ SIGNAL FIRED → log to console
    (SMT data appended as confluence annotation)
```

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
| `sweep.thresholdPoints` | 0.25 | Points beyond cycle H/L for valid sweep pierce |
| `sweep.rejectionWindow` | 5 | Max candles after pierce to confirm close-back |
| `mss.deliveryLookback` | 20 | Bars back from sweep to find the CISD delivery candle |
| `mss.cisdLookforward` | 15 | Max bars forward from sweep to find CISD confirmation |
| `mss.minBodyPct` | 0.50 | Fallback body-to-range ratio if no delivery candle found |
| `fvg.minGapPoints` | 4 | Minimum FVG gap width in NQ points |
| `fvg.lookbackCandles` | 15 | Max candles forward from MSS to find FVG |
| `risk.stopBufferPoints` | 2 | Points beyond sweep extreme for stop placement |
| `risk.minRR` | 2.0 | Signals below this R:R are discarded |
| `risk.target1RR` | 2.0 | Primary target multiplier |
| `risk.target2RR` | 3.0 | Extension target multiplier |
| `risk.dailyLossLimitPoints` | -50 | Kill-switch threshold (−$1,000/contract) |
| `risk.maxTradesPerSession` | 3 | Max signals per trading day |
| `smt.enabled` | true | Toggle SMT reference data collection |
| `smt.requireBoth` | false | Both ES AND YM must diverge (stricter mode) |
| `pollIntervalMs` | 5000 | Main loop poll cadence (ms) |
| `smtPollIntervalMs` | 30000 | SMT symbol-switch loop cadence (ms) |

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
