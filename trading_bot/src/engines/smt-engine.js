// ============================================================
// SMT ENGINE  —  Smart Money Technique divergence detector
// ============================================================
// NQ makes a new cycle extreme (sweep) but ES and/or YM fails
// to confirm it.  That inter-market divergence signals that the
// move is a liquidity grab, not a genuine breakout.
//
// Checked at three timeframe levels for the same sweep event:
//   90m  — primary cycle H/L comparison
//   30m  — sub-cycle H/L comparison
//   10m  — recent 10m window comparison
//
// None of these are hard gates — the result is a confluence
// flag attached to each trade.
//
// Shape returned by checkSMT():
// {
//   active,         // bool — true if divergence found at ANY level
//   cycle90: { es, ym, active },
//   cycle30: { es, ym, active },
//   cycle10: { es, ym, active },
// }
// ============================================================

import { config } from '../../config.js';

// ── Public API ────────────────────────────────────────────────

export function checkSMT(esBars, ymBars, cycleInfo, sweep) {
  if (!config.smt.enabled) return smtOff();

  const tES = config.smt.tolerance.es;
  const tYM = config.smt.tolerance.ym;
  const dir = sweep.direction;

  // ── 90m level ─────────────────────────────────────────────
  const nqSweepMs = sweep.sweepCandle.time + 60000; // include the sweep bar
  const cycle90   = divergenceAt(
    esBars, ymBars,
    cycleInfo.prevCycleStartMs, cycleInfo.prevCycleEndMs,
    cycleInfo.cycleStartMs,     nqSweepMs,
    dir, tES, tYM,
  );

  // ── 30m level ─────────────────────────────────────────────
  let cycle30 = { es: false, ym: false, active: false };
  if (cycleInfo.sub30) {
    const { prevStartMs, prevEndMs, startMs, endMs } = cycleInfo.sub30;
    // Current window: from 30m start up to the sweep
    const curr30End = Math.min(nqSweepMs, endMs);
    cycle30 = divergenceAt(
      esBars, ymBars,
      prevStartMs, prevEndMs,
      startMs,     curr30End,
      dir, tES, tYM,
    );
  }

  // ── 10m level ─────────────────────────────────────────────
  let cycle10 = { es: false, ym: false, active: false };
  if (cycleInfo.sub10?.recent?.length >= 2) {
    // recent[1] = previous 10m completed, recent[0] = current
    const prev10 = cycleInfo.sub10.recent[1];
    const curr10 = cycleInfo.sub10.recent[0];
    cycle10 = divergenceAt(
      esBars, ymBars,
      prev10.startMs, prev10.endMs,
      curr10.startMs, Math.min(nqSweepMs, curr10.endMs),
      dir, tES, tYM,
    );
  }

  const active = cycle90.active || cycle30.active || cycle10.active;
  return { active, cycle90, cycle30, cycle10 };
}

// ── Internal helpers ──────────────────────────────────────────

function divergenceAt(esBars, ymBars, prevStart, prevEnd, currStart, currEnd, dir, tES, tYM) {
  const esPrev = rangeHL(esBars, prevStart, prevEnd);
  const ymPrev = rangeHL(ymBars, prevStart, prevEnd);
  const esCurr = rangeHL(esBars, currStart, currEnd);
  const ymCurr = rangeHL(ymBars, currStart, currEnd);

  let esDiverges = false;
  let ymDiverges = false;

  if (dir === 'short') {
    // NQ swept HIGH — check if ES/YM also made new high
    if (esPrev && esCurr) esDiverges = esCurr.high <= esPrev.high + tES;
    if (ymPrev && ymCurr) ymDiverges = ymCurr.high <= ymPrev.high + tYM;
  } else {
    // NQ swept LOW — check if ES/YM also made new low
    if (esPrev && esCurr) esDiverges = esCurr.low >= esPrev.low - tES;
    if (ymPrev && ymCurr) ymDiverges = ymCurr.low >= ymPrev.low - tYM;
  }

  const active = config.smt.requireBoth
    ? (esDiverges && ymDiverges)
    : (esDiverges || ymDiverges);

  return { es: esDiverges, ym: ymDiverges, active };
}

// Scan a static bar array for H/L in [startMs, endMs]. O(n) but only
// called on actual trade signals (~handful per session), not every bar.
function rangeHL(bars, startMs, endMs) {
  if (!bars || bars.length === 0) return null;
  let high = -Infinity, low = Infinity, count = 0;
  for (const b of bars) {
    if (b.time >= startMs && b.time <= endMs) {
      if (b.high > high) high = b.high;
      if (b.low  < low)  low  = b.low;
      count++;
    }
  }
  return count > 0 ? { high, low } : null;
}

function smtOff() {
  const off = { es: false, ym: false, active: false };
  return { active: false, cycle90: off, cycle30: off, cycle10: off };
}

// Human-readable label, e.g. "SMT✓ ES(90m,30m) YM(90m)"
export function smtLabel(smt) {
  if (!smt || !smt.active) return '';
  const parts = [];
  for (const inst of ['es', 'ym']) {
    const levels = [];
    if (smt.cycle90[inst]) levels.push('90m');
    if (smt.cycle30[inst]) levels.push('30m');
    if (smt.cycle10[inst]) levels.push('10m');
    if (levels.length) parts.push(`${inst.toUpperCase()}(${levels.join(',')})`);
  }
  return parts.length ? `SMT✓ ${parts.join(' ')}` : '';
}
