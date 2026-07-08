// ============================================================
// SIGNAL ENGINE  —  Full detection pipeline orchestrator
// ============================================================
// This engine takes the current candle buffer, cycle info,
// killzone status, and SMT data and runs them through every
// condition layer of Frank's model in order:
//
//   1. Killzone gate       — are we in NY AM or NY PM?
//   2. Risk gate           — daily loss / max-trades check
//   3. Cycle info          — prev-cycle H/L reference levels
//   4. Sweep detection     — did price take the prev-cycle H or L?
//   5. MSS confirmation    — strong momentum candle after sweep
//   6. FVG detection       — 3-candle imbalance in expansion move
//   7. Entry trigger       — current price has retraced into FVG
//   8. SMT confluence      — intermarket divergence check
//   9. Signal generation   — compute entry / stop / targets / RR
//  10. De-duplication      — don't re-fire the same setup twice
//
// v1.0 outputs signals to the CONSOLE ONLY.
// No orders are placed. No broker connection exists yet.
//
// ── PHASE 3 HOOK ── (Tradovate execution)
//   See the clearly-marked comment block below at the bottom of
//   the evaluate() method. Plug in the order router there.
//
// ── PHASE 2 HOOK ── (Claude AI HTF context scoring)
//   See the htfContextScore() stub at the bottom of this file.
//   Replace it with an AI-scored bias (bullish / bearish / neutral)
//   derived from HTF (daily / weekly) structure analysis.
// ============================================================

import { config }       from '../../config.js';
import { logger }       from '../logger.js';
import {
  getCycleInfo,
  getPrevCycleHighLow,
  cycleStartLabel,
}                       from './cycle-engine.js';
import { getKillzoneStatus } from './killzone.js';
import {
  detectSweep,
  findMSS,
  findFVG,
  isPriceInFVG,
}                       from './fvg-detector.js';

export class SignalEngine {
  constructor() {
    // Tracks signals fired this session day to prevent double-firing.
    // Key format: "YYYY-MM-DD_cycleIndex_direction"
    this.firedSignals = new Set();

    // Rolling P&L tracker (paper, in NQ points) for the daily kill-switch
    this.sessionPnL = 0;

    // Count of signals fired today
    this.tradesThisSession = 0;

    // The ET date string when the session counters were last reset
    this.sessionDate = '';
  }

  // ── Session management ────────────────────────────────────

  // Reset daily counters when a new ET date begins
  _checkSessionReset(et) {
    const dateStr = `${et.year}-${String(et.month).padStart(2,'0')}-${String(et.day).padStart(2,'0')}`;
    if (dateStr !== this.sessionDate) {
      this.firedSignals.clear();
      this.sessionPnL         = 0;
      this.tradesThisSession  = 0;
      this.sessionDate        = dateStr;
      logger.info(`New session: ${dateStr} — counters reset`);
    }
  }

  // Call this when a paper trade closes to update session P&L
  // pnlPoints: positive = profit, negative = loss (NQ points)
  recordTradePnL(pnlPoints) {
    this.sessionPnL += pnlPoints;
    logger.info(`Session P&L updated: ${this.sessionPnL.toFixed(2)} pts (limit: ${config.risk.dailyLossLimitPoints})`);
  }

  // ── Risk gate ─────────────────────────────────────────────

  _riskGateOpen() {
    if (this.sessionPnL <= config.risk.dailyLossLimitPoints) {
      logger.kill(`Daily loss limit reached (${this.sessionPnL.toFixed(2)} pts). No more signals today.`);
      return false;
    }
    if (this.tradesThisSession >= config.risk.maxTradesPerSession) {
      logger.kill(`Max trades per session reached (${this.tradesThisSession}/${config.risk.maxTradesPerSession})`);
      return false;
    }
    return true;
  }

  // ── Signal de-duplication ─────────────────────────────────

  _signalKey(sessionDate, cycleIndex, direction) {
    return `${sessionDate}_${cycleIndex}_${direction}`;
  }

  _alreadyFired(sessionDate, cycleIndex, direction) {
    return this.firedSignals.has(this._signalKey(sessionDate, cycleIndex, direction));
  }

  _markFired(sessionDate, cycleIndex, direction) {
    this.firedSignals.add(this._signalKey(sessionDate, cycleIndex, direction));
    this.tradesThisSession++;
  }

  // ── Main evaluation pipeline ──────────────────────────────

