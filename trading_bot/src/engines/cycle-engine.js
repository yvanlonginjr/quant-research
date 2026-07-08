// ============================================================
// CYCLE ENGINE  —  Frank369 Multi-TF Cycle Tracker
// ============================================================
// Session layout (Eastern Time), reset every trading day:
//
//   Cycle 1 :  6:00 PM – 7:00 PM  ET  (60-min opener)
//   Cycles 2–15: 90 min each, ending at 4:00 PM ET
//   Dead zone:  4:00 PM – 6:00 PM ET
//
// Sub-cycle breakdown (Cycles 2–15 only):
//   Each 90m cycle → 3 × 30m sub-cycles
//   Each 30m sub-cycle → 3 × 10m sub-cycles
//
//   Cycle 1 (60 min) → 2 × 30m, 6 × 10m (no partial slots)
//
// 10m analysis window: current + last 2 completed 10m cycles,
// tracked globally from session anchor so the window always
// works correctly across 30m and 90m boundaries.
// ============================================================

import { config } from '../../config.js';
import { toET }   from './killzone.js';

// ── Constants ─────────────────────────────────────────────────

const ANCHOR_HOUR  = config.cycle.startHour;      // 18
const ANCHOR_MIN   = config.cycle.startMinute;    // 0
const ANCHOR_MOD   = ANCHOR_HOUR * 60 + ANCHOR_MIN; // 1080 (6 PM)
const OPEN_MINS    = config.cycle.openingCycleMins; // 60
const CYCLE_MINS   = config.cycle.durationMinutes;  // 90
const SUB30_MINS   = 30;
const SUB10_MINS   = 10;
const DEAD_START   = 16 * 60;   // 4:00 PM
const DEAD_END     = ANCHOR_MOD; // 6:00 PM

// ── Session anchor ────────────────────────────────────────────

function getSessionAnchorMs(et) {
  const mod = et.minuteOfDay;
  if (mod >= DEAD_START && mod < DEAD_END) return null;
  if (mod >= DEAD_END) {
    return etToUtcMs({ year: et.year, month: et.month, day: et.day }, ANCHOR_MOD);
  }
  const prevDay = new Date(Date.UTC(et.year, et.month - 1, et.day) - 86400000);
  return etToUtcMs(
    { year: prevDay.getUTCFullYear(), month: prevDay.getUTCMonth() + 1, day: prevDay.getUTCDate() },
    ANCHOR_MOD,
  );
}

function etToUtcMs(etDate, minuteOfDay) {
  const { year, month, day } = etDate;
  const noonUTC    = Date.UTC(year, month - 1, day, 12, 0, 0);
  const etAtNoon   = toET(noonUTC);
  const noonETMins = etAtNoon.hour * 60 + etAtNoon.minute;
  return noonUTC + (minuteOfDay - noonETMins) * 60 * 1000;
}

// ── 90m cycle math ────────────────────────────────────────────

function cycleIndexFromElapsed(elapsedMins) {
  if (elapsedMins < 0)       return null;
  if (elapsedMins < OPEN_MINS) return 1;
  return 2 + Math.floor((elapsedMins - OPEN_MINS) / CYCLE_MINS);
}

function cycleStartElapsed(idx) {
  if (idx <= 1) return 0;
  return OPEN_MINS + (idx - 2) * CYCLE_MINS;
}

function cycleEndElapsed(idx) {
  if (idx <= 1) return OPEN_MINS;
  return OPEN_MINS + (idx - 1) * CYCLE_MINS;
}

// ── 30m sub-cycle math ────────────────────────────────────────

// Returns 1-based 30m slot index (1, 2, or 3) within a 90m cycle.
// Clamps to the number of available 30m slots (cycle 1 has only 2).
function sub30IndexFromElapsed(elapsedFrom90mStart, cycleDurationMins) {
  const maxSlots = Math.floor(cycleDurationMins / SUB30_MINS); // 2 for C1, 3 for C2+
  return Math.min(Math.floor(elapsedFrom90mStart / SUB30_MINS) + 1, maxSlots);
}

// ── 10m sub-cycle math ────────────────────────────────────────

// Returns the 0-based global 10m index from session anchor.
function global10mIndex(elapsedFromAnchorMins) {
  return Math.floor(elapsedFromAnchorMins / SUB10_MINS);
}

// ── Public API ────────────────────────────────────────────────

