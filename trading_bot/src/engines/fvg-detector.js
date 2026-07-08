// ============================================================
// FVG DETECTOR  —  Fair Value Gap detection and entry trigger
// ============================================================
// A Fair Value Gap (FVG) is an ICT concept: a 3-candle pattern
// where price moves so fast that it creates an "imbalance" —
// a gap between the bodies of candle[i-1] and candle[i+1] that
// candle[i] (the "impulse" candle) doesn't fill.
//
// Bullish FVG (Long setup — price swept LOW then reversed up):
//   candle[i-1].high < candle[i+1].low
//   Gap zone = [candle[i-1].high, candle[i+1].low]
//   Entry: price retraces DOWN into the gap (buyside re-entry)
//
// Bearish FVG (Short setup — price swept HIGH then sold off):
//   candle[i-1].low > candle[i+1].high
//   Gap zone = [candle[i+1].high, candle[i-1].low]
//   Entry: price retraces UP into the gap (sellside re-entry)
//
// In Frank's model:
//   • The FVG forms DURING the expansion move after the MSS candle
//   • Entry is ONLY valid while inside the killzone
//   • The FVG is the precision entry — not a limit order, but a
//     "price has returned here" trigger on the live bar close
//
// Phase 2 refinement: weight FVG by size (larger = more institutional)
// ============================================================

import { config } from '../../config.js';

// ── FVG detection ─────────────────────────────────────────────

// Scan forward from afterIndex in the candles array, looking for
// the first FVG that matches `direction`.
//
// Parameters:
//   candles     — full CandleBuffer.all() array (sorted ascending)
//   direction   — 'long' | 'short'
//   afterIndex  — start scanning from this index + 1 (the MSS candle index)
//
// Returns:
//   { found: true,  fvgLow, fvgHigh, middleCandleIndex, middleCandle }
//   { found: false }
export function findFVG(candles, direction, afterIndex) {
  const limit = Math.min(
    candles.length - 1,
    afterIndex + config.fvg.lookbackCandles + 1,
  );

  // We need candle[i-1], candle[i], candle[i+1].
  // Start at afterIndex (not +1) because the MSS candle itself is
  // typically the middle impulse candle of the FVG pattern.
  for (let i = afterIndex; i < limit; i++) {
    const prev = candles[i - 1];
    const next = candles[i + 1];
    if (!prev || !next) continue;

    if (direction === 'long') {
      // Bullish FVG: gap ABOVE candle[i-1].high and BELOW candle[i+1].low
      const gapLow  = prev.high;
      const gapHigh = next.low;
      if (gapHigh > gapLow && (gapHigh - gapLow) >= config.fvg.minGapPoints) {
        return {
          found:              true,
          fvgLow:             gapLow,
          fvgHigh:            gapHigh,
          gapSize:            gapHigh - gapLow,
          middleCandleIndex:  i,
          middleCandle:       candles[i],
          priorCandle:        prev,   // candle[i-1] — stop goes below its low
          direction,
        };
      }

    } else {
      // Bearish FVG: gap BELOW candle[i-1].low and ABOVE candle[i+1].high
      const gapLow  = next.high;
      const gapHigh = prev.low;
      if (gapHigh > gapLow && (gapHigh - gapLow) >= config.fvg.minGapPoints) {
        return {
          found:              true,
          fvgLow:             gapLow,
          fvgHigh:            gapHigh,
          gapSize:            gapHigh - gapLow,
          middleCandleIndex:  i,
          middleCandle:       candles[i],
          priorCandle:        prev,   // candle[i-1] — stop goes above its high
          direction,
        };
      }
    }
  }

  return { found: false };
}

// Has price retraced into the UPPER HALF of the FVG? (close-based, legacy)
// For both directions the upper half is [midpoint, fvgHigh].
export function isPriceInFVG(currentPrice, fvg) {
  if (!fvg || !fvg.found) return false;
  const midpoint = (fvg.fvgLow + fvg.fvgHigh) / 2;
  return currentPrice >= midpoint && currentPrice <= fvg.fvgHigh;
}

