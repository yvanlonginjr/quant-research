// ============================================================
// HTF ZONE MANAGER  —  Active 1H PD array zone detector
// ============================================================
// Answers the first question in the top-down model:
//   "Is price currently AT a 1H institutional zone?"
//
// This is the PRIMARY PRECONDITION gate.  Nothing downstream
// (sweep, MSS, FVG) is evaluated unless price is at a zone.
//
// Active zone types (in priority order):
//   Breaker Block — mitigated OB price has returned to (strongest)
//   Order Block   — last opposing candle before an impulse (strong)
//   Fair Value Gap — unfilled imbalance on the 1H chart (moderate)
//
// Zone direction:
//   'bullish' → acts as support → only long setups evaluated
//   'bearish' → acts as resistance → only short setups evaluated
//
// Spatial FVG requirement (fvgOverlapsZone):
//   After finding the 1m FVG, confirm it physically overlaps with
//   the 1H zone.  Without this check the bot accepts FVGs anywhere,
//   which is the core flaw in the v1 bottom-up architecture.
//   The tolerance allows FVGs that sit just ABOVE a Breaker Block
//   top (Trade 3: "almost taps Breaker, does enough for FVG").
// ============================================================

import { detectHTFFVGs } from './htf-engine.js';
import { config }        from '../../config.js';

// ── Public API ────────────────────────────────────────────────

// Returns all active 1H PD array zones that price is currently at
// (inside or within proximityPts of the boundary), sorted by
// distance to currentPrice (closest first).
//
// nq1HBars   — 1H OHLCV array, no look-ahead (caller filters)
// currentPrice — latest 1m bar close
//
// Each returned zone:
//   { type: 'breaker'|'ob'|'fvg', direction: 'bullish'|'bearish',
//     low, high, time, label }
export function getActiveHTFZones(nq1HBars, currentPrice) {
  if (!nq1HBars || nq1HBars.length < 5) return [];

  const zones = [];

  // ── Bullish zones (long setups) ───────────────────────────────
  const bullBB = findBreakerBlock(nq1HBars, 'bullish', currentPrice);
  if (bullBB) zones.push({ type: 'breaker', direction: 'bullish', ...bullBB });

  const bullOB = findOrderBlock(nq1HBars, 'bullish', currentPrice);
  if (bullOB) zones.push({ type: 'ob', direction: 'bullish', ...bullOB });

  const fvgs = detectHTFFVGs(nq1HBars, currentPrice, config.htfZone.proximityPts + 100);
  for (const fvg of fvgs) {
    if (fvg.direction === 'bullish' && nearZone(currentPrice, fvg.fvgLow, fvg.fvgHigh)) {
      zones.push({
        type:      'fvg',
        direction: 'bullish',
        low:       fvg.fvgLow,
        high:      fvg.fvgHigh,
        time:      fvg.time,
        label:     `1H Bull FVG ${fvg.fvgLow.toFixed(0)}–${fvg.fvgHigh.toFixed(0)}`,
      });
    }
  }

  // ── Bearish zones (short setups) ──────────────────────────────
  const bearBB = findBreakerBlock(nq1HBars, 'bearish', currentPrice);
  if (bearBB) zones.push({ type: 'breaker', direction: 'bearish', ...bearBB });

  const bearOB = findOrderBlock(nq1HBars, 'bearish', currentPrice);
  if (bearOB) zones.push({ type: 'ob', direction: 'bearish', ...bearOB });

  for (const fvg of fvgs) {
    if (fvg.direction === 'bearish' && nearZone(currentPrice, fvg.fvgLow, fvg.fvgHigh)) {
      zones.push({
        type:      'fvg',
        direction: 'bearish',
        low:       fvg.fvgLow,
        high:      fvg.fvgHigh,
        time:      fvg.time,
        label:     `1H Bear FVG ${fvg.fvgLow.toFixed(0)}–${fvg.fvgHigh.toFixed(0)}`,
      });
    }
  }

  // Sort by proximity (closest zone boundary to current price first)
  return zones.sort((a, b) => {
    const da = Math.min(Math.abs(currentPrice - a.low), Math.abs(currentPrice - a.high));
    const db = Math.min(Math.abs(currentPrice - b.low), Math.abs(currentPrice - b.high));
    return da - db;
  });
}

