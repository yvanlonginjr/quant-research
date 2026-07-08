// ============================================================
// LEVELS ENGINE  —  Key reference levels (DOL targets)
// ============================================================
// Tracks the price levels that ICT considers "draws on liquidity":
//
//   PDH / PDL      — previous complete session H/L (6 PM – 4 PM ET)
//   Weekly H/L     — current week's range
//   Weekly open    — first print of the trading week (Sunday 6 PM ET)
//   Monthly open   — first print of the calendar month
//   Quarterly open — first print of Q1(Jan), Q2(Apr), Q3(Jul), Q4(Oct)
//   Yearly open    — first print of the calendar year
//
// These are the levels price is magnetically drawn toward.
// The nearest unmitigated level above/below = the DOL.
// ============================================================

import { toET } from './killzone.js';

// ── Public API ────────────────────────────────────────────────

// Returns all key levels given the full 1-min bar array and cycleInfo.
// Only call this when needed (on trade signal evaluation) — it scans bars.
//
// Shape:
// {
//   pdh, pdl,                      // prev session H/L
//   weeklyOpen, weeklyHigh, weeklyLow,
//   monthlyOpen,
//   quarterlyOpen,
//   yearlyOpen,
// }
export function getKeyLevels(allBars, cycleInfo) {
  if (!cycleInfo || !cycleInfo.sessionAnchorMs) return {};

  const anchorMs = cycleInfo.sessionAnchorMs;

  // ── PDH / PDL ─────────────────────────────────────────────
  // Previous complete session: 6 PM ET yesterday → 4 PM ET today
  const prevStart = anchorMs - 24 * 3600000;
  const prevEnd   = anchorMs - 2  * 3600000;   // 4 PM ET = anchor − 2h
  let pdh = null, pdl = null;
  for (const b of allBars) {
    if (b.time < prevStart) continue;
    if (b.time > prevEnd)   break;
    if (pdh === null || b.high > pdh) pdh = b.high;
    if (pdl === null || b.low  < pdl) pdl = b.low;
  }

  // ── Weekly H/L + Open ─────────────────────────────────────
  // Trading week starts Sunday 6 PM ET = anchorMs rounded to most recent Sunday.
  const weekStart = weeklyOpenMs(anchorMs);
  let weeklyOpen = null, weeklyHigh = null, weeklyLow = null;
  for (const b of allBars) {
    if (b.time < weekStart)  continue;
    if (b.time >= anchorMs)  break;   // don't cross into current session
    if (weeklyOpen === null)               weeklyOpen = b.open;
    if (weeklyHigh === null || b.high > weeklyHigh) weeklyHigh = b.high;
    if (weeklyLow  === null || b.low  < weeklyLow)  weeklyLow  = b.low;
  }

  // ── Monthly open ─────────────────────────────────────────
  const monthlyOpen = firstBarOpenInPeriod(allBars, anchorMs, b => {
    const et = toET(b.time);
    return et.day <= 3;   // first few days of the month
  });

  // ── Quarterly open (Jan, Apr, Jul, Oct) ──────────────────
  const quarterlyOpen = firstBarOpenInPeriod(allBars, anchorMs, b => {
    const et = toET(b.time);
    return [1, 4, 7, 10].includes(et.month) && et.day <= 3;
  });

  // ── Yearly open ───────────────────────────────────────────
  const yearlyOpen = firstBarOpenInPeriod(allBars, anchorMs, b => {
    const et = toET(b.time);
    return et.month === 1 && et.day <= 3;
  });

  return { pdh, pdl, weeklyOpen, weeklyHigh, weeklyLow, monthlyOpen, quarterlyOpen, yearlyOpen };
}

// Returns a flat sorted array of { price, type } for all non-null levels.
// Useful for DOL proximity checks.
export function flatLevels(levels) {
  const map = {
    pdh:          'PDH',
    pdl:          'PDL',
    weeklyHigh:   'WkH',
    weeklyLow:    'WkL',
    weeklyOpen:   'WkO',
    monthlyOpen:  'MthO',
    quarterlyOpen:'QtrO',
    yearlyOpen:   'YrO',
  };
  return Object.entries(map)
    .filter(([k]) => levels[k] != null)
    .map(([k, type]) => ({ price: levels[k], type }));
}

// Human-readable label for logging, e.g. "PDH 24550 | PDL 24310 | WkH 24600"
export function levelsLabel(levels) {
  return flatLevels(levels)
    .map(l => `${l.type} ${l.price.toFixed(2)}`)
    .join(' | ') || 'n/a';
}

// ── Internal helpers ──────────────────────────────────────────

// Compute UTC ms of the most recent Sunday 6 PM ET relative to the anchor.
function weeklyOpenMs(anchorMs) {
  // Walk back from the anchor in 24h steps until we hit a Sunday
  for (let offset = 0; offset <= 7; offset++) {
    const candidateMs = anchorMs - offset * 86400000;
    const et = toET(candidateMs);
    const dow = new Date(Date.UTC(et.year, et.month - 1, et.day)).getUTCDay();
    if (dow === 0) return candidateMs; // Sunday at 6 PM ET (anchorMs is always 6 PM ET)
  }
  return anchorMs - 7 * 86400000; // fallback
}

// Open of the first bar that satisfies predicate, before the anchor.
function firstBarOpenInPeriod(allBars, anchorMs, predicate) {
  for (const b of allBars) {
    if (b.time >= anchorMs) break;
    if (predicate(b)) return b.open;
  }
  return null;
}
