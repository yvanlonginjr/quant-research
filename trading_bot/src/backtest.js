// ============================================================
// BACKTEST.JS  —  1-min signal simulation from April 5 onward
// ============================================================
// Data collection:
//   Uses TradingView replay mode to walk from April 5 through
//   April 17, fetching 500 1-min bars at each checkpoint.
//   Bars from all checkpoints are deduplicated and sorted.
//
// Execution model:
//   ALL bars are evaluated — no killzone hard gate.
//   The sweep → MSS → FVG pipeline runs on every 1-min bar.
//   Trades flagged isPremiumTime=true (XX:45–XX:15) are treated
//   as higher-probability in the log but are not filtered.
//
// Higher timeframes (15m, 60m, 240m) are context only — they
// are NOT used for entry execution in this version.
// ============================================================

import { config }           from '../config.js';
import { createMcpClient }  from './mcp-client.js';
import { contractManager }  from './contract-manager.js';
import { CandleBuffer }     from './candle-buffer.js';
import { logger }           from './logger.js';
import {
  getCycleInfo,
  getPrevCycleHighLow,
  get30mHighLow,
  getPrev30mHighLow,
  getRecent10mHighLows,
  cycleLabel,
}                           from './engines/cycle-engine.js';
import { computeHTFBias, aggregateBars } from './engines/htf-engine.js';
import { getKeyLevels, levelsLabel }     from './engines/levels-engine.js';
import {
  getSessionHighLows,
  sessionLevelsLabel,
}                           from './engines/session-engine.js';
import {
  getKillzoneStatus,
  isPremiumWindow,
  toET,
}                           from './engines/killzone.js';
import {
  detectSweep,
  findMSS,
  findFVG,
  isPriceInFVG,
  isBarTouchingFVGTop,
}                           from './engines/fvg-detector.js';
import {
  getActiveHTFZones,
  fvgOverlapsZone,
}                           from './engines/htf-zone-manager.js';
import { saveTrades, printTradeLog }           from './trade-logger.js';
import { checkSMT, smtLabel }                 from './engines/smt-engine.js';
import { createRunDir, drawTradePosition, removeDrawings, captureTradeScreenshot, exportTradesToExcel, clearAllDrawings } from './trade-visualizer.js';

// ── Backtest config ───────────────────────────────────────────

const BT = {
  startDate:    '2026-04-05',   // replay start date (YYYY-MM-DD)
  endDate:      '2026-04-17',   // inclusive end date

  // At 1-min, 90 bars = 90 minutes = one full 90-min liquidity cycle
  maxHoldBars:  90,
};

// ── Main entry point ──────────────────────────────────────────