// Intrabar FVG top touch — simulates a limit order at the FVG boundary.
//
// For LONG setups: entry limit at fvgHigh (top of the bullish gap).
//   The bar's LOW reaching fvgHigh means the order was filled intrabar
//   even if the bar closed above the FVG.
//   This captures Trade 2 (Apr 13 11:07): "price never truly tapped into
//   the FVG" — a bar wick touched fvgHigh and closed back up, so the
//   close-based check missed it entirely.
//
// For SHORT setups: entry limit at fvgLow (bottom of the bearish gap).
//   The bar's HIGH reaching fvgLow means the short limit was filled.
export function isBarTouchingFVGTop(bar, fvg) {
  if (!bar || !fvg?.found) return false;
  if (fvg.direction === 'long')  return bar.low  <= fvg.fvgHigh;
  if (fvg.direction === 'short') return bar.high >= fvg.fvgLow;
  return false;
}

// ── MSS detection via CISD ────────────────────────────────────

// After a sweep, confirm reversal via CISD (Change in State of Delivery):
// a candle that closes beyond the OPEN of the last opposing delivery candle.
//
// For LONG (low sweep): find last bearish candle near the sweep, then
// find the first candle that closes ABOVE its open.
//
// For SHORT (high sweep): find last bullish candle near the sweep, then
// find the first candle that closes BELOW its open.
//
// Falls back to body-ratio rule if no delivery candle is found.
//
// Returns:
//   { found: true,  index, candle, mssType: 'CISD'|'body', deliveryOpen? }
//   { found: false }
export function findMSS(candles, direction, afterIndex) {
  const deliveryLookback = config.mss.deliveryLookback;
  const cisdLookforward  = config.mss.cisdLookforward;

  // ── V-shape fast path ─────────────────────────────────────────
  // If the sweep candle itself closes in the reversal direction
  // (bullish body for a long, bearish body for a short), the state
  // of delivery changed within a single bar.  This is the V-shaped
  // recovery pattern — no further CISD candle is required.
  //
  // Trade 3 (Apr 14 10:06): sweep candle wicked down to the Breaker,
  // closed back bullish in one bar.  The classic 20-bar CISD lookback
  // fails here because the delivery open was far above the current move.
  const sweepBar = candles[afterIndex];
  if (sweepBar) {
    if (direction === 'long'  && sweepBar.close > sweepBar.open) {
      return { found: true, index: afterIndex, candle: sweepBar, mssType: 'vshape' };
    }
    if (direction === 'short' && sweepBar.close < sweepBar.open) {
      return { found: true, index: afterIndex, candle: sweepBar, mssType: 'vshape' };
    }
  }

  // ── Step 1: find the last opposing delivery candle ────────────
  // Search backwards from the sweep candle (inclusive) up to deliveryLookback.
  let deliveryOpen = null;
  const lookbackStart = Math.max(0, afterIndex - deliveryLookback);

  for (let i = afterIndex; i >= lookbackStart; i--) {
    const c = candles[i];
    if (direction === 'long'  && c.close < c.open) { deliveryOpen = c.open; break; }
    if (direction === 'short' && c.close > c.open) { deliveryOpen = c.open; break; }
  }

  // ── Step 2a: CISD confirmation ────────────────────────────────
  if (deliveryOpen !== null) {
    const limit = Math.min(candles.length - 1, afterIndex + cisdLookforward);
    for (let i = afterIndex + 1; i <= limit; i++) {
      const c = candles[i];
      if (direction === 'long'  && c.close > deliveryOpen) {
        return { found: true, index: i, candle: c, mssType: 'CISD', deliveryOpen };
      }
      if (direction === 'short' && c.close < deliveryOpen) {
        return { found: true, index: i, candle: c, mssType: 'CISD', deliveryOpen };
      }
    }
    return { found: false };
  }

  // ── Step 2b: fallback — body-ratio rule ───────────────────────
  for (let i = afterIndex + 1; i < candles.length; i++) {
    const c     = candles[i];
    const range = c.high - c.low;
    if (range === 0) continue;
    if (Math.abs(c.close - c.open) / range < config.mss.minBodyPct) continue;
    if (direction === 'long'  && c.close > c.open) return { found: true, index: i, candle: c, mssType: 'body' };
    if (direction === 'short' && c.close < c.open) return { found: true, index: i, candle: c, mssType: 'body' };
  }

  return { found: false };
}

