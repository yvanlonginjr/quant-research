// ============================================================
// HTF ENGINE  —  Higher Timeframe Bias (DOL + PD Arrays + Sweeps)
// ============================================================
// Computes HTF directional bias by analyzing:
//   1. Draw on Liquidity (DOL) — nearest unmitigated reference level
//   2. Recent 1H liquidity sweeps (swept high vs swept low)
//   3. 1H Fair Value Gaps and Order Blocks (unmitigated PD arrays)
//   4. 1H SMT divergence (NQ vs ES/YM)
//
// Scoring:
//   >= +2 → bullish (hard-filter: longs only in 'hard' mode)
//   <= -2 → bearish (hard-filter: shorts only in 'hard' mode)
//   else  → neutral (both directions OK)
// ============================================================

import { flatLevels } from './levels-engine.js';
import { config }     from '../../config.js';

// ── Bar aggregation ───────────────────────────────────────────

// Aggregate 1-min bars into N-min OHLCV bars.
// Buckets are aligned to UTC epoch (every N minutes from 00:00 UTC).
export function aggregateBars(bars, periodMins) {
  const periodMs = periodMins * 60000;
  const grouped  = new Map();

  for (const b of bars) {
    const bucket = Math.floor(b.time / periodMs) * periodMs;
    const g      = grouped.get(bucket);
    if (!g) {
      grouped.set(bucket, {
        time:   bucket,
        open:   b.open,
        high:   b.high,
        low:    b.low,
        close:  b.close,
        volume: b.volume ?? 0,
      });
    } else {
      if (b.high > g.high) g.high = b.high;
      if (b.low  < g.low)  g.low  = b.low;
      g.close   = b.close;
      g.volume += b.volume ?? 0;
    }
  }

  return Array.from(grouped.values()).sort((a, b) => a.time - b.time);
}

// ── DOL — Draw on Liquidity ───────────────────────────────────

// Returns the nearest unmitigated reference level above or below
// current price.  Uses only MAJOR stable levels (PDH/PDL, weekly,
// monthly, quarterly, yearly) — NOT intraday session H/L which are
// too close to price and create noise.
//
// Shape: { price, type, direction: 'above'|'below' }
export function getDOL(currentPrice, keyLevels) {
  if (!keyLevels) return null;
  const levels = flatLevels(keyLevels);

  // 2-pt deadband: levels within 2 pts of price are "at" rather than above/below
  let nearestAbove = null, nearestBelow = null;
  for (const lv of levels) {
    if (lv.price > currentPrice + 2) {
      if (!nearestAbove || lv.price < nearestAbove.price) nearestAbove = lv;
    } else if (lv.price < currentPrice - 2) {
      if (!nearestBelow || lv.price > nearestBelow.price) nearestBelow = lv;
    }
  }

  if (!nearestAbove && !nearestBelow) return null;
  if (!nearestAbove) return { ...nearestBelow, direction: 'below' };
  if (!nearestBelow) return { ...nearestAbove, direction: 'above' };

  const distAbove = nearestAbove.price - currentPrice;
  const distBelow = currentPrice - nearestBelow.price;
  return distAbove <= distBelow
    ? { ...nearestAbove, direction: 'above' }
    : { ...nearestBelow, direction: 'below' };
}

// ── 1H Liquidity Sweep detection ─────────────────────────────

// Returns the most recent sweep of a key reference level in the
// last sweepLookback 1H bars.  A sweep = wick through the level,
// close back on the origin side (rejection, not breakout).
//
// Shape: { direction: 'high_swept'|'low_swept', level: { price, type }, sweepBar }
export function detectHTFSweep(bars1H, keyLevels, sweepLookback = 6) {
  if (!keyLevels || bars1H.length < 3) return null;
  const levels = flatLevels(keyLevels);
  const recent = bars1H.slice(-sweepLookback);

  for (let i = 1; i < recent.length; i++) {
    const bar  = recent[i];
    const prev = recent[i - 1];
    for (const lv of levels) {
      // Sweep of a HIGH: wick above the level, closed back below
      if (prev.high < lv.price && bar.high >= lv.price && bar.close < lv.price) {
        return { direction: 'high_swept', level: lv, sweepBar: bar };
      }
      // Sweep of a LOW: wick below the level, closed back above
      if (prev.low > lv.price && bar.low <= lv.price && bar.close > lv.price) {
        return { direction: 'low_swept', level: lv, sweepBar: bar };
      }
    }
  }
  return null;
}

