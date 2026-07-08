# Frank369-Bot: An Automated ICT Liquidity Cycle Signal Engine

**Version:** 1.1  
**Instrument:** NQ (E-mini Nasdaq-100 Futures)  
**Author:** Yvan Longin  
**Status:** Research / Backtesting Phase

---

## Abstract

Frank369-Bot is an algorithmic signal engine built around the Frank/Zeussy "369" trading methodology — an application of Inner Circle Trader (ICT) concepts structured around 90-minute liquidity cycles. The system identifies high-probability trade setups by detecting liquidity sweeps at multiple timeframe cycle levels, confirming market structure shifts (MSS) via Change in State of Delivery (CISD), and entering through Fair Value Gaps (FVGs) during defined Time of Interest (TOI) windows. Higher timeframe bias is determined through Draw on Liquidity (DOL) analysis, 1H Price Delivery Arrays (PD Arrays), and Smart Money Technique (SMT) divergence across NQ, ES, and YM.

The bot interfaces with TradingView via a local MCP (Model Context Protocol) server and is developed iteratively through manual backtesting against annotated A+ trade setups.

---

## 1. Trading Methodology

### 1.1 The Frank/Zeussy 369 Model

The 369 model is derived from ICT's liquidity cycle framework. It operates on the premise that institutional order flow creates predictable liquidity patterns within fixed time windows. Every trading day is divided into a series of 90-minute cycles anchored to the 6:00 PM ET session open. Price repeatedly targets the highs and lows created by prior cycles — sweeping liquidity, then reversing.

The core trade premise:
> Price sweeps a prior cycle's high or low, clears the resting orders beyond that level, then reverses and delivers to the opposite side of the cycle range.

### 1.2 Session Structure

| Session | Time (ET) | Role |
|---|---|---|
| Asia | 6:00 PM – 2:00 AM | Liquidity accumulation, range formation |
| London | 2:00 AM – 7:00 AM | Initial delivery, often sets the day's bias |
| Pre-NY | 7:00 AM – 9:30 AM | Setup formation ahead of NY open |
| NY AM | 9:30 AM – 11:30 AM | Primary institutional flow window |
| Lunch | 11:30 AM – 1:00 PM | Lower volume, continuation or reversal |
| NY PM | 1:00 PM – 4:00 PM | Secondary institutional flow window |
| Dead Zone | 4:00 PM – 6:00 PM | No trading; no cycle tracking |

**Asia session entries are blocked.** Asia price levels are tracked for analysis (high/low used as DOL candidates and session context) but no trade entries are taken during this session.

### 1.3 Cycle Framework

```
Session anchor: 6:00 PM ET

  Cycle 1  :  6:00 PM – 7:00 PM  (60 min)
  Cycle 2  :  7:00 PM – 8:30 PM  (90 min)
  Cycle 3  :  8:30 PM – 10:00 PM
  Cycle 4  : 10:00 PM – 11:30 PM
  Cycle 5  : 11:30 PM – 1:00 AM
  Cycle 6  :  1:00 AM – 2:30 AM
  Cycle 7  :  2:30 AM – 4:00 AM
  Cycle 8  :  4:00 AM – 5:30 AM
  Cycle 9  :  5:30 AM – 7:00 AM
  Cycle 10 :  7:00 AM – 8:30 AM
  Cycle 11 :  8:30 AM – 10:00 AM
  Cycle 12 : 10:00 AM – 11:30 AM
  Cycle 13 : 11:30 AM – 1:00 PM
  Cycle 14 :  1:00 PM – 2:30 PM
  Cycle 15 :  2:30 PM – 4:00 PM
```

Each 90-minute cycle subdivides into:
- **3 × 30-minute sub-cycles**
- **9 × 10-minute sub-cycles** (tracked globally from session anchor)

### 1.4 Time of Interest (TOI)

