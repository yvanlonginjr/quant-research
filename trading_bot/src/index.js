// ============================================================
// INDEX.JS  —  Main loop and orchestration
// ============================================================
// This is the entry point for frank369-bot.
//
// Boot sequence:
//   1. Connect to TradingView MCP server (stdio subprocess)
//   2. Run health check — abort if TradingView is not open
//   3. Set chart to NQ1! at 1-min timeframe
//   4. Start main poll loop (every config.pollIntervalMs)
//   5. Start SMT poll loop (slower, switches chart to ES/YM)
//
// Main loop (NQ data → signal pipeline):
//   • Fetch latest 300 1-min candles for NQ
//   • Update NQ candle buffer
//   • Run signal engine (all condition layers)
//   • Log result
//
// SMT loop (ES & YM reference data):
//   • Switch chart to ES → fetch candles → restore NQ
//   • Switch chart to YM → fetch candles → restore NQ
//   • Update SmtDetector buffers
//
// ── PHASE 2 HOOK — Claude AI HTF context ─────────────────────
// After the health check, add a call to the Claude AI scoring
// module that reads the Daily and Weekly NQ chart and returns
// a directional bias. Feed this into the SignalEngine so only
// signals aligned with the HTF trend are fired.
//
// Wire-up location:
//   import { getHtfBias } from './ai/htf-scorer.js';  // Phase 2
//   const htfBias = await getHtfBias(mcpClient);       // Phase 2
//   signalEngine.setHtfBias(htfBias);                  // Phase 2
//
// The AI scorer will use the TradingView MCP to read pine scripts
// or OHLCV data on higher timeframes and call Claude API with
// structured market context.
// END PHASE 2 HOOK ────────────────────────────────────────────
// ============================================================

import { config }          from '../config.js';
import { createMcpClient }  from './mcp-client.js';
import { CandleBuffer }     from './candle-buffer.js';
import { logger }           from './logger.js';
import { SignalEngine }     from './engines/signal-engine.js';
import { SmtDetector }      from './engines/smt-detector.js';
import { getCycleInfo, cycleStartLabel } from './engines/cycle-engine.js';
import { getKillzoneStatus } from './engines/killzone.js';
import { contractManager }  from './contract-manager.js';

// ── Module-level state ────────────────────────────────────────

let mcpClient    = null;
let isShuttingDown = false;

const nqBuffer     = new CandleBuffer(config.instruments.primary, 500);
const signalEngine = new SignalEngine();
const smtDetector  = new SmtDetector();

// Track last cycle index so we can log cycle boundary announcements
let lastAnnouncedCycleIndex = -1;

// ── Boot ──────────────────────────────────────────────────────

async function boot() {
  logger.info('══════════════════════════════════════════════');
  logger.info('  frank369-bot v1.0  —  369 Model Signal Bot  ');
  logger.info('  Instrument: NQ1!  |  Timeframe: 1-min       ');
  logger.info('  Output: Console signals (no execution)       ');
  logger.info('══════════════════════════════════════════════');

  // Connect MCP client
  logger.info('Connecting to TradingView MCP server...');
  try {
    mcpClient = await createMcpClient();
  } catch (err) {
    logger.error(`Failed to connect to MCP server: ${err.message}`);
    logger.error('Is TradingView Desktop open with --remote-debugging-port=9222?');
    process.exit(1);
  }

  // Health check
  logger.info('Running health check...');
  let health;
  try {
    health = await mcpClient.healthCheck();
  } catch (err) {
    logger.error(`Health check failed: ${err.message}`);
    await mcpClient.disconnect();
    process.exit(1);
  }

  if (!health.ok) {
    logger.error('TradingView health check returned not-ok. Check the TradingView window.');
    logger.error(JSON.stringify(health.raw, null, 2));
    await mcpClient.disconnect();
    process.exit(1);
  }
  logger.info(`Health check PASSED — chart: ${health.symbol} @ ${health.resolution}`);

  // ── PHASE 2 HOOK — HTF AI Scorer init ────────────────────
  // Add here: await initHtfScorer(mcpClient);
  // END PHASE 2 HOOK ────────────────────────────────────────

  // Set chart to the active NQ front-month contract at configured timeframe
  const nqSymbol = contractManager.getSymbol('NQ');
  logger.info(`Setting chart → ${nqSymbol} / ${config.timeframe}min`);
  try {
    await mcpClient.setSymbol(nqSymbol);
    await mcpClient.setTimeframe(config.timeframe);
  } catch (err) {
    logger.warn(`Chart setup warning: ${err.message} — continuing anyway`);
  }

  // Log active contracts and next roll date
  contractManager.logStatus(logger);

  logger.info('Startup complete. Beginning poll loops...\n');

  // Start loops
  mainLoop();
  smtLoop();

  // Graceful shutdown on Ctrl+C
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
}

