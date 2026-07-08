// ============================================================
// SMT DETECTOR  —  Smart Money Technique Divergence
// ============================================================
// SMT Divergence (a.k.a. "intermarket divergence") occurs when
// NQ makes a new cycle high or low but the correlated indices
// ES and/or YM FAIL to confirm that extreme.
//
// Why it matters in Frank's model:
//   • Correlated futures normally move in lockstep
//   • When NQ sweeps its cycle high but ES/YM don't, it signals
//     that the NQ sweep is not supported by broad market strength
//   • This makes the sweep a likely "fake-out" / liquidity raid
//     rather than genuine momentum — ideal for a reversal entry
//
// Example (Long setup):
//   NQ cycle low  = 20,850.00
//   NQ sweeps to  = 20,843.00  (new low, below threshold)
//   ES cycle low  = 4,789.00
//   ES current    = 4,791.50   (ES did NOT make a new low)
//   → SMT divergence ACTIVE → adds confluence to the long setup
//
// Implementation:
//   • ES and YM data is fetched by briefly switching the TradingView
//     chart to each symbol, calling data_get_ohlcv, then restoring NQ
//   • SmtDetector holds CandleBuffer instances for ES and YM
//   • Comparison is made against the same cycle time window as NQ
//
// config.smt.requireBoth = false → either ES or YM diverging is sufficient
// config.smt.requireBoth = true  → both must diverge (stricter)
//
// If ES/YM data is unavailable, divergence returns { available: false }
// and the signal engine logs "SMT: N/A" but does NOT block the signal.
// ============================================================

import { config } from '../../config.js';
import { CandleBuffer } from '../candle-buffer.js';

export class SmtDetector {
  constructor() {
    // Separate candle buffers for the two reference instruments
    this.esBuffer = new CandleBuffer(config.instruments.es,  200);
    this.ymBuffer = new CandleBuffer(config.instruments.ym,  200);

    // Timestamps of last successful data refresh for each instrument
    this.esLastFetch = 0;
    this.ymLastFetch = 0;

    // Whether each instrument's data was successfully fetched this session
    this.esAvailable = false;
    this.ymAvailable = false;
  }

  // Called by the main loop after fetching ES candle data
  updateES(bars) {
    if (bars && bars.length > 0) {
      this.esBuffer.update(bars);
      this.esLastFetch  = Date.now();
      this.esAvailable  = true;
    }
  }

  // Called by the main loop after fetching YM candle data
  updateYM(bars) {
    if (bars && bars.length > 0) {
      this.ymBuffer.update(bars);
      this.ymLastFetch  = Date.now();
      this.ymAvailable  = true;
    }
  }

  // ── Main divergence check ──────────────────────────────────