The only valid entry window is **XX:45 – XX:15** around each hour mark (e.g., 9:45–10:15, 10:45–11:15, 1:45–2:15). This 30-minute window centered on each hour is where institutional order flow is most concentrated. All signals outside this window are discarded.

---

## 2. Signal Pipeline

The signal engine runs on 1-minute bars and processes every bar through a sequential pipeline. Each stage must pass before proceeding to the next.

```
[Bar arrives]
    │
    ▼
[1] Dead zone / Pre-anchor check        → skip 4–6 PM ET
    │
    ▼
[2] Asia session block                  → skip entries, keep levels
    │
    ▼
[3] TOI filter (XX:45–XX:15)           → skip if outside window
    │
    ▼
[4] HTF bias computation               → DOL + 1H PD Arrays + sweeps + SMT
    │
    ▼
[5] Sweep detection (10m → 30m → 90m) → wick pierce + close-back rejection
    │
    ▼
[6] MSS via CISD                        → Change in State of Delivery confirmed
    │
    ▼
[7] FVG detection                       → 3-candle imbalance post-MSS
    │
    ▼
[8] FVG entry (upper half)             → price retraces into FVG upper half
    │
    ▼
[9] Risk validation                     → min risk, min R:R, geometric validity
    │
    ▼
[10] HTF directional filter (hard)     → reject counter-trend in strong bias
    │
    ▼
[SIGNAL FIRED]
```

### 2.1 Sweep Detection

A liquidity sweep is confirmed when:
1. Price wicks **beyond** a reference level by at least 0.25 NQ points
2. The bar or a subsequent bar (within 5 candles) **closes back** through the level
3. A clean close-back = sweep; no close-back = breakout (disqualified)

**Reference levels checked (most granular wins):**
- 10m sub-cycle high/low (previous completed 10m window)
- 30m sub-cycle high/low (previous completed 30m window)  
- 90m cycle high/low (previous completed 90m cycle)

The sweep at the most granular level that fires is used as the entry trigger. This allows the bot to catch intra-cycle setups that the original 90m-only detection would miss.

**Sweep quality:** All sweeps occurring inside the TOI window are classified as `high` quality. Sweeps outside are `medium`.

**Minimum prev-cycle bar count:** The previous cycle must contain at least 25 bars (1-min) to be considered a well-formed liquidity level. Thin cycles (e.g., overnight Asia with sparse volume) are disqualified.

### 2.2 Market Structure Shift (MSS) via CISD

After a sweep, a Change in State of Delivery (CISD) confirms the institutional flip:

**Long setup (after LOW sweep):**
1. Find the last **bearish** candle within 20 bars before the sweep (the prior delivery candle)
2. Look forward up to 15 bars for a candle that **closes above that bearish candle's open**
3. That close = CISD = MSS confirmed

**Short setup (after HIGH sweep):**
1. Find the last **bullish** candle within 20 bars before the sweep
2. Look forward up to 15 bars for a candle that **closes below that bullish candle's open**

If no delivery candle is found (e.g., gap opens), falls back to a 50% body-to-range ratio rule.

### 2.3 Fair Value Gap (FVG) Entry

A Fair Value Gap is a 3-candle imbalance where candle[i-1] and candle[i+1] do not overlap:
- **Bullish FVG:** `candle[i-1].high < candle[i+1].low`
- **Bearish FVG:** `candle[i-1].low > candle[i+1].high`

**Entry trigger:** Price retraces into the **upper half** of the FVG (at or above the midpoint for longs, at or below midpoint for shorts). This is the actual entry candle close price.

**Minimum gap size:** 4 NQ points. Sub-4pt FVGs are classified as noise.

**FVG quality tiers:**
| Label | Gap Size |
|---|---|
| Small | < 8 pts |
| Medium | 8–20 pts |
| Large | > 20 pts |

### 2.4 Stop Placement

Stop is placed beyond the **candle immediately prior to the FVG formation** (the candle that precedes the 3-candle imbalance), plus a 2-point buffer:
- Long: `stop = priorCandle.low − 2`
- Short: `stop = priorCandle.high + 2`