// ── Main poll loop (NQ data + signal engine) ──────────────────

async function mainLoop() {
  while (!isShuttingDown) {
    try {
      await tick();
    } catch (err) {
      logger.error(`Main loop error: ${err.message}`);
    }
    await sleep(config.pollIntervalMs);
  }
}

async function tick() {
  const nowMs = Date.now();

  // Check if a contract roll has occurred since last tick
  const rolled = contractManager.checkForRolls(nowMs);
  if (rolled.length > 0) {
    const nqNew = contractManager.getSymbol('NQ', nowMs);
    logger.info(`Contract roll detected: ${rolled.join(', ')} → switching chart to ${nqNew}`);
    try {
      await mcpClient.setSymbol(nqNew);
      await mcpClient.setTimeframe(config.timeframe);
    } catch (err) {
      logger.warn(`Roll chart switch failed: ${err.message}`);
    }
    // Clear candle buffer on roll — old contract data is not relevant
    nqBuffer.bars.length = 0;
  }

  // Fetch fresh NQ candles from TradingView
  const bars = await mcpClient.getOhlcv(config.cycle.historyBars);
  if (bars.length === 0) {
    logger.warn('No NQ candles returned — chart may be loading');
    return;
  }
  nqBuffer.update(bars);

  // Announce cycle boundary if we just crossed into a new cycle
  const cycleInfo = getCycleInfo(nowMs);
  if (cycleInfo.cycleIndex !== lastAnnouncedCycleIndex) {
    lastAnnouncedCycleIndex = cycleInfo.cycleIndex;
    const prevHL = nqBuffer.rangeHighLow(cycleInfo.prevCycleStartMs, cycleInfo.prevCycleEndMs);
    const prevH  = prevHL?.high?.toFixed(2)  ?? '—';
    const prevL  = prevHL?.low?.toFixed(2)   ?? '—';
    logger.cycle(cycleInfo.cycleIndex, cycleStartLabel(cycleInfo.cycleIndex), prevH, prevL);
  }

  // Check killzone status briefly for status logging
  const kzStatus = getKillzoneStatus(nowMs);

  // Run the full signal evaluation pipeline
  const smtResult = smtDetector.checkDivergence(
    nqBuffer.rangeHighLow(cycleInfo.prevCycleStartMs, cycleInfo.prevCycleEndMs)?.high,
    nqBuffer.rangeHighLow(cycleInfo.prevCycleStartMs, cycleInfo.prevCycleEndMs)?.low,
    cycleInfo.prevCycleStartMs,
    cycleInfo.prevCycleEndMs,
    'short', // direction is determined inside signal engine; pass both and let it decide
  );

  signalEngine.evaluate(nqBuffer, smtResult, nowMs);
}

// ── SMT poll loop (ES and YM reference data) ──────────────────

async function smtLoop() {
  // Initial delay to let main loop settle first
  await sleep(config.smtPollIntervalMs);

  while (!isShuttingDown) {
    if (config.smt.enabled) {
      await fetchSmtData();
    }
    await sleep(config.smtPollIntervalMs);
  }
}

async function fetchSmtData() {
  const nowMs    = Date.now();
  const symbols  = contractManager.getAllSymbols(nowMs);

  // ── ES ──
  try {
    await mcpClient.setSymbol(symbols.ES);
    const esBars = await mcpClient.getOhlcv(config.cycle.historyBars);
    smtDetector.updateES(esBars);
    logger.debug(`SMT: ${symbols.ES} updated (${esBars.length} bars)`);
  } catch (err) {
    logger.warn(`SMT: ES data fetch failed — ${err.message}`);
  }

  // ── YM ──
  try {
    await mcpClient.setSymbol(symbols.YM);
    const ymBars = await mcpClient.getOhlcv(config.cycle.historyBars);
    smtDetector.updateYM(ymBars);
    logger.debug(`SMT: ${symbols.YM} updated (${ymBars.length} bars)`);
  } catch (err) {
    logger.warn(`SMT: YM data fetch failed — ${err.message}`);
  }

  // Always restore NQ as the primary chart
  try {
    await mcpClient.setSymbol(symbols.NQ);
    await mcpClient.setTimeframe(config.timeframe);
  } catch (err) {
    logger.error(`Failed to restore ${symbols.NQ} chart after SMT fetch: ${err.message}`);
  }
}

// ── Graceful shutdown ─────────────────────────────────────────

async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info('\nShutting down frank369-bot...');
  if (mcpClient) {
    try { await mcpClient.disconnect(); } catch {}
  }
  process.exit(0);
}

// ── Utility ───────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Launch ────────────────────────────────────────────────────

boot().catch(err => {
  console.error('Unhandled boot error:', err);
  process.exit(1);
});
