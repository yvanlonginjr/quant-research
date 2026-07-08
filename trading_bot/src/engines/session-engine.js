// ============================================================
// SESSION ENGINE  —  Frank369 Session Liquidity Levels
// ============================================================
// Tracks High/Low for each named session anchored to the same
// 6 PM ET session start used by the cycle engine.
//
// Session windows (relative to 6 PM ET anchor):
//   Asia   :  6:00 PM –  2:00 AM ET  (0    – 480  min)
//   London :  2:00 AM –  7:00 AM ET  (480  – 780  min)
//   Pre-NY :  7:00 AM –  9:30 AM ET  (780  – 930  min)
//   NY AM  :  9:30 AM – 11:30 AM ET  (930  – 1050 min)
//   Lunch  : 11:30 AM –  1:00 PM ET  (1050 – 1140 min)
//   NY PM  :  1:00 PM –  4:00 PM ET  (1140 – 1320 min)
//   Dead zone: 4:00 PM – 6:00 PM ET  (1320 – 1440 min)
//
// Use getSessionHighLows(candleBuffer, utcMs) to get a snapshot
// of completed and in-progress session H/L at any given moment.
// ============================================================

import { getCycleInfo } from './cycle-engine.js';

// ── Session definitions (minutes from 6 PM ET anchor) ─────────

export const SESSIONS = [
  { name: 'Asia',   startMins:    0, endMins:  480 }, // 6 PM – 2 AM
  { name: 'London', startMins:  480, endMins:  780 }, // 2 AM – 7 AM
  { name: 'Pre-NY', startMins:  780, endMins:  930 }, // 7 AM – 9:30 AM
  { name: 'NY AM',  startMins:  930, endMins: 1050 }, // 9:30 AM – 11:30 AM
  { name: 'Lunch',  startMins: 1050, endMins: 1140 }, // 11:30 AM – 1 PM
  { name: 'NY PM',  startMins: 1140, endMins: 1320 }, // 1 PM – 4 PM
];

// ── Core window computation ───────────────────────────────────

// Returns the UTC ms start/end windows for each session given the
// session anchor, plus which session is currently active.
export function getSessionWindows(utcMs) {
  const ci = getCycleInfo(utcMs);
  if (!ci || ci.isDeadZone || ci.isPreAnchor) return null;

  const anchorMs    = ci.sessionAnchorMs;
  const elapsedMins = (utcMs - anchorMs) / 60000;

  const windows       = {};
  let currentSession  = null;

  for (const s of SESSIONS) {
    const startMs = anchorMs + s.startMins * 60000;
    const endMs   = anchorMs + s.endMins   * 60000;
    windows[s.name] = { startMs, endMs };
    if (elapsedMins >= s.startMins && elapsedMins < s.endMins) {
      currentSession = s.name;
    }
  }

  return { windows, currentSession, sessionAnchorMs: anchorMs };
}

// ── Public API ────────────────────────────────────────────────

// Returns H/L for every session from the candle buffer.
// Completed sessions → full range. Current session → range so far.
//
// Shape:
// {
//   currentSession: 'NY AM' | 'London' | ... | null,
//   Asia:   { high, low, highTime, lowTime, barCount } | null,
//   London: { ... } | null,
//   'Pre-NY': { ... } | null,
//   'NY AM':  { ... } | null,
//   'NY PM':  { ... } | null,
// }
export function getSessionHighLows(candleBuffer, utcMs) {
  const info = getSessionWindows(utcMs);
  if (!info) return null;

  const result = { currentSession: info.currentSession };

  for (const s of SESSIONS) {
    const w      = info.windows[s.name];
    // For the current (in-progress) session, cap end at now so we only
    // report what has actually printed.
    const endMs  = s.name === info.currentSession ? utcMs : w.endMs;
    result[s.name] = candleBuffer.rangeHighLow(w.startMs, endMs);
  }

  return result;
}

// Human-readable one-liner for logging/Excel, e.g.:
// "Asia 21050/20890 | London 21120/20970 | NY AM (live) 21200/21050"
export function sessionLevelsLabel(sessionHL) {
  if (!sessionHL) return 'n/a';
  return SESSIONS.map(s => {
    const hl = sessionHL[s.name];
    if (!hl || !hl.barCount) return null;
    const live = s.name === sessionHL.currentSession ? ' (live)' : '';
    return `${s.name}${live} ${hl.high.toFixed(2)}/${hl.low.toFixed(2)}`;
  }).filter(Boolean).join(' | ');
}