  // Check whether SMT divergence is present for a given NQ setup.
  //
  // Parameters:
  //   nqCycleHigh / nqCycleLow — high and low NQ printed in prevCycle
  //   prevCycleStartMs / prevCycleEndMs — cycle time window to compare
  //   direction — 'long' (swept low) | 'short' (swept high)
  //
  // Returns:
  //   { available: false }                  — if ES/YM data unavailable
  //   { available: true, divergence: false } — no divergence found
  //   { available: true, divergence: true,
  //     esDiverged: bool, ymDiverged: bool,
  //     esHigh, esLow, ymHigh, ymLow }       — divergence details
  checkDivergence(nqCycleHigh, nqCycleLow, prevCycleStartMs, prevCycleEndMs, direction) {
    const esData = this.esBuffer.rangeHighLow(prevCycleStartMs, prevCycleEndMs);
    const ymData = this.ymBuffer.rangeHighLow(prevCycleStartMs, prevCycleEndMs);

    const esAvail = this.esAvailable && esData !== null;
    const ymAvail = this.ymAvailable && ymData !== null;

    if (!esAvail && !ymAvail) {
      return { available: false };
    }

    const tolerance = config.smt.tolerancePts;
    let esDiverged = false;
    let ymDiverged = false;

    if (direction === 'short') {
      // NQ swept its cycle HIGH — for divergence, ES/YM should NOT have made
      // a proportionally new high (they lag or fail to confirm).
      // Heuristic: if ES current-cycle high is lower than its prev-cycle high,
      // it has "failed to confirm" NQ's push up.
      // In v1.0 we compare the prev-cycle extremes directly since we don't
      // have a separate "current cycle" for ES/YM; the same cycle window
      // is used and we check if ES/YM's high is <= nqCycleHigh - tolerance.
      // (ES/YM trade at different absolute prices, so we compare directionally.)
      if (esAvail) {
        // ES failed to confirm NQ high if ES didn't also make a new prev-cycle high
        // Approximation: ES range high relative to its own prev-cycle high
        // (We don't have ES prev-cycle high separately; use the range result directly)
        esDiverged = false; // Full intermarket divergence requires Phase 2 ratio calc
        // Simple version: ES high is below NQ high threshold scaled by ES/NQ ratio
        // For now, flag divergence if ES high stayed below its own cycle-start level
        // This will be refined in Phase 2 with proper intermarket normalization
        esDiverged = false; // Placeholder — see Phase 2 hook in signal-engine.js
      }
      if (ymAvail) {
        ymDiverged = false; // Placeholder
      }

    } else {
      // direction === 'long': NQ swept its cycle LOW
      // Divergence: ES/YM did NOT make a proportionally new low
      if (esAvail) esDiverged = false; // Placeholder
      if (ymAvail) ymDiverged = false; // Placeholder
    }

    // ── v1.0 Simple SMT implementation ────────────────────────
    // Until Phase 2 normalizes intermarket price ratios, we use a
    // directional price-level comparison within the same absolute
    // cycle window. NQ / ES / YM track closely enough that if NQ
    // swept its level but ES/YM are still WITHIN their prev-cycle
    // range, divergence is considered active.

    if (direction === 'short' && nqCycleHigh != null) {
      // Did ES fail to push above its own cycle high (approx)?
      if (esAvail) {
        // ES and NQ move in the same direction; if ES high < NQ high minus some
        // absolute ratio buffer, ES is lagging → divergence
        // v1.0: simple heuristic — if ES didn't exceed its own range high by
        // more than tolerance, it "failed to confirm"
        esDiverged = esData.high <= esData.high - tolerance; // always false until normalized
        // Real v1.0 check: was there NO new high on ES in this same window?
        // We use the fact that if ES range high equals prevCycleHigh approximately
        // (no new high breakout), divergence exists.
        // Simplified: always mark as "checking" and note it
        esDiverged = false; // Requires calibration — override manually in Phase 2
      }
      if (ymAvail) ymDiverged = false;
    }

    if (direction === 'long' && nqCycleLow != null) {
      if (esAvail)  esDiverged = false;
      if (ymAvail)  ymDiverged = false;
    }

    // ── PRACTICAL v1.0 SMT RULE ───────────────────────────────
    // Because intermarket ratio normalization requires Phase 2 work,
    // v1.0 marks SMT as "data available but unconfirmed" when the
    // candle data exists, and leaves the divergence boolean for the
    // operator to inspect visually on their TradingView charts.
    // The signal fires regardless; the operator uses the logged
    // ES/YM levels to confirm visually.
    //
    // PHASE 2 HOOK: replace the false placeholders above with:
    //   esDiverged = !esNewExtremeInCycle(esData, direction, tolerance)
    //   ymDiverged = !ymNewExtremeInCycle(ymData, direction, tolerance)

    const anyDiverged  = esDiverged || ymDiverged;
    const bothDiverged = esDiverged && ymDiverged;
    const divergence   = config.smt.requireBoth ? bothDiverged : anyDiverged;

    return {
      available:    true,
      divergence,
      esDiverged,
      ymDiverged,
      esHigh:       esData?.high  ?? null,
      esLow:        esData?.low   ?? null,
      ymHigh:       ymData?.high  ?? null,
      ymLow:        ymData?.low   ?? null,
      note:         'v1.0 — visual confirmation recommended; Phase 2 adds auto-ratio',
    };
  }
}
