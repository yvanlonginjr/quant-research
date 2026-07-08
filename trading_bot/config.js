// ============================================================
// FRANK369-BOT  —  MASTER CONFIGURATION
// ============================================================
// Every tunable parameter lives in this file.
// No magic numbers elsewhere. All engines import from here.
//
// TUNING GUIDE (Phase 2 notes):
//   • Start conservative: wider sweepThreshold, larger minBodyPct
//   • Tighten after backtesting with replay mode
//   • SMT weight / requireBoth are the highest-leverage levers
//   • dailyLossLimitPoints should reflect 1 contract at $20/pt
// ============================================================

export const config = {

  // ── MCP Server ──────────────────────────────────────────────
  mcp: {
    // Absolute path to the TradingView MCP server entry point.
    // The bot spawns this via stdio and communicates over JSON-RPC.
    serverPath: '/Users/yvanlongin/tradingview-mcp-jackson/src/server.js',
  },

  // ── Instruments ─────────────────────────────────────────────
  // Base symbols only — contract-manager.js appends the active
  // month+year code automatically (e.g. NQ → NQM26).
  // Rolls 8 calendar days before the 3rd Friday expiration.
  //
  // NQ is the ONLY traded instrument.
  // ES and YM are reference-only for SMT divergence.
  instruments: {
    nqBase: 'NQ',   // Nasdaq-100 E-mini  (primary — traded)
    esBase: 'ES',   // S&P 500 E-mini     (SMT reference, never traded)
    ymBase: 'YM',   // Dow Jones E-mini   (SMT reference, never traded)
  },

  // ── Chart Timeframe ─────────────────────────────────────────
  // TradingView timeframe string: '1'=1min, '5'=5min, '15'=15min
  // 1-min gives precision for sweep / MSS / FVG detection.
  // Change to '5' if too noisy after backtesting.
  timeframe: '1',

  // ── 90-Minute Cycle Engine ──────────────────────────────────
  // Session opens at 6:00 PM ET.  Cycle layout per trading day:
  //   Cycle 1 :  6:00 PM – 7:00 PM  ET  (60-min opener)
  //   Cycle 2 :  7:00 PM – 8:30 PM  ET
  //   Cycle 3 :  8:30 PM – 10:00 PM ET
  //   Cycle 4 : 10:00 PM – 11:30 PM ET
  //   Cycle 5 : 11:30 PM – 1:00 AM  ET
  //   Cycle 6 :  1:00 AM – 2:30 AM  ET
  //   Cycle 7 :  2:30 AM – 4:00 AM  ET
  //   Cycle 8 :  4:00 AM – 5:30 AM  ET
  //   Cycle 9 :  5:30 AM – 7:00 AM  ET
  //   Cycle 10:  7:00 AM – 8:30 AM  ET
  //   Cycle 11:  8:30 AM – 10:00 AM ET
  //   Cycle 12: 10:00 AM – 11:30 AM ET
  //   Cycle 13: 11:30 AM – 1:00 PM  ET
  //   Cycle 14:  1:00 PM – 2:30 PM  ET
  //   Cycle 15:  2:30 PM – 4:00 PM  ET
  //   Dead zone: 4:00 PM – 6:00 PM ET (no cycles, no trading)
  cycle: {
    startHour:           18,   // 6:00 PM ET — session anchor
    startMinute:          0,
    openingCycleMins:    60,   // Cycle 1 is 60 min (6–7 PM)
    durationMinutes:     90,   // Cycles 2–15 are 90 min each
    historyBars:        300,
  },

  // ── Time of Interest (TOI) ───────────────────────────────────
  // The only valid entry window: XX:45 – XX:15 around each hour mark.
  // e.g. 9:45–10:15, 10:45–11:15, 1:45–2:15, etc.
  // Signals outside this window are ignored entirely.
  toi: {
    enabled: true,
  },

  // ── Higher-TF Bias / Directional Filter ─────────────────────
  // Compares current NQ price to the PREVIOUS SESSION CLOSE
  // (last bar before the 6 PM ET session anchor = the 4 PM ET close
  // of the prior trading day, or Friday close on Monday).
  //
  //   current > prevClose + threshold  → bullish bias
  //   current < prevClose - threshold  → bearish bias
  //   within threshold                 → neutral (both directions OK)
  //
  // mode 'hard' → rejects counter-trend trades outright.
  // mode 'soft' → flags only; both directions still traded.
  htfBias: {
    enabled: true,
    // 'hard' → reject counter-trend trades outright
    // 'soft' → flag only; both directions traded
    mode:    'hard',
  },

  // ── Session Trading Filter ───────────────────────────────────
  // Asia session (6 PM – 2 AM ET) is excluded from trade entries.
  // Asia price levels (H/L) are still tracked for analysis.
  // Trading starts from London (2 AM ET) onwards.
  sessionFilter: {
    noTradeSession: 'Asia',   // session name to block entries in
  },

  // ── Liquidity Sweep Detection ───────────────────────────────
  // A sweep is confirmed when price pierces a level AND closes back
  // through it within `rejectionWindow` candles (sweep vs breakout).
  //
  // Pierce detection uses the candle wick (high/low).  If the wick
  // qualifies but the close stays beyond the level, up to
  // `rejectionWindow` subsequent candles are checked for a
  // close-back.  If none close back → breakout, no trade.
  //
  // `sweepCandle` is set to the candle with the most extreme wick
  // in the sweep window — stop is placed beyond that extreme.
  sweep: {
    thresholdPoints:  0.25,  // minimum wick pierce beyond the level
    rejectionWindow:  5,     // max candles after pierce to confirm close-back
    // Minimum bars the previous cycle must contain for its H/L to be
    // considered a well-formed liquidity level worth sweeping.
    // Low bar count = thin overnight session = unreliable level.
    qualityMinPrevBars: 25,
  },

  // ── Market Structure Shift (MSS) via CISD ───────────────────
  // After the sweep we look for a CISD (Change in State of Delivery):
  // a candle that closes BEYOND the open of the last opposing delivery
  // candle, signalling an institutional state flip.
  //
  //   Long setup  (after LOW sweep):
  //     → find last BEARISH candle within deliveryLookback bars of sweep
  //     → CISD = first candle that closes ABOVE that bearish candle's open
  //
  //   Short setup (after HIGH sweep):
  //     → find last BULLISH candle within deliveryLookback bars of sweep
  //     → CISD = first candle that closes BELOW that bullish candle's open
  //
  // If no delivery candle is found (rare — e.g. gap open), falls back
  // to the v1.0 body-ratio rule (minBodyPct).
  mss: {
    deliveryLookback: 20,   // bars back from sweep to find delivery candle
    cisdLookforward:  15,   // max bars forward from sweep to find CISD
    minBodyPct:       0.50, // fallback body-to-range ratio if no delivery candle
  },

  // ── Fair Value Gap (FVG) Entry ──────────────────────────────
  // A 3-candle imbalance: candle[i-1] and candle[i+1] have a gap
  // that candle[i]'s body doesn't fill.
  // Entry triggers when price retraces into the upper half after MSS.
  //
  // FVG quality tiers (attached to each trade, not a hard gate):
  //   small  < smallGapPoints  pts  — low confidence
  //   medium   between small and large
  //   large  > largeGapPoints  pts  — high confidence
  fvg: {
    minGapPoints:    4,    // raised from 2 — sub-4pt FVGs are noise
    lookbackCandles: 15,
    smallGapPoints:  8,    // below this → 'small' quality label
    largeGapPoints:  20,   // above this → 'large' quality label
  },

  // ── 1H PD Zone Gate (top-down precondition) ────────────────
  // Price must be AT a 1H Breaker Block, Order Block, or FVG before
  // any sweep/MSS/FVG sequence is evaluated.  This is the primary
  // architectural gate that makes the engine top-down.
  //
  // proximityPts: how far price can be from the zone boundary and
  //   still count as "approaching/at" the zone.  Handles cases where
  //   price hasn't yet printed inside the zone but is clearly retracing
  //   toward it.
  //
  // fvgOverlapTolerancePts: the 1m FVG is allowed to form this many
  //   pts ABOVE the 1H zone high and still count as spatially valid.
  //   Handles Trade 3 ("price almost taps into Breaker but does enough
  //   for the FVG") where the FVG sits just above the zone top.
  htfZone: {
    enabled:                 true,
    proximityPts:            50,   // zone-approach tolerance in NQ pts
    fvgOverlapTolerancePts:  35,   // 1m FVG can be this far above/below zone edge
  },

  // ── SMT Divergence ──────────────────────────────────────────
  // NQ makes a new cycle high/low but ES and/or YM fails to confirm.
  // SMT is confluence (adds confidence) but is NOT a hard gate.
  // Checked at 90m, 30m, and 10m cycle levels simultaneously.
  //
  // tolerance: how many points each instrument can fall SHORT of its
  // own previous-cycle extreme and still be counted as "diverging."
  // Scales are different: ES ~5400, YM ~40000, NQ ~21000.
  smt: {
    enabled:     true,
    // requireBoth = true  → both ES AND YM must diverge (strict)
    // requireBoth = false → either ES OR YM diverges (lenient; default)
    requireBoth: false,
    tolerance: {
      es: 2,   // ES points (~8 ticks; ~0.04% of price)
      ym: 10,  // YM points (~10 ticks; ~0.025% of price)
    },
  },

  // ── Risk Management ─────────────────────────────────────────
  risk: {
    // Stop loss is placed this many points BEYOND the sweep extreme
    stopBufferPoints: 2,

    // Discard signal if calculated R:R is below this ratio
    minRR: 2.0,

    // Discard signal if absolute stop distance is below this many points.
    // Prevents trading noise setups where a 1-tick move stops the trade.
    minRiskPoints: 5,

    // Primary take-profit target (multiple of risk)
    target1RR: 2.0,   // 2:1 — minimum acceptable
    // Extension target (logged, not executed in v1.0)
    target2RR: 3.0,   // 3:1 extension

    // Daily loss kill switch.
    // Trading stops for the day if total paper loss exceeds this many NQ points.
    // At $20/pt per 1 NQ contract: -50 pts = -$1,000
    dailyLossLimitPoints: -50,

    // Maximum signals fired per session day (AM + PM combined).
    // Prevents overtrading on choppy/whipsaw days.
    maxTradesPerSession: 3,
  },

  // ── Polling ─────────────────────────────────────────────────
  // Main loop cadence for NQ candle data
  pollIntervalMs: 5000,    // 5 seconds — tight enough to catch 1-min bar closes

  // SMT symbol-switch poll cadence (slower to reduce chart disruption)
  smtPollIntervalMs: 30000,  // 30 seconds; SMT levels don't need sub-minute updates
};