// Does the 1m FVG physically overlap with (or sit just above/below) a 1H zone?
//
// The tolerance handles Trade 3: "price almost taps into the Breaker but
// does enough for the FVG" — the FVG can form just outside the zone edge
// and still count as zone-anchored.
export function fvgOverlapsZone(fvg, zone) {
  const tol = config.htfZone.fvgOverlapTolerancePts;
  return fvg.fvgLow <= zone.high + tol && fvg.fvgHigh >= zone.low - tol;
}

// ── Zone scanner helpers ──────────────────────────────────────
//
// These replicate the logic from htf-engine.js but with proximity-aware
// zone membership (price can be near the zone, not just inside it).
// This is intentionally separate — htf-engine.js is used for the
// legacy scoring path; these functions are the precondition gate.

function nearZone(price, low, high) {
  const prox = config.htfZone.proximityPts;
  return price >= low - prox && price <= high + prox;
}

// Breaker Block: a previously mitigated OB that price has returned to.
// Bullish BB: bearish OB → price broke below it → now returned (support).
// Bearish BB: bullish OB → price broke above it → now returned (resistance).
function findBreakerBlock(bars, direction, currentPrice) {
  for (let i = bars.length - 4; i >= 1; i--) {
    const b  = bars[i];
    const n1 = bars[i + 1];
    const n2 = bars[i + 2] ?? null;

    if (direction === 'bullish') {
      if (b.close >= b.open) continue;  // need bearish candle as OB base
      const impulse   = n1.close > b.high || (n2 && n2.close > b.high);
      if (!impulse) continue;
      // Must have been mitigated (price later closed below OB low)
      const subsequent = bars.slice(i + 1);
      if (!subsequent.some(sb => sb.close < b.low)) continue;
      if (!nearZone(currentPrice, b.low, b.high)) continue;
      return {
        low:   b.low,
        high:  b.high,
        time:  b.time,
        label: `1H Bull Breaker ${b.low.toFixed(0)}–${b.high.toFixed(0)}`,
      };
    } else {
      if (b.close <= b.open) continue;  // need bullish candle as OB base
      const impulse   = n1.close < b.low || (n2 && n2.close < b.low);
      if (!impulse) continue;
      const subsequent = bars.slice(i + 1);
      if (!subsequent.some(sb => sb.close > b.high)) continue;
      if (!nearZone(currentPrice, b.low, b.high)) continue;
      return {
        low:   b.low,
        high:  b.high,
        time:  b.time,
        label: `1H Bear Breaker ${b.low.toFixed(0)}–${b.high.toFixed(0)}`,
      };
    }
  }
  return null;
}

// Order Block: last opposing candle before a strong impulse.
// Bullish OB: last bearish candle before a bullish impulse (unmitigated).
// Bearish OB: last bullish candle before a bearish impulse (unmitigated).
function findOrderBlock(bars, direction, currentPrice) {
  for (let i = bars.length - 3; i >= 1; i--) {
    const b  = bars[i];
    const n1 = bars[i + 1];
    const n2 = bars[i + 2] ?? null;

    if (direction === 'bullish') {
      if (b.close >= b.open) continue;  // need bearish candle
      const impulse   = n1.close > b.high || (n2 && n2.close > b.high);
      if (!impulse) continue;
      // Must NOT have been mitigated — price never closed below OB low
      const subsequent = bars.slice(i + 1);
      if (subsequent.some(sb => sb.close < b.low)) continue;
      if (!nearZone(currentPrice, b.low, b.high)) continue;
      return {
        low:   b.low,
        high:  b.high,
        time:  b.time,
        label: `1H Bull OB ${b.low.toFixed(0)}–${b.high.toFixed(0)}`,
      };
    } else {
      if (b.close <= b.open) continue;
      const impulse   = n1.close < b.low || (n2 && n2.close < b.low);
      if (!impulse) continue;
      const subsequent = bars.slice(i + 1);
      if (subsequent.some(sb => sb.close > b.high)) continue;
      if (!nearZone(currentPrice, b.low, b.high)) continue;
      return {
        low:   b.low,
        high:  b.high,
        time:  b.time,
        label: `1H Bear OB ${b.low.toFixed(0)}–${b.high.toFixed(0)}`,
      };
    }
  }
  return null;
}
