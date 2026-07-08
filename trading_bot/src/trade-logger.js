// ============================================================
// TRADE LOGGER  —  Persistent trade record
// ============================================================
// Saves every backtest signal to data/trades.json so you can
// track results across multiple backtest runs over time.
// Each entry is a complete signal record with all confluence
// factors, outcome, and which timeframe it was found on.
// ============================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir      = dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = join(__dir, '..', 'data');
const TRADES_FILE = join(DATA_DIR, 'trades.json');

// Ensure data/ directory exists
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// ── Load / save ───────────────────────────────────────────────

export function loadTrades() {
  try {
    if (!existsSync(TRADES_FILE)) return [];
    return JSON.parse(readFileSync(TRADES_FILE, 'utf8'));
  } catch {
    return [];
  }
}

// Append new trades to the persistent file.
// Deduplicates by trade.id so re-running the backtest doesn't create duplicates.
export function saveTrades(newTrades) {
  const existing = loadTrades();
  const existingIds = new Set(existing.map(t => t.id));
  const fresh = newTrades.filter(t => !existingIds.has(t.id));
  const all = [...existing, ...fresh].sort((a, b) => a.timestamp - b.timestamp);
  writeFileSync(TRADES_FILE, JSON.stringify(all, null, 2));
  return { saved: fresh.length, skipped: newTrades.length - fresh.length, total: all.length };
}

// ── Summary printer ───────────────────────────────────────────

export function printTradeLog(trades) {
  if (trades.length === 0) {
    console.log('  No trades in log.');
    return;
  }

  const wins     = trades.filter(t => t.result === 'win');
  const losses   = trades.filter(t => t.result === 'loss');
  const timeouts = trades.filter(t => t.result === 'timeout');
  const winRate  = (wins.length / trades.length * 100).toFixed(1);

  let totalPnL = 0;
  for (const t of trades) {
    if (t.result === 'win')    totalPnL += t.riskPoints * 2.0;
    else if (t.result === 'loss')   totalPnL -= t.riskPoints;
    else totalPnL += ((t.exitPrice - t.entry) * (t.direction === 'long' ? 1 : -1));
  }

  console.log('\n' + '═'.repeat(72));
  console.log('  CUMULATIVE TRADE LOG');
  console.log(`  ${trades[0].date}  →  ${trades[trades.length - 1].date}   (${trades.length} trades)`);
  console.log('═'.repeat(72));
  console.log(`  ${'#'.padEnd(4)} ${'Date'.padEnd(12)} ${'Time'.padEnd(8)} ${'Dir'.padEnd(6)} ${'TF'.padEnd(4)} ${'KZ'.padEnd(6)} ${'Entry'.padStart(9)} ${'Stop'.padStart(9)} ${'Target'.padStart(9)} ${'P&L'.padStart(9)} ${'Result'}`);
  console.log('  ' + '─'.repeat(68));

  for (let i = 0; i < trades.length; i++) {
    const t   = trades[i];
    const pnl = t.result === 'win'   ? +(t.riskPoints * 2.0).toFixed(2)
              : t.result === 'loss'  ? -(t.riskPoints).toFixed(2)
              : +((t.exitPrice - t.entry) * (t.direction === 'long' ? 1 : -1)).toFixed(2);
    const sym = t.result === 'win' ? '✓' : t.result === 'loss' ? '✗' : '~';
    const pnlStr = (pnl >= 0 ? '+' : '') + pnl.toFixed(2);
    console.log(`  ${String(i+1).padEnd(4)} ${t.date.padEnd(12)} ${t.time.padEnd(8)} ${t.direction.padEnd(6)} ${t.timeframe.padEnd(4)} ${(t.confluence?.killzone || '?').padEnd(6)} ${t.entry.toFixed(2).padStart(9)} ${t.stop.toFixed(2).padStart(9)} ${t.target1.toFixed(2).padStart(9)} ${pnlStr.padStart(9)} ${sym} ${t.result}`);
  }

  console.log('  ' + '─'.repeat(68));
  console.log(`  ${String(trades.length).padEnd(4)} ${'Total'.padEnd(12)} ${''.padEnd(8)} ${''.padEnd(6)} ${''.padEnd(4)} ${''.padEnd(6)} ${''.padStart(9)} ${''.padStart(9)} ${''.padStart(9)} ${((totalPnL >= 0 ? '+' : '') + totalPnL.toFixed(2)).padStart(9)}  Win: ${winRate}%  (${wins.length}W/${losses.length}L/${timeouts.length}T)`);
  console.log('═'.repeat(72) + '\n');
  console.log(`  Saved to: data/trades.json\n`);
}
