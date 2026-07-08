// ============================================================
// TRADE VISUALIZER
// ============================================================
// Per-backtest run directory layout (under frank369-bot/data/):
//
//   data/
//     backtest_20260418_215500/
//       trades.xlsx          ← Excel with reasoning + metrics
//       screenshots/
//         trade_2026-04-13_1514ET_short.png
//         trade_2026-04-17_1341ET_long.png
//
// Each run is isolated.  Call createRunDir() at backtest start
// to get the runDir path, then pass it to every function below.
// After all screenshots are taken, call clearAllDrawings() to
// wipe the TradingView chart clean.
// ============================================================

import ExcelJS        from 'exceljs';
import path           from 'path';
import fs             from 'fs';
import { fileURLToPath } from 'url';
import { logger }        from './logger.js';
import { sessionLevelsLabel } from './engines/session-engine.js';
import { smtLabel }           from './engines/smt-engine.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.join(__dirname, '..', 'data');

// ── Run directory ─────────────────────────────────────────────

// Call once at backtest start.  Returns the absolute path to a
// new timestamped folder, e.g. data/backtest_20260418_215500/
export function createRunDir() {
  // Find the next sequential number by scanning existing backtest_NN folders
  const existing = fs.existsSync(DATA_DIR)
    ? fs.readdirSync(DATA_DIR)
        .map(n => n.match(/^backtest_(\d+)$/))
        .filter(Boolean)
        .map(m => parseInt(m[1], 10))
    : [];
  const next   = existing.length > 0 ? Math.max(...existing) + 1 : 1;
  const runDir = path.join(DATA_DIR, `backtest_${String(next).padStart(2, '0')}`);
  fs.mkdirSync(path.join(runDir, 'screenshots'), { recursive: true });
  logger.info(`Run folder: ${runDir}`);
  return runDir;
}

// ── TradingView position drawing ──────────────────────────────

// Draws a Long/Short Position tool and returns { entityIds[] } so
// the caller can remove it after the screenshot is taken.
// Falls back to three horizontal lines if the position shape fails.
export async function drawTradePosition(mcpClient, t) {
  const timeSec = Math.floor(t.timestamp / 1000);
  const shape   = t.direction === 'long' ? 'long_position' : 'short_position';
  const label   = tradeLabel(t);

  try {
    const res = await mcpClient.call('draw_shape', {
      shape,
      point:  { time: timeSec, price: t.entry   },
      point2: { time: timeSec, price: t.stop    },
      point3: { time: timeSec, price: t.target1 },
      text: label,
    });
    logger.info(`  Drew position: ${label}`);
    return res.entity_id ? [res.entity_id] : [];
  } catch (err) {
    logger.debug(`  position shape failed (${err.message}), falling back to lines`);
    return drawTradeLines(mcpClient, t, label, timeSec);
  }
}

// Returns array of entity IDs for the three lines drawn.
async function drawTradeLines(mcpClient, t, label, timeSec) {
  const entryColor = t.direction === 'long' ? '#26a69a' : '#ef5350';
  const draws = [
    { shape: 'horizontal_line', point: { time: timeSec, price: t.entry },
      overrides: JSON.stringify({ linecolor: entryColor, linewidth: 2 }), text: label },
    { shape: 'horizontal_line', point: { time: timeSec, price: t.stop },
      overrides: JSON.stringify({ linecolor: '#ef5350', linewidth: 1, linestyle: 2 }),
      text: `SL ${t.stop.toFixed(2)}` },
    { shape: 'horizontal_line', point: { time: timeSec, price: t.target1 },
      overrides: JSON.stringify({ linecolor: '#26a69a', linewidth: 1, linestyle: 2 }),
      text: `TP ${t.target1.toFixed(2)}` },
  ];
  const ids = [];
  for (const args of draws) {
    try {
      const res = await mcpClient.call('draw_shape', args);
      if (res.entity_id) ids.push(res.entity_id);
    } catch { break; }
  }
  logger.info(`  Drew lines:    ${label}`);
  return ids;
}