// ── 1H Fair Value Gaps ────────────────────────────────────────

// Returns all unmitigated 1H FVGs within proxyPts of current price,
// sorted nearest-first.
// Each entry: { direction: 'bullish'|'bearish', fvgLow, fvgHigh, gapSize, time }
export function detectHTFFVGs(bars1H, currentPrice, proxyPts = 300) {
  const fvgs = [];
  if (bars1H.length < 3) return fvgs;

  for (let i = 1; i < bars1H.length - 1; i++) {
    const b0 = bars1H[i - 1];
    const b1 = bars1H[i];
    const b2 = bars1H[i + 1];

    // Bullish FVG: gap between b0.high and b2.low (b2.low > b0.high)
    if (b0.high < b2.low) {
      const fvgLow  = b0.high;
      const fvgHigh = b2.low;
      const gapSize = fvgHigh - fvgLow;
      if (gapSize < 2) continue;
      const mitigated = bars1H.slice(i + 2).some(b => b.low <= fvgHigh);
      if (!mitigated && Math.abs(currentPrice - (fvgLow + fvgHigh) / 2) < proxyPts) {
        fvgs.push({ direction: 'bullish', fvgLow, fvgHigh, gapSize, time: b1.time });
      }
    }

    // Bearish FVG: gap between b2.high and b0.low (b0.low > b2.high)
    if (b0.low > b2.high) {
      const fvgLow  = b2.high;
      const fvgHigh = b0.low;
      const gapSize = fvgHigh - fvgLow;
      if (gapSize < 2) continue;
      const mitigated = bars1H.slice(i + 2).some(b => b.high >= fvgLow);
      if (!mitigated && Math.abs(currentPrice - (fvgLow + fvgHigh) / 2) < proxyPts) {
        fvgs.push({ direction: 'bearish', fvgLow, fvgHigh, gapSize, time: b1.time });
      }
    }
  }

  return fvgs.sort((a, b) =>
    Math.abs(currentPrice - (a.fvgLow + a.fvgHigh) / 2) -
    Math.abs(currentPrice - (b.fvgLow + b.fvgHigh) / 2)
  );
}

// ── 1H Order Block detection ──────────────────────────────────

// Returns the most recent unmitigated 1H Order Block in the given direction.
//   Bullish OB = last bearish 1H candle before a bullish impulse
//   Bearish OB = last bullish 1H candle before a bearish impulse
//
// Mitigation check (conservative):
//   Bullish OB is mitigated when a subsequent close drops below the OB low.
//   Bearish OB is mitigated when a subsequent close rises above the OB high.
//
// Shape: { direction, obLow, obHigh, time }
export function detectHTFOB(bars1H, direction) {
  if (bars1H.length < 4) return null;

  for (let i = bars1H.length - 3; i >= 1; i--) {
    const b     = bars1H[i];
    const next1 = bars1H[i + 1];
    const next2 = bars1H[i + 2] ?? null;

    if (direction === 'bullish') {
      if (b.close >= b.open) continue;  // must be a bearish candle
      const impulse = next1.close > b.high || (next2 && next2.close > b.high);
      if (!impulse) continue;
      const mitigated = bars1H.slice(i + 1).some(sb => sb.close < b.low);
      if (!mitigated) return { direction, obLow: b.low, obHigh: b.high, time: b.time };

    } else {
      if (b.close <= b.open) continue;  // must be a bullish candle
      const impulse = next1.close < b.low || (next2 && next2.close < b.low);
      if (!impulse) continue;
      const mitigated = bars1H.slice(i + 1).some(sb => sb.close > b.high);
      if (!mitigated) return { direction, obLow: b.low, obHigh: b.high, time: b.time };
    }
  }
  return null;
}

// ── 1H Breaker Block detection ────────────────────────────────

