// ============================================================
// CANDLE BUFFER  —  Accumulates and queries OHLCV history
// ============================================================
// The main loop polls data_get_ohlcv on each tick and passes
// the result here. This class merges new bars into the internal
// store (updating the last forming bar, appending closed bars)
// and provides query helpers used by all the signal engines.
//
// One buffer instance is created per symbol (NQ, ES, YM).
// The SMT detector uses separate ES/YM buffer instances.
//
// Internal format:
//   bars[] → { time (ms UTC), open, high, low, close, volume }
//   Always sorted ascending (oldest bar first).
// ============================================================

export class CandleBuffer {
  // symbol: string (for logging)
  // maxBars: how many bars to keep in memory (rolling window)
  constructor(symbol, maxBars = 500) {
    this.symbol  = symbol;
    this.maxBars = maxBars;
    this.bars    = [];           // sorted ascending by time
    this.lastUpdated = 0;        // Unix ms of last update
  }

  // Merge a fresh batch of bars from the MCP server.
  // The server always returns the most-recent N bars.
  // We update existing bars in place (handles the still-forming bar)
  // and append truly new ones.
  update(incomingBars) {
    if (!incomingBars || incomingBars.length === 0) return;

    // Build a lookup of existing bars by time for O(1) access
    const existing = new Map(this.bars.map(b => [b.time, b]));

    for (const bar of incomingBars) {
      existing.set(bar.time, { ...bar }); // upsert — overwrites forming bar
    }

    // Rebuild sorted array and trim to maxBars
    this.bars = Array.from(existing.values())
      .sort((a, b) => a.time - b.time)
      .slice(-this.maxBars);

    this.lastUpdated = Date.now();
  }

  // Return all bars (ascending)
  all() {
    return this.bars;
  }

  // Return bars whose open time falls within [startMs, endMs]
  // Both bounds are inclusive.
  slice(startMs, endMs) {
    return this.bars.filter(b => b.time >= startMs && b.time <= endMs);
  }

  // Return the last N bars (most recent)
  tail(n) {
    return this.bars.slice(-n);
  }

  // Return the most recent completed bar (second-to-last in the array,
  // since the last bar is still forming in real-time).
  // If the buffer has only one bar, that bar is returned.
  lastClosed() {
    if (this.bars.length < 2) return this.bars[0] ?? null;
    return this.bars[this.bars.length - 2];
  }

  // The currently forming (live) bar — last element in the array
  current() {
    return this.bars[this.bars.length - 1] ?? null;
  }

  // Compute the high and low for bars in a time range.
  // Returns { high, low, highTime, lowTime } or null if no bars found.
  rangeHighLow(startMs, endMs) {
    const segment = this.slice(startMs, endMs);
    if (segment.length === 0) return null;
    let high = -Infinity, low = Infinity, highTime = 0, lowTime = 0;
    for (const b of segment) {
      if (b.high > high) { high = b.high; highTime = b.time; }
      if (b.low  < low)  { low  = b.low;  lowTime  = b.time; }
    }
    return { high, low, highTime, lowTime, barCount: segment.length };
  }

  // Find the bar closest to a given timestamp (by open time)
  barAt(targetMs) {
    let closest = null;
    let minDiff = Infinity;
    for (const b of this.bars) {
      const diff = Math.abs(b.time - targetMs);
      if (diff < minDiff) { minDiff = diff; closest = b; }
    }
    return closest;
  }

  // Return the index in this.bars for a bar with a given time
  // Returns -1 if not found
  indexOf(timeMs) {
    return this.bars.findIndex(b => b.time === timeMs);
  }

  get length() { return this.bars.length; }

  get isEmpty() { return this.bars.length === 0; }
}