  // Parameters:
  //   candleBuffer  — CandleBuffer instance (NQ)
  //   smtResult     — result from SmtDetector.checkDivergence()
  //   nowMs         — current UTC ms (defaults to Date.now())
  //
  // Returns:
  //   null               — no signal
  //   { signal: object } — signal ready to log / execute
  evaluate(candleBuffer, smtResult, nowMs = Date.now()) {
    // ── PHASE 2 HOOK — HTF Context Scoring ──────────────────
    // Replace htfContextScore() with a call to the Claude AI layer
    // that scores the Higher Time Frame (daily / weekly) structure.
    // The score can be used to:
    //   • Only take long setups on bullish HTF days
    //   • Skip counter-trend trades below a confidence threshold
    //   • Increase target multiplier when HTF strongly aligns
    // Signature: async htfContextScore(symbol) → { bias: 'bullish'|'bearish'|'neutral', score: 0-100 }
    const htfScore = htfContextScore(); // stub — returns { bias: 'neutral', score: 50 }
    // END PHASE 2 HOOK ──────────────────────────────────────

    // ── Step 1: Killzone gate ─────────────────────────────────
    const kzStatus = getKillzoneStatus(nowMs);
    if (!kzStatus.active) {
      logger.debug(`Not in killzone. Next opens in ~${kzStatus.minutesUntilNext ?? '?'} min`);
      return null;
    }

    // ── Step 2: Risk gate ─────────────────────────────────────
    const cycleInfo = getCycleInfo(nowMs);
    this._checkSessionReset(cycleInfo.et);
    if (!this._riskGateOpen()) return null;

    // ── Step 3: Cycle levels ──────────────────────────────────
    const prevHL = getPrevCycleHighLow(candleBuffer, cycleInfo);
    if (!prevHL) {
      logger.debug(`No prev-cycle data for cycle #${cycleInfo.cycleIndex} — not enough history yet`);
      return null;
    }

    const candles = candleBuffer.all();
    if (candles.length < 5) return null;

    // ── Step 4: Sweep detection ───────────────────────────────
    const sweep = detectSweep(candles, cycleInfo.cycleStartMs, prevHL.high, prevHL.low);
    if (!sweep.found) {
      logger.debug(`Cycle #${cycleInfo.cycleIndex}: no sweep detected yet (prevH:${prevHL.high.toFixed(2)} prevL:${prevHL.low.toFixed(2)})`);
      return null;
    }

    // ── Step 5: MSS confirmation ──────────────────────────────
    const mss = findMSS(candles, sweep.direction, sweep.sweepCandleIndex);
    if (!mss.found) {
      logger.debug(`Sweep found (${sweep.sweepType}) but no MSS candle yet`);
      return null;
    }

    // ── Step 6: FVG detection ─────────────────────────────────
    const fvg = findFVG(candles, sweep.direction, mss.index);
    if (!fvg.found) {
      logger.debug(`MSS confirmed but no FVG formed yet (looking forward from bar ${mss.index})`);
      return null;
    }

    // ── Step 7: Entry trigger — is current price in FVG? ──────
    const lastBar     = candleBuffer.lastClosed();
    const liveBar     = candleBuffer.current();
    const checkPrice  = liveBar?.close ?? lastBar?.close;
    if (checkPrice == null) return null;

    if (!isPriceInFVG(checkPrice, fvg)) {
      logger.debug(`FVG found [${fvg.fvgLow.toFixed(2)}–${fvg.fvgHigh.toFixed(2)}] but price ${checkPrice.toFixed(2)} not yet inside`);
      return null;
    }

    // ── Step 8: De-duplication ────────────────────────────────
    const et        = cycleInfo.et;
    const dateStr   = `${et.year}-${String(et.month).padStart(2,'0')}-${String(et.day).padStart(2,'0')}`;
    if (this._alreadyFired(dateStr, cycleInfo.cycleIndex, sweep.direction)) {
      logger.debug(`Signal already fired for ${dateStr} cycle#${cycleInfo.cycleIndex} ${sweep.direction} — skipping`);
      return null;
    }

    // ── Step 9: Compute entry / stop / targets ─────────────────
    // Entry: FVG midpoint (optimal entry inside the imbalance zone)
    const entry    = (fvg.fvgLow + fvg.fvgHigh) / 2;

    let stop, target1, target2;
    if (sweep.direction === 'long') {
      // Stop below the sweep candle's low with buffer
      stop    = sweep.sweepCandle.low - config.risk.stopBufferPoints;
      target1 = entry + Math.abs(entry - stop) * config.risk.target1RR;
      target2 = entry + Math.abs(entry - stop) * config.risk.target2RR;
    } else {
      // Stop above sweep candle's high with buffer
      stop    = sweep.sweepCandle.high + config.risk.stopBufferPoints;
      target1 = entry - Math.abs(entry - stop) * config.risk.target1RR;
      target2 = entry - Math.abs(entry - stop) * config.risk.target2RR;
    }

    const riskPts = Math.abs(entry - stop);
    const rr      = riskPts > 0 ? Math.abs(entry - target1) / riskPts : 0;

    // Discard if R:R is too low (stop too wide relative to available target)
    if (rr < config.risk.minRR) {
      logger.warn(`Signal rejected: R:R ${rr.toFixed(2)} < minimum ${config.risk.minRR}`);
      return null;
    }

    // ── Step 10: SMT confluence block ─────────────────────────
    const smtSummary = buildSmtSummary(smtResult, sweep.direction);

    // ── Build the signal object ────────────────────────────────
    const signal = {
      id:        `${dateStr}_C${cycleInfo.cycleIndex}_${sweep.direction}`,
      timestamp: nowMs,
      direction: sweep.direction,
      entry,
      stop,
      target1,
      target2,
      rr,
      riskPoints: riskPts,
      confluence: {
        killzone:      kzStatus.name,
        cycleIndex:    cycleInfo.cycleIndex,
        cycleStart:    cycleStartLabel(cycleInfo.cycleIndex),
        prevCycleHigh: prevHL.high,
        prevCycleLow:  prevHL.low,
        sweepType:     sweep.sweepType,
        sweepLevel:    sweep.sweepLevel,
        sweepCandle:   sweep.sweepCandle,
        mssCandle:     mss.candle,
        fvg:           { low: fvg.fvgLow, high: fvg.fvgHigh, size: fvg.gapSize },
        smt:           smtSummary,
        htfBias:       htfScore.bias,
        htfScore:      htfScore.score,
      },
    };

    // Mark this setup as fired before logging to prevent race conditions
    this._markFired(dateStr, cycleInfo.cycleIndex, sweep.direction);

    // ── PHASE 3 HOOK — Tradovate Order Execution ─────────────
    // When Phase 3 (live execution) is built, replace the logger.signal()
    // call below with a call to the Tradovate order router:
    //
    //   await tradovateRouter.placeOrder({
    //     symbol:    'NQM25',          // current front-month contract
    //     side:      signal.direction === 'long' ? 'Buy' : 'Sell',
    //     qty:       1,
    //     orderType: 'Limit',
    //     price:     signal.entry,
    //     stopLoss:  signal.stop,
    //     takeProfit: signal.target1,
    //   });
    //
    // The signal object above already has everything the router needs.
    // Wire this up in src/execution/tradovate-router.js (Phase 3).
    // END PHASE 3 HOOK ─────────────────────────────────────────

    // Log signal to console (v1.0 output mode)
    logger.signal(
      signal.direction,
      signal.entry,
      signal.stop,
      signal.target1,
      signal.target2,
      signal.rr,
      signal.confluence,
    );

    return signal;
  }
}