If no prior candle is available, falls back to the sweep candle extreme.

**Minimum risk:** 5 NQ points. Setups with stops tighter than this are discarded as noise.

### 2.5 Target Calculation

**Target 1 (A target):** The opposite extreme of the previous 90m cycle range.
- Long: previous cycle high
- Short: previous cycle low
- Floor: minimum 1.5R from entry (if natural target is too close, enforced minimum applies)

**Target 2 (B target):** T1 extended by 50% of the T1 distance.
- `T2 = T1 + (T1 − entry) × 0.5`

**Minimum R:R:** 2.0. Setups below this ratio are discarded.

### 2.6 Exit Simulation (Partial Model)

The bot simulates a **50% partial exit** model:
- Half the position exits at T1
- Half runs to T2

| Result | Condition |
|---|---|
| Win | Both T1 and T2 hit |
| Partial | T1 hit, T2 missed (stopped or timed out) |
| Loss | Stopped before T1 |
| Timeout | T1 never hit within 90 bars |

---

## 3. Higher Timeframe Analysis

### 3.1 Key Reference Levels

The following levels are tracked daily as Draw on Liquidity (DOL) candidates:

| Level | Definition |
|---|---|
| PDH / PDL | Previous complete session H/L (6 PM–4 PM ET) |
| Weekly High / Low | Current week's range since Sunday 6 PM ET |
| Weekly Open | First 1-min print of the trading week |
| Monthly Open | First print of the calendar month |
| Quarterly Open | First print of Q1 (Jan), Q2 (Apr), Q3 (Jul), Q4 (Oct) |
| Yearly Open | First print of the calendar year |

These levels are computed fresh each session from the full 1-min bar history.

### 3.2 Draw on Liquidity (DOL)

The DOL is the **nearest unmitigated major reference level** above or below current price. It represents the magnetic target price is being drawn toward.

- DOL above → bullish draw (price targeting buy-side liquidity)
- DOL below → bearish draw (price targeting sell-side liquidity)
- DOL contributes **±1** to the HTF bias score

Session intraday H/L are excluded from DOL calculation (too noisy, too close to price).

### 3.3 1H PD Arrays

The following 1H structures are detected and scored:

| Structure | Description | Score |
|---|---|---|
| Bullish FVG (unmitigated) | 1H 3-candle gap below current price, not yet filled | +1 |
| Bearish FVG (unmitigated) | 1H 3-candle gap above current price, not yet filled | −1 |
| Bullish Order Block | Last bearish 1H candle before bullish impulse (unmitigated) | +1 |
| Bearish Order Block | Last bullish 1H candle before bearish impulse (unmitigated) | −1 |
| Bullish Breaker Block | Mitigated bullish OB that price has returned to (support) | +1 |
| Bearish Breaker Block | Mitigated bearish OB that price has returned to (resistance) | −1 |

A **Breaker Block** is a mitigated Order Block — the OB was initially formed, price later traded through it (mitigation), and price has now returned to the zone. It acts from the opposite side of the original OB.

**Proximity filter:** Only 1H FVGs within 300 NQ points of current price are considered.

### 3.4 1H Liquidity Sweeps

The most recent 1H sweep of a major reference level (last 6 1H bars):
- 1H swept a low → **+2** (strongest bullish signal — sell-side cleared, buy-side run likely)
- 1H swept a high → **−2** (strongest bearish signal — buy-side cleared, sell-side run likely)

A sweep at the 1H level requires a wick through the level + close back on the origin side.

### 3.5 1H SMT Divergence

Smart Money Technique (SMT) divergence occurs when NQ makes a new extreme but ES and/or YM fails to confirm:
- NQ new high, ES/YM fails to confirm → bearish divergence (−1)
- NQ new low, ES/YM fails to confirm → bullish divergence (+1)

