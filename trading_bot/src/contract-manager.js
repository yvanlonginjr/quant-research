// ============================================================
// CONTRACT MANAGER  —  Auto-rolling front-month futures
// ============================================================
// CME E-mini futures (NQ, ES, YM) expire quarterly on the
// 3rd Friday of March, June, September, and December.
//
// Contract month codes:
//   H = March    M = June    U = September    Z = December
//
// Roll logic:
//   Traders switch to the next contract when volume migrates,
//   which typically happens ~8 calendar days before expiration.
//   This module uses that same rule so the bot always trades
//   the dominant contract.
//
// Example (today = April 18, 2026):
//   June 2026 (M26) expires June 19, 2026.
//   Roll date = June 11, 2026.
//   April 18 < June 11 → active contract = NQM26 / ESM26 / YMM26
//
// Usage:
//   import { contractManager } from './contract-manager.js';
//   contractManager.getSymbol('NQ')  // → 'NQM26'
//   contractManager.getSymbol('ES')  // → 'ESM26'
//   contractManager.getSymbol('YM')  // → 'YMM26'
//   contractManager.logStatus()      // → logs current contracts + next roll date
// ============================================================

import { toET } from './engines/killzone.js';

// ── Quarterly expiration schedule ─────────────────────────────

const QUARTERS = [
  { month: 3,  code: 'H' },   // March
  { month: 6,  code: 'M' },   // June
  { month: 9,  code: 'U' },   // September
  { month: 12, code: 'Z' },   // December
];

// Calendar days before 3rd Friday to roll to the next contract.
// 8 days is the standard volume-shift window for CME E-minis.
const ROLL_DAYS_BEFORE_EXPIRY = 8;

// ── Date math helpers ─────────────────────────────────────────

// Returns the Date object of the 3rd Friday of a given month/year.
// All CME E-mini futures expire on the 3rd Friday at 9:30 AM CT.
function getThirdFriday(year, month) {
  // Start at the 1st of the month (month is 1-indexed here)
  const d = new Date(year, month - 1, 1);
  // Advance to first Friday (day 5)
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  // Jump 2 more weeks to the 3rd Friday
  d.setDate(d.getDate() + 14);
  return d;
}

// Returns the roll date: N days before expiration
function getRollDate(expiryDate, daysBeforeExpiry) {
  const roll = new Date(expiryDate);
  roll.setDate(roll.getDate() - daysBeforeExpiry);
  return roll;
}

// ── Core logic ────────────────────────────────────────────────

// Given a base symbol ('NQ', 'ES', 'YM') and an optional UTC ms timestamp,
// returns the active front-month contract symbol (e.g. 'NQM26').
//
// Rolls to the next contract when today >= rollDate (8 days before expiry).
export function getActiveContractSymbol(baseSymbol, utcMs = Date.now()) {
  const et    = toET(utcMs);
  // Build a plain Date in local time (doesn't matter for day-level comparison)
  const today = new Date(et.year, et.month - 1, et.day);

  // Check all 4 quarters of the current calendar year
  for (const q of QUARTERS) {
    const expiry   = getThirdFriday(et.year, q.month);
    const rollDate = getRollDate(expiry, ROLL_DAYS_BEFORE_EXPIRY);

    if (today <= rollDate) {
      // This quarter is still active (volume hasn't migrated yet)
      // TradingView requires the full 4-digit year: NQM2026, not NQM26
      return `${baseSymbol}${q.code}${et.year}`;
    }
  }

  // All 4 quarters of the current year have rolled —
  // use the March contract of the next year (H)
  const nextYear = et.year + 1;
  return `${baseSymbol}H${nextYear}`;
}

// Returns info about the NEXT upcoming roll event:
// { symbol, expiryDate, rollDate, daysUntilRoll }
export function getNextRollInfo(baseSymbol, utcMs = Date.now()) {
  const et    = toET(utcMs);
  const today = new Date(et.year, et.month - 1, et.day);

  // Search current and next year
  for (let yearOffset = 0; yearOffset <= 1; yearOffset++) {
    const year = et.year + yearOffset;
    for (const q of QUARTERS) {
      const expiry   = getThirdFriday(year, q.month);
      const rollDate = getRollDate(expiry, ROLL_DAYS_BEFORE_EXPIRY);
      if (rollDate >= today) {
        const symbol      = `${baseSymbol}${q.code}${year}`;
        const daysUntilRoll = Math.ceil((rollDate - today) / 86400000);
        return { symbol, expiryDate: expiry, rollDate, daysUntilRoll };
      }
    }
  }

  return null;
}

// ── ContractManager class ─────────────────────────────────────
// Caches the current symbols and detects when a roll has occurred
// between ticks so index.js can switch the chart automatically.

class ContractManager {
  constructor() {
    this._lastChecked = 0;
    this._cache       = {};  // { NQ: 'NQM26', ES: 'ESM26', YM: 'YMM26' }
  }

  // Returns the active contract symbol for a base instrument.
  // Re-evaluates at most once per minute to avoid overhead.
  getSymbol(base, utcMs = Date.now()) {
    if (utcMs - this._lastChecked > 60_000) {
      this._refresh(utcMs);
    }
    return this._cache[base];
  }

  // Returns { nq, es, ym } — all three active symbols at once
  getAllSymbols(utcMs = Date.now()) {
    if (utcMs - this._lastChecked > 60_000) {
      this._refresh(utcMs);
    }
    return { ...this._cache };
  }

  // Check if any contract has rolled since the last call.
  // Returns an array of rolled bases (usually empty, occasionally ['NQ','ES','YM'])
  checkForRolls(utcMs = Date.now()) {
    const before = { ...this._cache };
    this._refresh(utcMs);
    return Object.keys(this._cache).filter(base => this._cache[base] !== before[base]);
  }

  // Print current contracts + next roll date to logger
  logStatus(logger, utcMs = Date.now()) {
    this._refresh(utcMs);
    const nqRoll = getNextRollInfo('NQ', utcMs);
    logger.info(
      `Contracts: NQ=${this._cache.NQ}  ES=${this._cache.ES}  YM=${this._cache.YM}  ` +
      `| Next roll in ~${nqRoll?.daysUntilRoll ?? '?'} days (${nqRoll?.symbol ?? '?'})`
    );
  }

  _refresh(utcMs) {
    this._cache = {
      NQ: getActiveContractSymbol('NQ', utcMs),
      ES: getActiveContractSymbol('ES', utcMs),
      YM: getActiveContractSymbol('YM', utcMs),
    };
    this._lastChecked = utcMs;
  }
}

// Singleton — import this everywhere
export const contractManager = new ContractManager();