async function runBacktest() {
  console.log('\n' + '═'.repeat(66));
  console.log('  FRANK369-BOT  —  BACKTEST ENGINE  (1-min execution)');
  console.log(`  Instrument : ${contractManager.getSymbol('NQ')}`);
  console.log(`  Period     : ${BT.startDate}  →  ${BT.endDate}`);
  console.log(`  Note       : Higher TFs used for context only; entries on 1-min`);
  console.log('═'.repeat(66) + '\n');

  const runDir = createRunDir();

  let mcpClient;
  try {
    mcpClient = await createMcpClient();
  } catch (err) {
    logger.error(`MCP connection failed: ${err.message}`);
    logger.error('TradingView Desktop must be open.');
    process.exit(1);
  }

  const nqSymbol = contractManager.getSymbol('NQ');

  // Ensure chart is in live mode (not replay) before doing anything
  try {
    await mcpClient.call('replay_stop', {});
    await sleep(1500);
  } catch {}

  // Set to NQ 1-min
  try {
    await mcpClient.setSymbol(nqSymbol);
    await mcpClient.setTimeframe('1');
  } catch (err) {
    logger.warn(`Chart setup warning: ${err.message}`);
  }

  // ── Collect 1-min bars — NQ + ES + YM ───────────────────────
  logger.info(`\nCollecting 1-min bars for NQ, ES, YM (${BT.startDate} → ${BT.endDate})...`);
  // Stop any active replay and reset chart to live NQ 1-min before collection.
  // The previous run's screenshot scroll can leave the chart at a stale date.
  try { await mcpClient.call('replay_stop', {}); await sleep(1000); } catch {}
  let allBars, esBars, ymBars;
  try {
    // NQ (primary)
    await mcpClient.setSymbol(nqSymbol);
    await mcpClient.setTimeframe('1');
    await sleep(2000);
    allBars = await fetchHistoricalBars(mcpClient);

    // ES (SMT reference)
    logger.info('\n  Switching to ES for SMT data...');
    await mcpClient.setSymbol(contractManager.getSymbol('ES'));
    esBars = await fetchHistoricalBars(mcpClient);

    // YM (SMT reference)
    logger.info('\n  Switching to YM for SMT data...');
    await mcpClient.setSymbol(contractManager.getSymbol('YM'));
    ymBars = await fetchHistoricalBars(mcpClient);

    // Restore to NQ
    await mcpClient.setSymbol(nqSymbol);
    await mcpClient.setTimeframe(config.timeframe);
  } catch (err) {
    logger.error(`Historical bar collection failed: ${err.message}`);
    await mcpClient.disconnect();
    process.exit(1);
  }

  if (allBars.length < 50) {
    logger.error(`Only ${allBars.length} bars collected — not enough to backtest.`);
    await mcpClient.disconnect();
    process.exit(1);
  }

  const firstDate = formatDate(allBars[0].time);
  const lastDate  = formatDate(allBars[allBars.length - 1].time);
  logger.info(`\nBars collected: NQ=${allBars.length}  ES=${esBars.length}  YM=${ymBars.length}  |  ${firstDate} → ${lastDate}`);

  // ── Pre-aggregate 1H bars (no look-ahead — filtered per signal) ──
  const all1HBars = aggregateBars(allBars, 60);
  const es1HBars  = aggregateBars(esBars,  60);
  const ym1HBars  = aggregateBars(ymBars,  60);
  logger.info(`  1H bars: NQ=${all1HBars.length}  ES=${es1HBars.length}  YM=${ym1HBars.length}\n`);

  // ── Run simulation ────────────────────────────────────────
  logger.info('Running simulation...\n');
  const trades    = [];
  const firedKeys = new Set();

  const startIdx = Math.min(100, Math.floor(allBars.length * 0.02));

  for (let i = startIdx; i < allBars.length - BT.maxHoldBars - 1; i++) {
    const nowMs = allBars[i].time;
    const et    = toET(nowMs);

    // Build visible candle slice (no look-ahead)
    const visibleBars = allBars.slice(0, i + 1);
    const buf = new CandleBuffer('NQ_BT', 1000);
    buf.update(visibleBars);

    // Cycle info — skip dead zone (4–6 PM ET) and pre-anchor
    const cycleInfo = getCycleInfo(nowMs);
    if (cycleInfo.isDeadZone || cycleInfo.isPreAnchor) continue;

    const prevHL     = getPrevCycleHighLow(buf, cycleInfo);
    if (!prevHL || prevHL.barCount < config.sweep.qualityMinPrevBars) continue;

    const cur30mHL   = get30mHighLow(buf, cycleInfo);
    const prev30mHL  = getPrev30mHighLow(buf, cycleInfo);
    const recent10m  = getRecent10mHighLows(buf, cycleInfo);
    const sessionHL  = getSessionHighLows(buf, nowMs);

    // Asia session: compute levels for analysis but skip trade entries
    if (sessionHL?.currentSession === config.sessionFilter.noTradeSession) continue;

    // TOI hard gate — XX:45–XX:15 only
    if (config.toi.enabled && !isPremiumWindow(nowMs)) continue;

    // ── HTF context (metadata + legacy bias score) ────────────
    const keyLevels  = getKeyLevels(visibleBars, cycleInfo);
    const nq1HNow    = all1HBars.filter(b => b.time <= nowMs);
    const es1HNow    = es1HBars.filter(b => b.time <= nowMs);
    const ym1HNow    = ym1HBars.filter(b => b.time <= nowMs);
    const htfResult  = computeHTFBias(nq1HNow, es1HNow, ym1HNow, cycleInfo, sessionHL, keyLevels, nowMs);
    const htfBias    = htfResult.bias;

    // ── GATE 1 — 1H PD Zone precondition (TOP-DOWN entry point) ──
    // Price must be AT an active 1H Breaker Block, Order Block, or
    // Fair Value Gap before anything downstream is evaluated.
    // This is the architectural fix: zone-first, not sweep-first.
    const currentPrice = allBars[i].close;
    const activeZones  = config.htfZone.enabled
      ? getActiveHTFZones(nq1HNow, currentPrice)
      : [];
    if (config.htfZone.enabled && activeZones.length === 0) continue;

    // ── Sweep — try 10m → 30m → 90m (most granular wins) ──
    const prev10mHL = recent10m[1];
    const sweep10m  = (prev10mHL && cycleInfo.sub10)
      ? detectSweep(visibleBars, cycleInfo.sub10.startMs, prev10mHL.high, prev10mHL.low)
      : { found: false };

    const sweep30m  = (prev30mHL && cycleInfo.sub30)
      ? detectSweep(visibleBars, cycleInfo.sub30.startMs, prev30mHL.high, prev30mHL.low)
      : { found: false };

    const sweep90m  = detectSweep(visibleBars, cycleInfo.cycleStartMs, prevHL.high, prevHL.low);

    const sweep = sweep10m.found ? { ...sweep10m, sweepTimeframe: '10m' }
                : sweep30m.found ? { ...sweep30m, sweepTimeframe: '30m' }
                : sweep90m.found ? { ...sweep90m, sweepTimeframe: '90m' }
                : { found: false };

    if (!sweep.found) continue;

    // ── GATE 2 — Zone-direction match ─────────────────────────
    // The sweep direction must align with a zone's predicted direction.
    // Long sweep → need a bullish zone (support holding).
    // Short sweep → need a bearish zone (resistance holding).
    const zoneDirection = sweep.direction === 'long' ? 'bullish' : 'bearish';
    const matchingZone  = config.htfZone.enabled
      ? activeZones.find(z => z.direction === zoneDirection)
      : null;
    if (config.htfZone.enabled && !matchingZone) continue;

    const mss = findMSS(visibleBars, sweep.direction, sweep.sweepCandleIndex);
    if (!mss.found) continue;

    const fvg = findFVG(visibleBars, sweep.direction, mss.index);
    if (!fvg.found) continue;

    // ── GATE 3 — Spatial FVG overlap with 1H zone ─────────────
    // The 1m FVG must physically sit inside or adjacent to the 1H
    // zone.  Without this, the bot accepts FVGs anywhere regardless
    // of whether they're in institutional territory.
    if (config.htfZone.enabled && !fvgOverlapsZone(fvg, matchingZone)) continue;

    // ── GATE 4 — Intrabar FVG top touch (limit order simulation) ─
    // Entry is a limit order at the FVG boundary, filled when the
    // bar's wick reaches that level — not when the bar CLOSES there.
    // This captures Trade 2 (Apr 13 11:07): "price never truly tapped
    // into the FVG" — the bar wicked to the FVG top and closed back up.
    if (!isBarTouchingFVGTop(allBars[i], fvg)) continue;

    // ── GATE 5 — 1H momentum bias (counter-trend killer) ─────────
    // Checks the last 4 completed 1H bars at signal time.
    // If 3+ are bullish candles → day is bullish → reject shorts.
    // If 3+ are bearish candles → day is bearish → reject longs.
    // Neutral (mixed) → allow both directions.
    //
    // This kills the Apr 13 shorts: 1H was printing consecutive
    // large bullish candles all morning while the bot tried to short
    // a Bear Breaker zone — textbook counter-trend.
    const momentumBias = get1HMomentumBias(nq1HNow);
    if (momentumBias === 'bullish' && sweep.direction === 'short') continue;
    if (momentumBias === 'bearish' && sweep.direction === 'long')  continue;

    // SMT divergence check (confluence flag — not a hard gate)
    const smt = checkSMT(esBars, ymBars, cycleInfo, sweep);

    // Dedup: one signal per date × cycle × 30m-slot × direction
    const dateStr = `${et.year}-${String(et.month).padStart(2,'0')}-${String(et.day).padStart(2,'0')}`;
    const key     = `${dateStr}_C${cycleInfo.cycleIndex}_s${cycleInfo.sub30?.index ?? 0}_${sweep.direction}`;
    if (firedKeys.has(key)) continue;
    firedKeys.add(key);

    // ── Entry: limit at FVG boundary (intrabar fill simulation) ──
    // Long: limit sell at fvgHigh — filled when bar.low <= fvgHigh
    // Short: limit sell at fvgLow  — filled when bar.high >= fvgLow
    const entry = fvg.direction === 'long' ? fvg.fvgHigh : fvg.fvgLow;

    // ── Stop: beyond the prior candle (candle before FVG forms) ──
    let stop;
    if (sweep.direction === 'long') {
      const priorLow = fvg.priorCandle ? fvg.priorCandle.low : sweep.sweepCandle.low;
      stop = priorLow - config.risk.stopBufferPoints;
    } else {
      const priorHigh = fvg.priorCandle ? fvg.priorCandle.high : sweep.sweepCandle.high;
      stop = priorHigh + config.risk.stopBufferPoints;
    }

    const riskPoints = Math.abs(entry - stop);
    if (riskPoints <= 0) continue;

    // Geometric validity
    if (sweep.direction === 'long'  && stop >= entry) continue;
    if (sweep.direction === 'short' && stop <= entry) continue;

    // Minimum risk filter — reject noise setups with tiny stops
    if (riskPoints < config.risk.minRiskPoints) continue;

    // HTF directional hard filter
    if (config.htfBias.enabled && config.htfBias.mode === 'hard') {
      if (htfBias === 'bullish' && sweep.direction === 'short') continue;
      if (htfBias === 'bearish' && sweep.direction === 'long')  continue;
    }


    // ── Targets: A = prev-cycle opposite extreme, B = A extended ──
    // A (target1) = the other side of the previous cycle range.
    // Enforces a minimum of 1.5R so marginal setups are filtered.
    // B (target2) = A extended by 50% of the A distance.
    let target1, target2;
    const minT1Dist = riskPoints * 1.5;

    if (sweep.direction === 'long') {
      const natural = prevHL.high;
      target1 = (natural - entry >= minT1Dist) ? natural : entry + minT1Dist;
      target2 = target1 + (target1 - entry) * 0.5;
    } else {
      const natural = prevHL.low;
      target1 = (entry - natural >= minT1Dist) ? natural : entry - minT1Dist;
      target2 = target1 - (entry - target1) * 0.5;
    }

    const rr = Math.abs(entry - target1) / riskPoints;
    if (rr < config.risk.minRR) continue;

    const kz           = getKillzoneStatus(nowMs);
    const premiumTime  = isPremiumWindow(nowMs);

    const outcome = simulateOutcome(allBars, i + 1, sweep.direction, stop, target1, target2);

    const trade = {
      id:            key + '_1m',
      date:          dateStr,
      time:          formatTime(nowMs),
      timestamp:     nowMs,
      timeframe:     '1',
      cycleIndex:    cycleInfo.cycleIndex,
      direction:     sweep.direction,
      entry,
      stop,
      target1,
      target2,
      rr,
      riskPoints,
      sweepType:      sweep.sweepType,
      sweepStyle:     sweep.sweepStyle,
      sweepTimeframe: sweep.sweepTimeframe,
      sweepQuality:   isPremiumWindow(nowMs) ? 'high' : 'medium',
      mssType:       mss.mssType,
      fvgQuality:    fvgQualityLabel(fvg.gapSize),
      prevH:         prevHL.high,
      prevL:         prevHL.low,
      fvgLow:        fvg.fvgLow,
      fvgHigh:       fvg.fvgHigh,
      isPremiumTime: premiumTime,
      confluence: {
        killzone: kz.active ? kz.name : sessionLabel(nowMs),
      },
      sub30: cycleInfo.sub30
        ? { index: cycleInfo.sub30.index, high: cur30mHL?.high, low: cur30mHL?.low,
            prevHigh: prev30mHL?.high, prevLow: prev30mHL?.low }
        : null,
      sub10: cycleInfo.sub10
        ? { index: cycleInfo.sub10.index,
            recent: recent10m.map(r => r ? { high: r.high, low: r.low } : null) }
        : null,
      cycleLabel:  cycleLabel(cycleInfo),
      htfBias,
      htfScore:    htfResult.score,
      htfReasons:  htfResult.reasons,
      dol:         htfResult.dol,
      keyLevels,
      sessionHL,
      smt,
      activeZone:  matchingZone ?? null,
      allZones:    activeZones,
      ...outcome,
    };

    trades.push(trade);
    logTrade(trade, trades.length);
  }

  // ── Draw trades + screenshot + Excel ─────────────────────
  if (trades.length > 0) {
    logger.info('\n── Drawing trades on TradingView ──');
    try { await mcpClient.setTimeframe('1'); } catch {}

    for (const t of trades) {
      const entityIds = await drawTradePosition(mcpClient, t);
      t.screenshotPath = await captureTradeScreenshot(mcpClient, t, runDir);
      await removeDrawings(mcpClient, entityIds);
    }
    try { await mcpClient.setTimeframe(config.timeframe); } catch {}
    await exportTradesToExcel(trades, runDir);
  }

  await mcpClient.disconnect();

  // ── Save and print ────────────────────────────────────────
  if (trades.length > 0) {
    const r = saveTrades(trades);
    logger.info(`\nTrade file: +${r.saved} new  |  skipped ${r.skipped} dupes  |  total: ${r.total}`);
  }

  printMetrics(trades, `${firstDate} → ${lastDate}`, allBars.length);
  if (trades.length > 0) printTradeLog(trades);
}