// A Breaker Block (BB) is a mitigated Order Block that price has
// returned to, now acting from the opposite side:
//   Bullish BB: bearish OB → price broke below it → returns to zone (support)
//   Bearish BB: bullish OB → price broke above it → returns to zone (resistance)
//
// Shape: { direction, obLow, obHigh, time, type: 'breaker' }
export function detectHTFBreaker(bars1H, direction, currentPrice) {
  if (bars1H.length < 5) return null;

  for (let i = bars1H.length - 4; i >= 1; i--) {
    const b     = bars1H[i];
    const next1 = bars1H[i + 1];
    const next2 = bars1H[i + 2] ?? null;

    if (direction === 'bullish') {
      if (b.close >= b.open) continue;   // need bearish OB candle
      const impulse    = next1.close > b.high || (next2 && next2.close > b.high);
      if (!impulse) continue;
      // OB was mitigated — price later closed below the OB low
      const subsequent = bars1H.slice(i + 1);
      const mitigated  = subsequent.some(sb => sb.close < b.low);
      if (!mitigated) continue;   // still a fresh OB, not a BB
      // Price is now back inside the OB zone (BB in play)
      if (currentPrice >= b.low && currentPrice <= b.high) {
        return { direction, obLow: b.low, obHigh: b.high, time: b.time, type: 'breaker' };
      }

    } else {
      if (b.close <= b.open) continue;   // need bullish OB candle
      const impulse    = next1.close < b.low || (next2 && next2.close < b.low);
      if (!impulse) continue;
      const subsequent = bars1H.slice(i + 1);
      const mitigated  = subsequent.some(sb => sb.close > b.high);
      if (!mitigated) continue;
      if (currentPrice >= b.low && currentPrice <= b.high) {
        return { direction, obLow: b.low, obHigh: b.high, time: b.time, type: 'breaker' };
      }
    }
  }
  return null;
}

// ── 1H SMT divergence ─────────────────────────────────────────

// NQ makes a new 1H extreme but ES and/or YM fails to confirm.
// Bullish SMT: NQ lower low + ES/YM holds → reversal potential up
// Bearish SMT: NQ higher high + ES/YM fails → reversal potential down
function check1HSMT(nq1H, es1H, ym1H) {
  if (nq1H.length < 3 || es1H.length < 3 || ym1H.length < 3) return null;

  const nqC = nq1H[nq1H.length - 1], nqP = nq1H[nq1H.length - 2];
  const esC = es1H[es1H.length - 1], esP = es1H[es1H.length - 2];
  const ymC = ym1H[ym1H.length - 1], ymP = ym1H[ym1H.length - 2];

  const requireBoth = config.smt.requireBoth;

  // Bearish SMT: NQ new high, ES/YM diverges
  if (nqC.high > nqP.high) {
    const esDiverges = !(esC.high > esP.high);
    const ymDiverges = !(ymC.high > ymP.high);
    const diverges   = requireBoth ? (esDiverges && ymDiverges) : (esDiverges || ymDiverges);
    if (diverges) return { active: true, direction: 'bearish' };
  }

  // Bullish SMT: NQ new low, ES/YM diverges
  if (nqC.low < nqP.low) {
    const esDiverges = !(esC.low < esP.low);
    const ymDiverges = !(ymC.low < ymP.low);
    const diverges   = requireBoth ? (esDiverges && ymDiverges) : (esDiverges || ymDiverges);
    if (diverges) return { active: true, direction: 'bullish' };
  }

  return null;
}

// ── Main HTF bias computation ─────────────────────────────────