// ── SMT summary formatter ─────────────────────────────────────

function buildSmtSummary(smtResult, direction) {
  if (!smtResult || !smtResult.available) {
    return { active: null, available: false };
  }
  return {
    available:    true,
    active:       smtResult.divergence,
    esDiverged:   smtResult.esDiverged,
    ymDiverged:   smtResult.ymDiverged,
    esHigh:       smtResult.esHigh,
    esLow:        smtResult.esLow,
    ymHigh:       smtResult.ymHigh,
    ymLow:        smtResult.ymLow,
  };
}

// ── PHASE 2 HOOK — HTF Context Score stub ─────────────────────
// In Phase 2, replace this with an async function that calls the
// Claude AI API to score the Higher Time Frame (daily/weekly) bias
// for NQ. The AI layer reads HTF structure from TradingView and
// returns a directional conviction score.
//
// The function should return:
//   { bias: 'bullish' | 'bearish' | 'neutral', score: 0-100 }
//
// Integration point in evaluate():
//   const htfScore = await htfContextScore('NQ1!');
//   if (htfScore.bias !== 'neutral' && htfScore.score < 60) return null;
//
// END PHASE 2 HOOK ────────────────────────────────────────────

function htfContextScore() {
  // Stub: always neutral until Phase 2 AI layer is connected
  return { bias: 'neutral', score: 50 };
}