SMT is checked at three levels simultaneously: 90m, 30m, and 10m cycle windows.

### 3.6 HTF Bias Scoring

| Signal | Weight |
|---|---|
| DOL direction | ±1 |
| 1H liquidity sweep | ±2 |
| 1H FVG in play | ±1 |
| 1H Order Block in play | ±1 |
| 1H Breaker Block in play | ±1 |
| 1H SMT divergence | ±1 |

**Bias thresholds:**
- Score ≥ +2 → **Bullish** (hard mode: longs only)
- Score ≤ −2 → **Bearish** (hard mode: shorts only)
- Score −1 to +1 → **Neutral** (both directions valid)

The hard directional filter blocks counter-trend entries when bias is clearly established. It does not block neutral setups.

---

## 4. Technical Architecture

### 4.1 Stack

| Component | Technology |
|---|---|
| Runtime | Node.js (ESM) |
| Chart data source | TradingView Desktop (via MCP) |
| MCP transport | stdio JSON-RPC |
| Data format | 1-minute OHLCV bars |
| Output | Console log + Excel (.xlsx) + PNG screenshots |

### 4.2 File Structure

```
frank369-bot/
├── config.js                    — Master configuration (all parameters)
├── PAPER.md                     — This document
├── src/
│   ├── backtest.js              — Main backtest runner
│   ├── candle-buffer.js         — Rolling bar buffer with range queries
│   ├── contract-manager.js      — Active futures contract tracking
│   ├── logger.js                — Timestamped console logger
│   ├── mcp-client.js            — TradingView MCP client (stdio)
│   ├── trade-logger.js          — JSON trade persistence
│   ├── trade-visualizer.js      — TradingView drawings + Excel export
│   └── engines/
│       ├── cycle-engine.js      — 90m/30m/10m cycle math + H/L queries
│       ├── fvg-detector.js      — Sweep, MSS (CISD), FVG detection
│       ├── htf-engine.js        — 1H aggregation, DOL, PD arrays, BB, SMT
│       ├── killzone.js          — ET time utilities, TOI (isPremiumWindow)
│       ├── levels-engine.js     — PDH/PDL, weekly/monthly/quarterly/yearly opens
│       ├── session-engine.js    — Intraday session H/L tracking
│       ├── signal-engine.js     — (Live trading signal wrapper)
│       └── smt-engine.js        — NQ/ES/YM SMT divergence at 90m/30m/10m
└── data/
    ├── trades.json              — Cumulative trade log
    └── backtest_NN/             — Per-run output folders
        ├── trades.xlsx
        └── screenshots/
```

### 4.3 Data Collection (Backtest Mode)

The backtest collects 1-minute OHLCV bars for NQ, ES, and YM using TradingView's replay snapshot mode. Each replay snapshot loads ~489 bars. Multiple snapshots are stitched together, deduplicated, and sorted chronologically.

The process takes approximately 8–10 minutes for a 13-day window across 3 instruments.

**No look-ahead bias:** The simulation loop processes bars sequentially. For each bar at index `i`, only `bars[0..i]` are visible. 1H bars are filtered to `time <= nowMs` before each HTF evaluation.

### 4.4 Key Configuration Parameters

```javascript
sweep: {
  thresholdPoints:   0.25,  // min wick pierce beyond the level
  rejectionWindow:   5,     // max candles after pierce to confirm close-back
  qualityMinPrevBars: 25,   // min bars in prev cycle for level to be valid
}

mss: {
  deliveryLookback: 20,     // bars back from sweep to find delivery candle
  cisdLookforward:  15,     // max bars forward to find CISD
  minBodyPct:       0.50,   // fallback body ratio if no delivery candle
}

fvg: {
  minGapPoints:    4,       // minimum FVG size
  lookbackCandles: 15,      // bars after MSS to search for FVG
  smallGapPoints:  8,
  largeGapPoints:  20,
}

risk: {
  stopBufferPoints: 2,
  minRR:            2.0,
  minRiskPoints:    5,
  target1RR:        2.0,
  target2RR:        3.0,
  dailyLossLimitPoints: -50,
  maxTradesPerSession:   3,
}

toi: {
  enabled: true,            // XX:45–XX:15 hard gate
}
```