// Returns full multi-TF cycle info for the given UTC timestamp.
//
// Shape:
// {
//   cycleIndex, cycleStartMs, cycleEndMs,
//   prevCycleIndex, prevCycleStartMs, prevCycleEndMs,
//   sessionAnchorMs,
//   isPreAnchor, isDeadZone, et,
//
//   sub30: {
//     index,           // 1 | 2 | 3  (slot within current 90m cycle)
//     startMs, endMs,
//     prevStartMs, prevEndMs,   // previous 30m slot
//   },
//
//   sub10: {
//     index,           // 1 | 2 | 3  (slot within current 30m sub-cycle)
//     startMs, endMs,
//     recent: [        // [0]=current, [1]=1 back, [2]=2 back
//       { startMs, endMs },
//       { startMs, endMs },
//       { startMs, endMs },
//     ],
//   },
// }
export function getCycleInfo(utcMs = Date.now()) {
  const et       = toET(utcMs);
  const anchorMs = getSessionAnchorMs(et);

  if (anchorMs === null) return { isDeadZone: true, isPreAnchor: false, et };

  const elapsedMins = (utcMs - anchorMs) / 60000;
  const idx         = cycleIndexFromElapsed(elapsedMins);

  if (idx === null) return { isPreAnchor: true, isDeadZone: false, et };

  // ── 90m boundaries ───────────────────────────────────────────
  const startMs      = anchorMs + cycleStartElapsed(idx)  * 60000;
  const endMs        = anchorMs + cycleEndElapsed(idx)     * 60000;
  const prevIdx      = Math.max(idx - 1, 1);
  const prevStartMs  = anchorMs + cycleStartElapsed(prevIdx) * 60000;
  const prevEndMs    = anchorMs + cycleEndElapsed(prevIdx)   * 60000;
  const cycleDurMins = idx === 1 ? OPEN_MINS : CYCLE_MINS;

  // ── 30m sub-cycle ─────────────────────────────────────────────
  const elapsedIn90m  = (utcMs - startMs) / 60000;
  const s30Idx        = sub30IndexFromElapsed(elapsedIn90m, cycleDurMins);
  const s30StartMs    = startMs + (s30Idx - 1) * SUB30_MINS * 60000;
  const s30EndMs      = s30StartMs + SUB30_MINS * 60000;

  // Previous 30m slot — if we're at slot 1, step back into the previous 90m cycle
  let s30PrevStartMs, s30PrevEndMs;
  if (s30Idx > 1) {
    s30PrevStartMs = startMs + (s30Idx - 2) * SUB30_MINS * 60000;
    s30PrevEndMs   = s30PrevStartMs + SUB30_MINS * 60000;
  } else {
    // First 30m of this 90m cycle — previous 30m is last slot of prevCycle
    const prevCycleDurMins = prevIdx === 1 ? OPEN_MINS : CYCLE_MINS;
    const prevSlotCount    = Math.floor(prevCycleDurMins / SUB30_MINS);
    s30PrevStartMs = prevStartMs + (prevSlotCount - 1) * SUB30_MINS * 60000;
    s30PrevEndMs   = s30PrevStartMs + SUB30_MINS * 60000;
  }

  // ── 10m sub-cycle (global) ────────────────────────────────────
  const g10Idx     = global10mIndex(elapsedMins);
  const s10StartMs = anchorMs + g10Idx * SUB10_MINS * 60000;
  const s10EndMs   = s10StartMs + SUB10_MINS * 60000;

  // Index within current 30m slot (1-based: 1, 2, or 3)
  const elapsedIn30m = (utcMs - s30StartMs) / 60000;
  const s10IdxIn30   = Math.min(Math.floor(elapsedIn30m / SUB10_MINS) + 1, 3);

  // Build recent window: current + last 2 completed 10m cycles
  const recent10m = [0, 1, 2].map(offset => {
    const s = s10StartMs - offset * SUB10_MINS * 60000;
    return { startMs: s, endMs: s + SUB10_MINS * 60000 };
  });

  return {
    // 90m
    cycleIndex:       idx,
    cycleStartMs:     startMs,
    cycleEndMs:       endMs,
    prevCycleIndex:   prevIdx,
    prevCycleStartMs: prevStartMs,
    prevCycleEndMs:   prevEndMs,
    sessionAnchorMs:  anchorMs,
    isPreAnchor:      false,
    isDeadZone:       false,
    et,

    // 30m
    sub30: {
      index:        s30Idx,
      startMs:      s30StartMs,
      endMs:        s30EndMs,
      prevStartMs:  s30PrevStartMs,
      prevEndMs:    s30PrevEndMs,
    },

    // 10m
    sub10: {
      index:   s10IdxIn30,
      startMs: s10StartMs,
      endMs:   s10EndMs,
      recent:  recent10m,
    },
  };
}

// ── HTF bias helpers ──────────────────────────────────────────

