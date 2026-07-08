// ============================================================
// LOGGER  —  Color-coded, timestamped console output
// ============================================================
// Uses chalk (ESM v5) for ANSI colors.
// Each severity level has a distinct color so signals, warnings,
// and errors are immediately visible when tailing the terminal.
//
// Log levels:
//   info    → white/grey  — routine status messages
//   debug   → dim         — verbose data (poll results, candle counts)
//   warn    → yellow      — non-fatal issues (SMT unavailable, etc.)
//   error   → red         — failures that need attention
//   signal  → bright cyan — trade signal fired (most important line)
//   cycle   → blue        — cycle boundary events
//   kill    → magenta     — kill-switch or session-cap events
// ============================================================

import chalk from 'chalk';

// Eastern Time formatter for log timestamps
const etFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour:     '2-digit',
  minute:   '2-digit',
  second:   '2-digit',
  hour12:   false,
});

function ts() {
  return chalk.dim(`[${etFormatter.format(new Date())} ET]`);
}

export const logger = {
  info(msg, ...args) {
    console.log(`${ts()} ${chalk.white(msg)}`, ...args);
  },

  debug(msg, ...args) {
    console.log(`${ts()} ${chalk.dim(msg)}`, ...args);
  },

  warn(msg, ...args) {
    console.warn(`${ts()} ${chalk.yellow('⚠ WARN')} ${chalk.yellow(msg)}`, ...args);
  },

  error(msg, ...args) {
    console.error(`${ts()} ${chalk.red('✖ ERROR')} ${chalk.red(msg)}`, ...args);
  },

  // ── Signal fires — the most important log line ──
  signal(direction, entry, stop, target1, target2, rr, confluence) {
    const arrow   = direction === 'long' ? '▲ LONG' : '▼ SHORT';
    const color   = direction === 'long' ? chalk.greenBright : chalk.redBright;
    const risk    = Math.abs(entry - stop);

    console.log('');
    console.log(chalk.cyanBright('═'.repeat(70)));
    console.log(`${ts()} ${color.bold(arrow)}  ${chalk.cyanBright('SIGNAL FIRED')}`);
    console.log(chalk.cyanBright('─'.repeat(70)));
    console.log(`  Entry   : ${chalk.white(entry.toFixed(2))}`);
    console.log(`  Stop    : ${chalk.red(stop.toFixed(2))}  (risk ${risk.toFixed(2)} pts)`);
    console.log(`  Target1 : ${chalk.green(target1.toFixed(2))}  (${rr.toFixed(1)}R)`);
    console.log(`  Target2 : ${chalk.green(target2.toFixed(2))}  (extension)`);
    console.log(`  R:R     : ${chalk.yellow(rr.toFixed(2) + ':1')}`);
    console.log(chalk.cyanBright('─'.repeat(70)));
    console.log(`  Killzone: ${confluence.killzone}`);
    console.log(`  Cycle   : #${confluence.cycleIndex}  prev H:${confluence.prevCycleHigh?.toFixed(2)}  prev L:${confluence.prevCycleLow?.toFixed(2)}`);
    console.log(`  Sweep   : ${confluence.sweepType}  @ ${confluence.sweepLevel?.toFixed(2)}`);
    console.log(`  FVG     : [${confluence.fvg?.low?.toFixed(2)} – ${confluence.fvg?.high?.toFixed(2)}]`);
    const smtStr = confluence.smt?.active
      ? `YES — ES:${confluence.smt.esDiverged ? 'diverged' : 'confirmed'}  YM:${confluence.smt.ymDiverged ? 'diverged' : 'confirmed'}`
      : confluence.smt?.active === false ? 'NO divergence' : 'N/A (unavailable)';
    console.log(`  SMT     : ${smtStr}`);
    console.log(chalk.cyanBright('═'.repeat(70)));
    console.log('');
  },

  // ── Cycle boundary announcement ──
  cycle(index, startET, highStr, lowStr) {
    console.log(`${ts()} ${chalk.blue('◆ CYCLE')} #${index} start ${startET}  prevH:${highStr}  prevL:${lowStr}`);
  },

  // ── Kill-switch / session cap triggered ──
  kill(reason) {
    console.log(`${ts()} ${chalk.magenta('⛔ KILL')} ${chalk.magenta(reason)}`);
  },
};
