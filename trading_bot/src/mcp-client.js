// ============================================================
// MCP CLIENT  —  TradingView MCP wrapper
// ============================================================
// This file is the ONLY place that knows about:
//   • the MCP JSON-RPC protocol
//   • raw tool names (tv_health_check, data_get_ohlcv, etc.)
//   • raw response parsing / timestamp normalization
//
// All other modules call typed helper methods and get back
// clean objects. Never import the MCP SDK anywhere else.
//
// MCP server: ~/tradingview-mcp-jackson/src/server.js
// Transport : stdio (the server is spawned as a child process)
// Protocol  : MCP 2.0 JSON-RPC over stdin/stdout
//
// Tool names confirmed from server source (src/tools/*.js):
//   tv_health_check   — health.js
//   chart_get_state   — chart.js
//   chart_set_symbol  — chart.js
//   chart_set_timeframe — chart.js
//   data_get_ohlcv    — data.js
//   quote_get         — data.js
// ============================================================

import { Client }               from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { config }               from '../config.js';
import { logger }               from './logger.js';

// ── Internal helpers ─────────────────────────────────────────

// All MCP tools return { content: [{ type: 'text', text: JSON }] }
// This extracts and parses the JSON payload.
function parseResponse(result) {
  if (!result?.content?.[0]?.text) {
    throw new Error('Empty or malformed MCP response');
  }
  let parsed;
  try {
    parsed = JSON.parse(result.content[0].text);
  } catch {
    throw new Error(`MCP response is not valid JSON: ${result.content[0].text}`);
  }
  // Some tools set success:false with an error message on failure
  if (parsed.success === false) {
    throw new Error(parsed.error || 'MCP tool returned success:false');
  }
  return parsed;
}

// TradingView bar timestamps come back as Unix seconds.
// We work in milliseconds internally so comparisons with Date.now() are trivial.
function normalizeBar(bar) {
  const time = bar.time > 1_000_000_000_000 ? bar.time : bar.time * 1000;
  return {
    time,
    open:   bar.open,
    high:   bar.high,
    low:    bar.low,
    close:  bar.close,
    volume: bar.volume ?? 0,
  };
}

// ── McpClient class ──────────────────────────────────────────

export class McpClient {
  constructor() {
    this.client    = null;
    this.transport = null;
    this.connected = false;
  }

  // Establish stdio connection to the MCP server subprocess
  async connect() {
    this.transport = new StdioClientTransport({
      command: 'node',
      args:    [config.mcp.serverPath],
      // Pass through the full environment so TradingView session cookies
      // and CDP environment variables are available to the server process.
      env: { ...process.env },
    });

    this.client = new Client(
      { name: 'frank369-bot', version: '1.0.0' },
      { capabilities: {} },
    );

    await this.client.connect(this.transport);
    this.connected = true;
    logger.info('MCP client connected → TradingView server ready');
  }

  async disconnect() {
    if (this.client && this.connected) {
      await this.client.close();
      this.connected = false;
      logger.info('MCP client disconnected');
    }
  }

  // Internal: call any MCP tool by name with an arguments object
  async call(toolName, args = {}) {
    if (!this.connected) {
      throw new Error('McpClient: not connected — call connect() first');
    }
    const result = await this.client.callTool({ name: toolName, arguments: args });
    return parseResponse(result);
  }

  // ── Public API ───────────────────────────────────────────────

  // Confirm TradingView Desktop is open and chart is loaded.
  // Returns { ok: bool, symbol: string, resolution: string, raw: object }
  async healthCheck() {
    const data = await this.call('tv_health_check');
    return {
      ok:         !!(data.status === 'ok' || data.chart?.symbol),
      symbol:     data.chart?.symbol     ?? data.symbol     ?? null,
      resolution: data.chart?.resolution ?? data.resolution ?? null,
      raw:        data,
    };
  }

  // Get the currently active chart symbol and timeframe.
  // Returns { symbol: string, resolution: string }
  async getState() {
    const data = await this.call('chart_get_state');
    return {
      symbol:     data.symbol,
      resolution: data.resolution,
    };
  }

  // Switch the active chart to a different symbol.
  // The 1.5 s pause allows TradingView to finish loading the new symbol
  // before the next data_get_ohlcv call reads bars.
  async setSymbol(symbol) {
    await this.call('chart_set_symbol', { symbol });
    await sleep(1500);
  }

  // Switch the active chart to a different timeframe.
  async setTimeframe(timeframe) {
    await this.call('chart_set_timeframe', { timeframe });
    await sleep(1000);
  }

  // Fetch the last N OHLCV bars from the currently active chart.
  // Returns array of { time (ms UTC), open, high, low, close, volume }
  // sorted ascending by time (oldest first).
  // Retries with backoff to handle chart loading delays after symbol
  // switches or fresh TradingView launches.
  async getOhlcv(bars = 200, { retries = 6, delayMs = 3000 } = {}) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const data = await this.call('data_get_ohlcv', { count: bars });
        // Server may return bars under 'bars', 'data', or 'candles' key
        const rawBars = data.bars ?? data.data ?? data.candles ?? [];
        if (!Array.isArray(rawBars) || rawBars.length === 0) {
          throw new Error('Empty bars array — chart still loading');
        }
        return rawBars.map(normalizeBar).sort((a, b) => a.time - b.time);
      } catch (err) {
        if (attempt === retries) throw err;
        logger.debug(`getOhlcv attempt ${attempt}/${retries} failed (${err.message}) — retrying in ${delayMs / 1000}s`);
        await sleep(delayMs);
      }
    }
  }

  // Get the current real-time quote for the symbol currently on the chart.
  // Returns { symbol, time (ms), open, high, low, close, volume, bid, ask }
  // NOTE: reads from the *active* chart — call setSymbol() first to query
  //       a different instrument (ES/YM for SMT).
  async getQuote() {
    const data = await this.call('quote_get');
    const time = data.time
      ? (data.time > 1_000_000_000_000 ? data.time : data.time * 1000)
      : Date.now();
    return {
      symbol: data.symbol,
      time,
      open:   data.open,
      high:   data.high,
      low:    data.low,
      close:  data.close ?? data.price ?? data.last,
      volume: data.volume ?? 0,
      bid:    data.bid    ?? null,
      ask:    data.ask    ?? null,
    };
  }
}

// ── Factory ──────────────────────────────────────────────────

export async function createMcpClient() {
  const client = new McpClient();
  await client.connect();
  return client;
}

// ── Utilities ────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