// ── Sweep detection ───────────────────────────────────────────

// Scan for a liquidity sweep of prevHigh or prevLow inside the
// current cycle (bars at or after cycleStartMs).
//
// Two-phase logic:
//   1. Pierce: any candle whose wick (high/low) breaks the level
//      by at least thresholdPoints.
//   2. Rejection: that same candle OR one of the next
//      `rejectionWindow` candles must close back through the level.
//      If no close-back within the window → breakout, skip.
//
// `sweepCandle` is the candle with the MOST EXTREME wick in the
// [pierce .. rejection] window — stop is placed beyond that extreme.
//
// Returns:
//   { found: true,  direction, sweepLevel, sweepType,
//     sweepCandle, sweepCandleIndex, sweepStyle: 'wick'|'body' }
//   { found: false }
export function detectSweep(candles, cycleStartMs, prevHigh, prevLow) {
  if (prevHigh == null || prevLow == null) return { found: false };

  const threshold = config.sweep.thresholdPoints;
  const window    = config.sweep.rejectionWindow;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (c.time < cycleStartMs) continue;

    // ── HIGH SWEEP ───────────────────────────────────────────
    if (c.high > prevHigh + threshold) {
      // Same-candle rejection (wick pokes above, closes below)
      if (c.close < prevHigh) {
        return buildSweep('short', prevHigh, candles, i, i, 'wick');
      }
      // Body broke above — look for close-back within rejection window
      const end = Math.min(i + window, candles.length - 1);
      for (let j = i + 1; j <= end; j++) {
        if (candles[j].close < prevHigh) {
          return buildSweep('short', prevHigh, candles, i, j, 'body');
        }
      }
      // No close-back → breakout, do not fire a trade signal
    }

    // ── LOW SWEEP ────────────────────────────────────────────
    if (c.low < prevLow - threshold) {
      if (c.close > prevLow) {
        return buildSweep('long', prevLow, candles, i, i, 'wick');
      }
      const end = Math.min(i + window, candles.length - 1);
      for (let j = i + 1; j <= end; j++) {
        if (candles[j].close > prevLow) {
          return buildSweep('long', prevLow, candles, i, j, 'body');
        }
      }
    }
  }

  return { found: false };
}

// Pick the most extreme candle in [fromIdx..toIdx] for stop placement.
function extremeCandle(candles, fromIdx, toIdx, direction) {
  let best = candles[fromIdx];
  for (let k = fromIdx + 1; k <= toIdx; k++) {
    if (!candles[k]) break;
    if (direction === 'short' && candles[k].high > best.high) best = candles[k];
    if (direction === 'long'  && candles[k].low  < best.low)  best = candles[k];
  }
  return best;
}

function buildSweep(direction, level, candles, pierceIdx, rejectIdx, style) {
  const sweepType = direction === 'short' ? 'HIGH_SWEEP' : 'LOW_SWEEP';
  return {
    found:            true,
    direction,
    sweepLevel:       level,
    sweepType,
    sweepStyle:       style,
    sweepCandle:      extremeCandle(candles, pierceIdx, rejectIdx, direction),
    sweepCandleIndex: pierceIdx,
  };
}