// Returns H/L for the last `n` completed 90m cycles (not including current).
// Ordered oldest-first.
export function getPastCycleHighLows(candleBuffer, cycleInfo, n = 3) {
  if (!cycleInfo || cycleInfo.isDeadZone || cycleInfo.isPreAnchor) return [];
  const anchorMs = cycleInfo.sessionAnchorMs;
  const result   = [];
  const oldest   = Math.max(1, cycleInfo.cycleIndex - n);

  for (let idx = oldest; idx < cycleInfo.cycleIndex; idx++) {
    const startMs = anchorMs + cycleStartElapsed(idx) * 60000;
    const endMs   = anchorMs + cycleEndElapsed(idx)   * 60000;
    const hl      = candleBuffer.rangeHighLow(startMs, endMs);
    if (hl) result.push(hl);
  }
  return result;
}

// Determines HTF bias by comparing the current price to the
// PREVIOUS SESSION CLOSE — the last bar before today's 6 PM ET
// session anchor (= 4 PM ET close of prior trading day, or Friday
// close when today's session started on Sunday night).
//
// thresholdPoints: how many NQ points above/below PDC to declare bias.
// Returns 'bullish' | 'bearish' | 'neutral'
export function getHTFBias(candleBuffer, cycleInfo, thresholdPoints = 10) {
  if (!cycleInfo || cycleInfo.isDeadZone || cycleInfo.isPreAnchor) return 'neutral';

  // Walk backwards through the buffer to find the last bar BEFORE
  // the session anchor (= the prior session's closing print).
  const allBars = candleBuffer.all();
  let prevCloseBar = null;
  for (let i = allBars.length - 1; i >= 0; i--) {
    if (allBars[i].time < cycleInfo.sessionAnchorMs) {
      prevCloseBar = allBars[i];
      break;
    }
  }

  if (!prevCloseBar) return 'neutral';

  const currentBar = candleBuffer.current();
  if (!currentBar) return 'neutral';

  const diff = currentBar.close - prevCloseBar.close;
  if (diff >  thresholdPoints) return 'bullish';
  if (diff < -thresholdPoints) return 'bearish';
  return 'neutral';
}

// ── High/Low helpers ──────────────────────────────────────────

// H/L of the previous completed 90m cycle
export function getPrevCycleHighLow(candleBuffer, cycleInfo) {
  if (!cycleInfo || cycleInfo.isDeadZone || cycleInfo.isPreAnchor) return null;
  return candleBuffer.rangeHighLow(cycleInfo.prevCycleStartMs, cycleInfo.prevCycleEndMs);
}

// H/L of the current (in-progress) 90m cycle
export function getCurrentCycleHighLow(candleBuffer, cycleInfo) {
  if (!cycleInfo || cycleInfo.isDeadZone || cycleInfo.isPreAnchor) return null;
  return candleBuffer.rangeHighLow(cycleInfo.cycleStartMs, Date.now());
}

// H/L of the current 30m sub-cycle
export function get30mHighLow(candleBuffer, cycleInfo) {
  if (!cycleInfo?.sub30) return null;
  return candleBuffer.rangeHighLow(cycleInfo.sub30.startMs, cycleInfo.sub30.endMs);
}

// H/L of the previous 30m sub-cycle
export function getPrev30mHighLow(candleBuffer, cycleInfo) {
  if (!cycleInfo?.sub30) return null;
  return candleBuffer.rangeHighLow(cycleInfo.sub30.prevStartMs, cycleInfo.sub30.prevEndMs);
}

// H/L for [current, -1, -2] 10m cycles.
// Returns array of { high, low, highTime, lowTime, barCount } | null
export function getRecent10mHighLows(candleBuffer, cycleInfo) {
  if (!cycleInfo?.sub10) return [null, null, null];
  return cycleInfo.sub10.recent.map(r => candleBuffer.rangeHighLow(r.startMs, r.endMs));
}

// Human-readable label, e.g. "C14 | 30m#2 | 10m#3"
export function cycleLabel(cycleInfo) {
  if (!cycleInfo || cycleInfo.isDeadZone) return 'DEAD';
  if (cycleInfo.isPreAnchor)              return 'PRE';
  const s30 = cycleInfo.sub30 ? `| 30m#${cycleInfo.sub30.index}` : '';
  const s10 = cycleInfo.sub10 ? `| 10m#${cycleInfo.sub10.index}` : '';
  return `C${cycleInfo.cycleIndex} ${s30} ${s10}`.trim();
}

// Legacy label kept for backtest console output
export function cycleStartLabel(cycleIndex) {
  const elapsedMins = cycleIndex <= 1 ? 0 : OPEN_MINS + (cycleIndex - 2) * CYCLE_MINS;
  const totalMins   = ANCHOR_MOD + elapsedMins;
  const h   = Math.floor(totalMins / 60) % 24;
  const m   = totalMins % 60;
  const ap  = h >= 12 ? 'PM' : 'AM';
  const h12 = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `C${cycleIndex} (${h12}:${String(m).padStart(2, '0')} ${ap})`;
}