// Remove a set of drawings by entity ID (cleanup after screenshot).
export async function removeDrawings(mcpClient, entityIds) {
  for (const id of entityIds) {
    try { await mcpClient.call('draw_remove_one', { entity_id: id }); } catch {}
  }
}

function tradeLabel(t) {
  const result  = t.result === 'win' ? '✓W' : t.result === 'loss' ? '✗L' : t.result === 'partial' ? '½P' : '~T';
  const premium = t.isPremiumTime ? ' ★' : '';
  return `F369 ${t.direction.toUpperCase()} C${t.cycleIndex} ${t.date} ${t.time} ${result}${premium}`;
}

// ── Screenshot ────────────────────────────────────────────────

// Captures the chart via the MCP server (saves to its own
// screenshots/ dir), then moves the file into runDir/screenshots/.
// Returns the final path inside the run folder, or null on failure.
export async function captureTradeScreenshot(mcpClient, t, runDir) {
  const filename = `trade_${t.date}_${t.time.replace(/[: ]/g, '')}_${t.direction}`;

  // Scroll chart to the trade date so each screenshot shows the right candles
  try {
    await mcpClient.call('chart_scroll_to_date', { date: t.date });
    await sleep(1500);
  } catch {}

  try {
    const res = await mcpClient.call('capture_screenshot', {
      region: 'chart', filename, method: 'cdp',
    });
    const srcPath = res.file_path ?? res.path ?? res.file ?? null;
    if (!srcPath) return null;

    const destPath = path.join(runDir, 'screenshots', path.basename(srcPath));
    fs.renameSync(srcPath, destPath);
    logger.info(`  Screenshot saved: screenshots/${path.basename(destPath)}`);
    return destPath;
  } catch (err) {
    logger.warn(`  Screenshot failed: ${err.message}`);
    return null;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Clear all TradingView drawings ────────────────────────────

export async function clearAllDrawings(mcpClient) {
  try {
    await mcpClient.call('draw_clear', {});
    logger.info('  TradingView chart cleared — all drawings removed');
  } catch (err) {
    logger.warn(`  draw_clear failed: ${err.message}`);
  }
}

// ── Excel export ──────────────────────────────────────────────

// Creates runDir/trades.xlsx fresh for this run.
export async function exportTradesToExcel(trades, runDir) {
  const excelPath = path.join(runDir, 'trades.xlsx');
  const workbook  = new ExcelJS.Workbook();
  const ws        = workbook.addWorksheet('Backtest Trades');

  const headers = [
    '#', 'Date', 'Time (ET)', 'Dir', 'Cycle', 'Session',
    'Entry', 'Stop', 'Target', 'Risk (pts)', 'R:R',
    'Result', 'P&L (pts)', 'Premium ★',
    'HTF Bias', 'Sweep Q', 'FVG Q', 'SMT',
    'Session Levels', 'Reasoning', 'Screenshot',
  ];
  const widths  = [4, 12, 11, 6, 7, 10, 10, 10, 10, 10, 6, 8, 10, 10, 10, 9, 8, 24, 70, 60, 60];

  ws.columns = headers.map((h, i) => ({ header: h, key: h, width: widths[i] }));

  const headerRow = ws.getRow(1);
  headerRow.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

  trades.forEach((t, idx) => {
    const sign = t.direction === 'long' ? 1 : -1;
    let pnl;
    if (t.result === 'win') {
      pnl = +(0.5*(t.target1-t.entry)*sign + 0.5*(t.target2-t.entry)*sign).toFixed(2);
    } else if (t.result === 'partial') {
      pnl = +(0.5*(t.target1-t.entry)*sign + 0.5*(t.exit2Price-t.entry)*sign).toFixed(2);
    } else if (t.result === 'loss') {
      pnl = +(-t.riskPoints).toFixed(2);
    } else {
      pnl = +((t.exitPrice - t.entry) * sign).toFixed(2);
    }

    const row = ws.addRow({
      '#':           idx + 1,
      'Date':        t.date,
      'Time (ET)':   t.time,
      'Dir':         t.direction.toUpperCase(),
      'Cycle':       `C${t.cycleIndex}`,
      'Session':     t.confluence?.killzone ?? '',
      'Entry':       +t.entry.toFixed(2),
      'Stop':        +t.stop.toFixed(2),
      'Target':      +t.target1.toFixed(2),
      'Risk (pts)':  +t.riskPoints.toFixed(2),
      'R:R':         +t.rr.toFixed(1),
      'Result':      t.result.toUpperCase(),
      'P&L (pts)':   pnl,
      'Premium ★':   t.isPremiumTime ? 'YES' : '',
      'HTF Bias':    t.htfBias ?? '',
      'Sweep Q':     t.sweepQuality ?? '',
      'FVG Q':       t.fvgQuality ?? '',
      'SMT':         smtLabel(t.smt) || '',
      'Session Levels': sessionLevelsLabel(t.sessionHL ?? null),
      'Reasoning':   buildReasoning(t),
      'Screenshot':  t.screenshotPath ? path.relative(runDir, t.screenshotPath) : '',
    });

    const rc = row.getCell('Result');
    if (t.result === 'win')     rc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC8E6C9' } };
    if (t.result === 'partial') rc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB3E5FC' } };
    if (t.result === 'loss')    rc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFCDD2' } };
    if (t.result === 'timeout') rc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF9C4' } };

    const pc = row.getCell('P&L (pts)');
    pc.font = { color: { argb: pnl >= 0 ? 'FF2E7D32' : 'FFC62828' } };

    if (t.isPremiumTime) row.getCell('Premium ★').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3E0' } };
    if (t.smt?.active)   row.getCell('SMT').fill       = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F5E9' } };
    if (t.sweepQuality === 'low')    row.getCell('Sweep Q').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFCDD2' } };
    if (t.sweepQuality === 'high')   row.getCell('Sweep Q').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC8E6C9' } };
    if (t.fvgQuality   === 'large')  row.getCell('FVG Q').fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC8E6C9' } };
    if (t.fvgQuality   === 'small')  row.getCell('FVG Q').fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFCDD2' } };
    const htfCell = row.getCell('HTF Bias');
    if (t.htfBias === 'bullish') htfCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFC8E6C9' } };
    if (t.htfBias === 'bearish') htfCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFCDD2' } };

    row.getCell('Dir').font = { color: { argb: t.direction === 'long' ? 'FF1B5E20' : 'FFB71C1C' }, bold: true };
  });

  ws.views = [{ state: 'frozen', ySplit: 1 }];

  await workbook.xlsx.writeFile(excelPath);
  logger.info(`  Excel saved → ${excelPath}  (${trades.length} trades)`);
  return excelPath;
}

// ── Reasoning builder ─────────────────────────────────────────

function buildReasoning(t) {
  const dir  = t.direction === 'long' ? 'LONG' : 'SHORT';
  const kz   = t.confluence?.killzone ?? 'session';
  const prem = t.isPremiumTime ? ' (Premium XX:45–XX:15 window)' : '';
  const dolStr = t.dol
    ? ` DOL ${t.dol.direction}: ${t.dol.type} @ ${t.dol.price.toFixed(0)} (score ${t.htfScore >= 0 ? '+' : ''}${t.htfScore ?? 0}).`
    : '';
  const htfStr = t.htfReasons?.length
    ? ` HTF: ${t.htfReasons.join('; ')}.`
    : '';

  return (
    `${dir} setup — Cycle ${t.cycleIndex}, ${kz}${prem}. ` +
    `Sweep of prev-cycle ${t.direction === 'long' ? 'LOW' : 'HIGH'} (${t.sweepType}, ${t.sweepStyle ?? 'wick'}), ` +
    `MSS via ${t.mssType ?? 'body'}, FVG retracement. ` +
    `Entry ${t.entry.toFixed(2)} | Stop ${t.stop.toFixed(2)} ` +
    `(${t.riskPoints.toFixed(1)} pts risk) | Target ${t.target1.toFixed(2)} (${t.rr.toFixed(1)}R). ` +
    `Prev-cycle H: ${t.prevH?.toFixed(2) ?? '?'}  L: ${t.prevL?.toFixed(2) ?? '?'}.` +
    dolStr + htfStr
  );
}