---

## 5. Backtest Results

### 5.1 Methodology Notes

- **Execution model:** Entry at 1-min bar close when price enters FVG upper half
- **Slippage:** Not modeled (1-min close price used as fill)
- **Commissions:** Not modeled
- **Contract value:** $20/point per NQ contract
- **Position model:** 50% partial exit at T1, 50% at T2

### 5.2 Results — April 5–17, 2026 (Backtest 17)

**Market context:** Extreme volatility period. Tariff-related gap events April 2–9. Conditions not representative of normal NQ behavior.

| Metric | Value |
|---|---|
| Period | Apr 5–17, 2026 (13 calendar days) |
| Total 1-min bars | 5,130 |
| Total signals | 5 |
| Wins (full) | 1 |
| Partials (T1 hit) | 1 |
| Losses | 3 |
| Timeouts | 0 |
| T1 hit rate | 40.0% |
| Profit factor | 2.00 |
| Total P&L | +72.94 pts |
| Approx. value (1 contract) | +$1,459 |
| Max consecutive losses | 3 |
| Trades in TOI window | 5/5 (100%) |

**Individual signals:**

| # | Date | Time | Dir | Swept | Result | P&L |
|---|---|---|---|---|---|---|
| 1 | Apr 6 | 14:00 ET | Long | 90m | Partial | +84.00 |
| 2 | Apr 16 | 13:54 ET | Short | 30m | Win | +21.00 |
| 3 | Apr 17 | 11:50 ET | Short | 30m | Loss | −20.00 |
| 4 | Apr 17 | 12:05 ET | Short | 90m | Loss | −21.75 |
| 5 | Apr 17 | 14:07 ET | Long | 90m | Loss | −31.00 |

**Note:** Trades 3 and 4 are near-identical setups (same stop, same target, 15 min apart) that passed the dedup filter due to different 30m slot indices. This represents a known double-entry issue.

### 5.3 Historical Comparison

| Run | Config | Signals | P&L | PF |
|---|---|---|---|---|
| v1.0 baseline | PDC HTF bias | ~7 | −32.25 | 0.70 |
| HTF engine v1 | DOL + 1H arrays, hard filter | 1 | −15.25 | 0.00 |
| HTF engine v2 | Recalibrated scoring | 7 | −32.25 | 0.70 |
| **v1.1 current** | **TOI + sub-cycle sweeps + BB** | **5** | **+72.94** | **2.00** |

---

## 6. Known Limitations and Open Issues

### 6.1 Signal Detection Gaps

**Sub-cycle sweeps underperforming:** The 10m sub-cycle sweep fires rarely. Most signals still use 90m cycle levels. The user's manually-graded A+ setups (Apr 13–14) were not detected by the automated pipeline — the MSS/FVG stage likely fails after the sub-cycle sweep is found.

**Breaker Block entries not firing:** Breaker Blocks are tracked in the HTF scoring (+1 to bias) but are not used as direct entry triggers or as standalone confluence gates at the 1m level.

**Multi-timeframe FVGs:** Only 1H FVGs are detected in the HTF engine. 15-minute FVGs (referenced in user annotations as key confluence) are not tracked.

**Centerline logic absent:** The ICT "centerline" concept (midpoint of a range or OB acting as a level) is referenced in A+ setup annotations but not coded.

### 6.2 Backtest Limitations

- **Sample size:** 5 trades is statistically insufficient to evaluate edge. Minimum 50–100 trades required.
- **Period bias:** Apr 5–17 included tariff-crisis conditions. Performance in normal conditions is unknown.
- **No slippage or commission modeling:** Real fills on 1-min bars will differ, especially in volatile conditions.
- **Double-entry risk:** New 30m-slot dedup can fire two near-identical trades in the same 90m cycle.