// ── Historical bar collection via replay snapshots ────────────
//
// Key insight: replay_start(D) loads ~800-1100 1-min bars ending at
// the START of date D (UTC midnight).  So calling replay_start(D+1)
// loads day D's full session bars as history.  No autoplay required.
//
// We iterate replay_start for each date from startDate+1 to endDate+2,
// collecting all bars in the target window.  Total time: ~60 seconds.
//
async function fetchHistoricalBars(mcpClient) {
  const startMs = Date.parse(BT.startDate + 'T00:00:00-04:00');
  const endMs   = Date.parse(BT.endDate   + 'T23:59:59-04:00');

  const allBarsMap = new Map();

  // Build list of replay dates: from (startDate + 1 day) through (endDate + 2 days)
  // replay_start(D) loads bars ending at D, covering the previous ~14-18 hours.
  const replayDates = buildDateList(BT.startDate, BT.endDate);
  logger.info(`  Fetching via ${replayDates.length} replay snapshots...`);

  for (const replayDate of replayDates) {
    try {
      await mcpClient.call('replay_start', { date: replayDate });
      await sleep(1500);

      const bars = await mcpClient.getOhlcv(1500);
      let added = 0;
      for (const bar of bars) {
        if (bar.time >= startMs && bar.time <= endMs && !allBarsMap.has(bar.time)) {
          allBarsMap.set(bar.time, bar);
          added++;
        }
      }

      const maxT = bars.length ? Math.max(...bars.map(b => b.time)) : 0;
      logger.info(`  snapshot(${replayDate}): ${bars.length} bars loaded | +${added} new  (total: ${allBarsMap.size})`);
    } catch (err) {
      logger.warn(`  snapshot(${replayDate}) failed: ${err.message.slice(0, 80)}`);
    }
  }

  try {
    await mcpClient.call('replay_stop', {});
    await sleep(1000);
  } catch {}

  if (allBarsMap.size === 0) {
    logger.warn('  Replay returned no bars — falling back to live 500-bar fetch');
    return mcpClient.getOhlcv(500);
  }

  return Array.from(allBarsMap.values()).sort((a, b) => a.time - b.time);
}

