// ============================================================
// KILLZONE ENGINE  —  NY AM and NY PM trading windows
// ============================================================
// Frank's model ONLY fires signals during two specific daily
// windows when institutional order flow is most active:
//
//   NY AM  :  9:30 – 11:00 ET  (NY open / London close overlap)
//   NY PM  :  1:30 – 3:00 ET   (afternoon expansion / distribution)
//
// Outside these windows the signal engine is completely silent —
// no setup however perfect should be traded.
//
// This engine also tracks which killzone we're in so the signal
// log can annotate the confluence block correctly.
// ============================================================

import { config } from '../../config.js';

// ── ET time helper ────────────────────────────────────────────

// Returns Eastern Time components for a given UTC ms timestamp.
// Uses Intl.DateTimeFormat which handles DST automatically.
export function toET(utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
    hour:     '2-digit',
    minute:   '2-digit',
    second:   '2-digit',
    hour12:   false,
  }).formatToParts(new Date(utcMs));

  const get = type => {
    const part = parts.find(p => p.type === type);
    return part ? parseInt(part.value) : 0;
  };

  // Intl occasionally returns 24 for midnight; normalize to 0
  const hour = get('hour') === 24 ? 0 : get('hour');

  return {
    year:        get('year'),
    month:       get('month'),
    day:         get('day'),
    hour,
    minute:      get('minute'),
    second:      get('second'),
    minuteOfDay: hour * 60 + get('minute'),
  };
}

// ── Killzone status ───────────────────────────────────────────

// Returns { active: bool, name: string|null, minutesRemaining: number }
// Pass no argument to evaluate the current moment.
export function getKillzoneStatus(utcMs = Date.now()) {
  const et = toET(utcMs);
  const minuteOfDay = et.minuteOfDay;

  for (const kz of (config.killzones ?? [])) {
    const startMin = kz.startHour * 60 + kz.startMinute;
    const endMin   = kz.endHour   * 60 + kz.endMinute;

    if (minuteOfDay >= startMin && minuteOfDay < endMin) {
      return {
        active:           true,
        name:             kz.name,
        minutesRemaining: endMin - minuteOfDay,
      };
    }
  }

  // Find how long until the next killzone opens (useful for logging)
  let minutesUntilNext = null;
  for (const kz of (config.killzones ?? [])) {
    const startMin = kz.startHour * 60 + kz.startMinute;
    if (startMin > minuteOfDay) {
      const remaining = startMin - minuteOfDay;
      if (minutesUntilNext === null || remaining < minutesUntilNext) {
        minutesUntilNext = remaining;
      }
    }
  }

  return {
    active:           false,
    name:             null,
    minutesUntilNext: minutesUntilNext ?? 0,
  };
}

// Convenience: is the current moment inside ANY killzone?
export function isInKillzone(utcMs = Date.now()) {
  return getKillzoneStatus(utcMs).active;
}

// ── Premium window ────────────────────────────────────────────

// Returns true if the timestamp falls in the XX:45–XX:15 window
// around any hour mark (e.g. 9:45–10:15, 1:45–2:15).
// These are the highest-probability entry minutes in Frank's model —
// trades here count as "premium" but the bot runs 24/7 regardless.
export function isPremiumWindow(utcMs) {
  const { minute } = toET(utcMs);
  return minute >= 45 || minute <= 15;
}