### 6.3 Live Trading Gaps

- **No order execution:** The bot signals but does not place orders. Live trading integration not built.
- **Replay vs live data:** Backtest uses TradingView replay mode. Live data streaming not tested.
- **Contract roll:** Contract manager handles roll automatically (8 days before 3rd Friday expiration) but live testing has not been performed.

---

## 7. Setup Grading Framework

Based on analysis of manually-annotated trade examples, the following grading rubric has emerged:

### A+ Setup (All conditions met unambiguously)

- HTF clearly and unambiguously bullish/bearish — no interpretation required
- Clean Breaker Block + FVG combination at the entry zone
- 10m or 30m sub-cycle sweep with decisive V-shaped rejection
- SMT divergence with ES/YM confirming
- Inside TOI window (XX:45–XX:15)
- DOL clearly aligned with trade direction

### B+ Setup (Solid but with minor ambiguity)

- HTF bullish/bearish but requires some interpretation
- Multiple confluence factors present (OB, Centerline, SMT) but no single dominant factor
- Sub-cycle sweep present but rejection less decisive
- Inside TOI window

### Below Grade (Not taken)

- HTF unclear or counter to trade direction
- Outside TOI window
- Sweep without clean close-back rejection
- Small FVG (< 8 pts) with tight stop

---

## 8. Roadmap

### Near-term (v1.2)

- [ ] Fix double-entry dedup — block re-entry if same direction already active in cycle
- [ ] Add 10m FVG detection as a standalone entry confluence layer
- [ ] Add Breaker Block as hard confluence gate (not just HTF scoring)
- [ ] Extend backtest to 60+ days across normal market conditions
- [ ] Calibrate MSS/FVG detection against more A+ examples

### Medium-term (v1.3)

- [ ] 15-minute FVG detection and scoring
- [ ] Centerline detection (range midpoint + OB midpoint)
- [ ] Parametric sweep sensitivity — tune per-session (London vs NY AM vs NY PM)
- [ ] Raise `minRiskPoints` to 15 (filter sub-15pt stop setups)
- [ ] Commission and slippage modeling in backtest

### Long-term (v2.0)

- [ ] Live order execution integration
- [ ] Real-time signal alerting (push notification / Discord)
- [ ] Walk-forward optimization framework
- [ ] Multi-session performance breakdown (separate NY AM vs NY PM statistics)
- [ ] A+ setup classifier trained on manually-annotated examples

---

## 9. Glossary

| Term | Definition |
|---|---|
| CISD | Change in State of Delivery — candle closing beyond the open of the prior opposing delivery candle; confirms institutional flip |
| DOL | Draw on Liquidity — the nearest unmitigated reference level that price is magnetically targeting |
| FVG | Fair Value Gap — 3-candle price imbalance where candle[i-1] and candle[i+1] do not overlap |
| ICT | Inner Circle Trader — trading methodology developed by Michael Huddleston |
| MSS | Market Structure Shift — the moment price structure flips direction after a sweep |
| OB | Order Block — the last opposing candle before an impulsive move; acts as support/resistance on return |
| Breaker Block | A mitigated Order Block; originally acted as support/resistance, was broken through, now acts from the opposite side |
| PDH/PDL | Previous Day High/Low (within the 6 PM–4 PM ET session definition) |
| PD Array | Price Delivery Array — collective term for ICT structured levels (OB, FVG, BB, etc.) |
| SMT | Smart Money Technique — divergence between correlated instruments (NQ vs ES/YM) signaling a false move |
| TOI | Time of Interest — the XX:45–XX:15 window around each hour mark; highest-probability entry timing |
| 369 | The Frank/Zeussy model name, referencing the 3 sub-cycles (30m), 6 sub-sub-cycles (10m), and 9 total sub-cycles within a 90m window (informal naming) |