// Returns array of YYYY-MM-DD strings: one date per calendar day
// from (startDate + 1) through (endDate + 2) inclusive.
function buildDateList(startDate, endDate) {
  const dates = [];
  const start = new Date(startDate + 'T12:00:00Z');
  const end   = new Date(endDate   + 'T12:00:00Z');
  start.setUTCDate(start.getUTCDate() + 1); // start+1
  end.setUTCDate(end.getUTCDate() + 2);     // end+2
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

// ── Outcome simulation (partial exit model) ───────────────────
//
// Half position exits at T1 (A target). Second half runs to T2 (B).
// Results:
//   'win'     — both T1 and T2 hit
//   'partial' — T1 hit, T2 missed (stopped or timed out)
//   'loss'    — stopped before T1
//   'timeout' — T1 never hit, time exit
//
// exit2Price is the second-half exit (T2, stop, or timeout close).
function simulateOutcome(allBars, fromIdx, direction, stop, target1, target2) {
  const limit  = Math.min(fromIdx + BT.maxHoldBars, allBars.length);
  let t1Hit    = false;

  for (let j = fromIdx; j < limit; j++) {
    const bar = allBars[j];

    if (direction === 'long') {
      if (bar.low <= stop) {
        if (t1Hit) return { result: 'partial', exitPrice: target1, exit2Price: stop };
        return { result: 'loss', exitPrice: stop };
      }
      if (!t1Hit && bar.high >= target1) t1Hit = true;
      if (t1Hit  && bar.high >= target2) return { result: 'win', exitPrice: target1, exit2Price: target2 };
    } else {
      if (bar.high >= stop) {
        if (t1Hit) return { result: 'partial', exitPrice: target1, exit2Price: stop };
        return { result: 'loss', exitPrice: stop };
      }
      if (!t1Hit && bar.low <= target1) t1Hit = true;
      if (t1Hit  && bar.low <= target2)  return { result: 'win', exitPrice: target1, exit2Price: target2 };
    }
  }

  const closePrice = allBars[Math.min(fromIdx + BT.maxHoldBars - 1, allBars.length - 1)].close;
  if (t1Hit) return { result: 'partial', exitPrice: target1, exit2Price: closePrice };
  return { result: 'timeout', exitPrice: closePrice };
}

// ── Per-trade console line ────────────────────────────────────

function calcPnl(t) {
  const sign = t.direction === 'long' ? 1 : -1;
  if (t.result === 'win') {
    return 0.5 * (t.target1 - t.entry) * sign + 0.5 * (t.target2 - t.entry) * sign;
  }
  if (t.result === 'partial') {
    return 0.5 * (t.target1 - t.entry) * sign + 0.5 * (t.exit2Price - t.entry) * sign;
  }
  if (t.result === 'loss') return -t.riskPoints;
  return (t.exitPrice - t.entry) * sign;  // timeout
}

function logTrade(t, num) {
  const arrow   = t.direction === 'long' ? '▲' : '▼';
  const sym     = t.result === 'win' ? '✓' : t.result === 'loss' ? '✗' : t.result === 'partial' ? '½' : '~';
  const premium = t.isPremiumTime ? ' ★' : '  ';
  const pnl     = calcPnl(t);

  console.log(
    `  ${String(num).padStart(3)}. ${sym} ${arrow}${premium}${t.direction.padEnd(5)} ` +
    `${t.date} ${t.time}  ${(t.cycleLabel || `C#${t.cycleIndex}`).padEnd(18)}  ` +
    `${(t.confluence?.killzone || '?').padEnd(8)}  ` +
    `entry:${t.entry.toFixed(2).padStart(9)}  ` +
    `stop:${t.stop.toFixed(2).padStart(9)}  ` +
    `tgt:${t.target1.toFixed(2).padStart(9)}  ` +
    `pnl: ${(pnl >= 0 ? '+' : '') + pnl.toFixed(2).padStart(7)} pts`
  );
  if (t.activeZone) {
    console.log(`       Zone: ${t.activeZone.label}  [${t.activeZone.low.toFixed(0)}–${t.activeZone.high.toFixed(0)}]`);
  }
  if (t.sessionHL) {
    console.log(`       Session levels: ${sessionLevelsLabel(t.sessionHL)}`);
  }
  if (t.dol) {
    console.log(`       DOL: ${t.dol.direction} @ ${t.dol.type} ${t.dol.price.toFixed(0)}  (HTF score: ${t.htfScore >= 0 ? '+' : ''}${t.htfScore})`);
  }
  if (t.htfReasons?.length) {
    console.log(`       HTF: ${t.htfReasons.join(' | ')}`);
  }
  const tags = [
    t.htfBias ? `bias:${t.htfBias}` : null,
    t.sweepTimeframe ? `swept:${t.sweepTimeframe}` : null,
    t.sweepQuality ? `q:${t.sweepQuality}` : null,
    t.fvgQuality   ? `fvg:${t.fvgQuality}` : null,
    t.smt?.active  ? smtLabel(t.smt) : null,
  ].filter(Boolean);
  if (tags.length) console.log(`       ${tags.join('  ')}`);
}

// ── Metrics summary ───────────────────────────────────────────

function printMetrics(trades, period, totalBars) {
  if (trades.length === 0) {
    console.log('\n' + '═'.repeat(66));
    console.log('  NO SIGNALS FOUND.');
    console.log('  Possible causes: bars entirely overnight, very low volatility,');
    console.log('  or sweep threshold too wide. Check config.sweep.thresholdPoints.');
    console.log('═'.repeat(66) + '\n');
    return;
  }

  const wins     = trades.filter(t => t.result === 'win');
  const partials = trades.filter(t => t.result === 'partial');
  const losses   = trades.filter(t => t.result === 'loss');
  const timeouts = trades.filter(t => t.result === 'timeout');
  // Win rate counts full wins + partials as "made money on T1"
  const positiveCount = wins.length + partials.length;
  const winRate = (positiveCount / trades.length * 100).toFixed(1);

  const totalPnL = trades.reduce((s, t) => s + calcPnl(t), 0);

  const gp = trades.reduce((s, t) => { const p = calcPnl(t); return s + (p > 0 ? p : 0); }, 0);
  const gl = trades.reduce((s, t) => { const p = calcPnl(t); return s + (p < 0 ? -p : 0); }, 0);
  const pf = gl > 0 ? (gp / gl).toFixed(2) : '∞';

  let maxCL = 0, curC = 0;
  for (const t of trades) {
    if (t.result === 'loss' || t.result === 'timeout') { curC++; maxCL = Math.max(maxCL, curC); }
    else curC = 0;
  }

  const isWinish = t => t.result === 'win' || t.result === 'partial';
  const premTrades = trades.filter(t => t.isPremiumTime);
  const premWins   = premTrades.filter(isWinish);
  const longT  = trades.filter(t => t.direction === 'long');
  const shortT = trades.filter(t => t.direction === 'short');

  console.log('\n' + '═'.repeat(66));
  console.log('  BACKTEST RESULTS  —  1-min execution  (50% partial @ T1)');
  console.log(`  Period         : ${period}`);
  console.log(`  Total 1-min bars : ${totalBars}`);
  console.log(`  Instrument     : ${contractManager.getSymbol('NQ')}`);
  console.log('═'.repeat(66));
  console.log(`  Total signals  : ${trades.length}  (${wins.length}W / ${partials.length}½ / ${losses.length}L / ${timeouts.length} timeout)`);
  console.log(`  T1 hit rate    : ${winRate}%  (wins + partials)`);
  console.log(`  Profit factor  : ${pf}`);
  console.log(`  Max consec L   : ${maxCL}`);
  console.log(`  Total P&L      : ${totalPnL >= 0 ? '+' : ''}${totalPnL.toFixed(2)} pts  ($${(totalPnL * 20).toFixed(0)} / contract)`);
  console.log('─'.repeat(66));
  console.log(`  ★ Premium time : ${premTrades.length} trades  |  T1: ${premTrades.length ? (premWins.length/premTrades.length*100).toFixed(0) : 0}%`);
  console.log(`  Non-premium    : ${trades.length - premTrades.length} trades  |  T1: ${(trades.length-premTrades.length) ? ((positiveCount-premWins.length)/(trades.length-premTrades.length)*100).toFixed(0) : 0}%`);
  console.log('─'.repeat(66));
  console.log(`  Long           : ${longT.length} trades  |  T1: ${longT.length ? (longT.filter(isWinish).length/longT.length*100).toFixed(0) : 0}%`);
  console.log(`  Short          : ${shortT.length} trades  |  T1: ${shortT.length ? (shortT.filter(isWinish).length/shortT.length*100).toFixed(0) : 0}%`);
  console.log('═'.repeat(66) + '\n');
}

// ── Helpers ───────────────────────────────────────────────────

// FVG quality label based on gap size
function fvgQualityLabel(gapSize) {
  if (!gapSize) return 'unknown';
  if (gapSize >= config.fvg.largeGapPoints)  return 'large';
  if (gapSize >= config.fvg.smallGapPoints)  return 'medium';
  return 'small';
}


function sessionLabel(utcMs) {
  const { minuteOfDay } = toET(utcMs);
  if (minuteOfDay >= 570  && minuteOfDay < 690)  return 'NY AM';     // 9:30–11:30
  if (minuteOfDay >= 690  && minuteOfDay < 780)  return 'Lunch';     // 11:30–1:00
  if (minuteOfDay >= 780  && minuteOfDay < 960)  return 'NY PM';     // 1:00–4:00
  if (minuteOfDay >= 960  && minuteOfDay < 1080) return 'Dead Zone'; // 4:00–6:00 PM
  if (minuteOfDay >= 1080 || minuteOfDay < 120)  return 'Asia';      // 6 PM–2 AM
  if (minuteOfDay >= 120  && minuteOfDay < 420)  return 'London';    // 2–7 AM
  return 'Pre-NY';                                                    // 7–9:30 AM
}

function formatDate(utcMs) {
  const et = toET(utcMs);
  return `${et.year}-${String(et.month).padStart(2,'0')}-${String(et.day).padStart(2,'0')}`;
}

function formatTime(utcMs) {
  if (!utcMs) return '??:??';
  const et = toET(utcMs);
  return `${String(et.hour).padStart(2,'0')}:${String(et.minute).padStart(2,'0')} ET`;
}

// ── 1H momentum bias ─────────────────────────────────────────
// Looks at the last 4 completed 1H bars.
// 3+ bullish bodies → 'bullish'  (block shorts)
// 3+ bearish bodies → 'bearish'  (block longs)
// Mixed → 'neutral'
function get1HMomentumBias(nq1HBars) {
  if (!nq1HBars || nq1HBars.length < 4) return 'neutral';
  const recent = nq1HBars.slice(-4);
  let bull = 0, bear = 0;
  for (const b of recent) {
    if (b.close > b.open) bull++;
    else if (b.close < b.open) bear++;
  }
  if (bull >= 3) return 'bullish';
  if (bear >= 3) return 'bearish';
  return 'neutral';
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}


// ── Run ───────────────────────────────────────────────────────

runBacktest().catch(err => {
  console.error('Backtest error:', err.message);
  process.exit(1);
});