// Combines DOL, 1H sweep, 1H PD arrays, and 1H SMT into a single bias.
//
// Returns:
// {
//   bias:     'bullish' | 'bearish' | 'neutral',
//   score:    number,
//   dol:      { price, type, direction } | null,
//   htfSweep: { direction, level } | null,
//   pdArray:  { bullishFVG, bearishFVG, bullishOB, bearishOB },
//   htfSmt:   { active, direction } | null,
//   reasons:  string[],
// }
export function computeHTFBias(nq1H, es1H, ym1H, cycleInfo, sessionHL, keyLevels, nowMs) {
  if (!nq1H || nq1H.length === 0) {
    return { bias: 'neutral', score: 0, dol: null, htfSweep: null, pdArray: {}, htfSmt: null, reasons: ['no 1H data'] };
  }

  const currentPrice = nq1H[nq1H.length - 1].close;
  const reasons      = [];
  let   score        = 0;

  // ── 1. DOL — directional guide (+1 / -1) ─────────────────────
  // DOL alone doesn't trigger the hard filter (needs sweep or PD array).
  const dol = getDOL(currentPrice, keyLevels);
  if (dol) {
    if (dol.direction === 'above') {
      score += 1;
      reasons.push(`DOL above: ${dol.type} @ ${dol.price.toFixed(0)}`);
    } else {
      score -= 1;
      reasons.push(`DOL below: ${dol.type} @ ${dol.price.toFixed(0)}`);
    }
  }

  // ── 2. Recent 1H liquidity sweep — strongest signal (+2 / -2) ──
  const htfSweep = detectHTFSweep(nq1H, keyLevels);
  if (htfSweep) {
    if (htfSweep.direction === 'low_swept') {
      score += 2;
      reasons.push(`1H swept ${htfSweep.level.type} low → bullish reversal`);
    } else {
      score -= 2;
      reasons.push(`1H swept ${htfSweep.level.type} high → bearish reversal`);
    }
  }

  // ── 3. 1H PD array context (+1 / -1 per array in play) ───────
  const fvgs    = detectHTFFVGs(nq1H, currentPrice);
  const bullFVG = fvgs.find(f => f.direction === 'bullish' && currentPrice >= f.fvgLow && currentPrice <= f.fvgHigh);
  const bearFVG = fvgs.find(f => f.direction === 'bearish' && currentPrice >= f.fvgLow && currentPrice <= f.fvgHigh);
  const bullOB  = detectHTFOB(nq1H, 'bullish');
  const bearOB  = detectHTFOB(nq1H, 'bearish');

  if (bullFVG) {
    score += 1;
    reasons.push(`price in 1H bull FVG ${bullFVG.fvgLow.toFixed(0)}–${bullFVG.fvgHigh.toFixed(0)}`);
  }
  if (bearFVG) {
    score -= 1;
    reasons.push(`price in 1H bear FVG ${bearFVG.fvgLow.toFixed(0)}–${bearFVG.fvgHigh.toFixed(0)}`);
  }
  if (bullOB && currentPrice >= bullOB.obLow && currentPrice <= bullOB.obHigh) {
    score += 1;
    reasons.push(`price at 1H bull OB ${bullOB.obLow.toFixed(0)}–${bullOB.obHigh.toFixed(0)}`);
  }
  if (bearOB && currentPrice >= bearOB.obLow && currentPrice <= bearOB.obHigh) {
    score -= 1;
    reasons.push(`price at 1H bear OB ${bearOB.obLow.toFixed(0)}–${bearOB.obHigh.toFixed(0)}`);
  }

  // ── 4. Breaker Block in play (+1 / -1) ───────────────────────
  const bullBB = detectHTFBreaker(nq1H, 'bullish', currentPrice);
  const bearBB = detectHTFBreaker(nq1H, 'bearish', currentPrice);
  if (bullBB) { score += 1; reasons.push(`price at 1H bull Breaker ${bullBB.obLow.toFixed(0)}–${bullBB.obHigh.toFixed(0)}`); }
  if (bearBB) { score -= 1; reasons.push(`price at 1H bear Breaker ${bearBB.obLow.toFixed(0)}–${bearBB.obHigh.toFixed(0)}`); }

  // ── 5. 1H SMT divergence (+1 / -1) ───────────────────────────
  const htfSmt = check1HSMT(nq1H, es1H, ym1H);
  if (htfSmt?.active) {
    if (htfSmt.direction === 'bullish') { score += 1; reasons.push('1H SMT: NQ lower low, ES/YM holds → bullish'); }
    else                                { score -= 1; reasons.push('1H SMT: NQ higher high, ES/YM fails → bearish'); }
  }

  const bias = score >= 2 ? 'bullish' : score <= -2 ? 'bearish' : 'neutral';

  return {
    bias,
    score,
    dol,
    htfSweep,
    pdArray: {
      bullishFVG:     fvgs.find(f => f.direction === 'bullish') ?? null,
      bearishFVG:     fvgs.find(f => f.direction === 'bearish') ?? null,
      bullishOB:      bullOB,
      bearishOB:      bearOB,
      bullishBreaker: bullBB,
      bearishBreaker: bearBB,
    },
    htfSmt,
    reasons,
  };
}
