# Changes Log

Running report of experimental changes made to the bot outside of normal
feature work — what changed, why, and exactly how to undo it. Newest entry
on top.

---

## 2026-08-12 — Remove trade-frequency restrictions (data-collection phase)

**Goal:** see how many signals the model actually finds across the full
trading day, unrestricted, before re-applying any of the guardrails below.

### 1. Killzone gate — removed

**File:** `src/engines/signal-engine.js`, `evaluate()` Step 1.

Previously the engine returned `null` (no signal) for any tick where
`getKillzoneStatus()` reported we weren't inside NY AM (9:30–11:00 ET) or
NY PM (1:30–3:00 ET). That early-return has been deleted; `getKillzoneStatus()`
is still called so its output can be logged on the signal.

**Bug found while making this change:** `config.killzones` — the array
`killzone.js` reads to build those two windows — does not exist anywhere in
`config.js`. It was likely dropped when the config was reorganized around
`toi` / `sessionFilter` / `htfBias` for the backtester. That means
`getKillzoneStatus()` was already returning `{ active: false }` on every
single call, so **this gate had degenerated into a permanent block, not a
NY-AM/PM restriction** — the live bot (`npm start`) could not have fired a
signal at all before this change, regardless of time of day. `backtest.js`
was unaffected — it uses the separate `config.toi` / `sessionFilter` path,
not `killzone.js`.

Because the underlying window table never existed, `kzStatus.name` is
always `null`. The `confluence.killzone` field on fired signals now reads
`kzStatus.name ?? 'unrestricted'` instead of raw `null`, purely so the
console/log output is legible — this is a logging fix, not a gating change.

**To restore:** re-add the early return at the top of `evaluate()`:
```js
const kzStatus = getKillzoneStatus(nowMs);
if (!kzStatus.active) return null;
```
and, separately, decide whether to fix `config.killzones` (it needs a
`[{ name, startHour, startMinute, endHour, endMinute }, ...]` array — see
`killzone.js` for the exact shape) or replace `killzone.js` with the
`toi`/`sessionFilter` approach `backtest.js` already uses.

### 2. Max-trades-per-session cap — removed

**Files:** `src/engines/signal-engine.js` (`_riskGateOpen()`), `config.js`.

The check `tradesThisSession >= config.risk.maxTradesPerSession` has been
deleted from `_riskGateOpen()`. `config.risk.maxTradesPerSession` (still `3`)
is left in `config.js`, unused, so the original limit is documented and
ready to wire back in.

**To restore:** add back to `_riskGateOpen()`:
```js
if (this.tradesThisSession >= config.risk.maxTradesPerSession) {
  logger.kill(`Max trades per session reached (${this.tradesThisSession}/${config.risk.maxTradesPerSession})`);
  return false;
}
```

### 3. Daily loss kill switch — hidden behind a flag (not removed)

**Files:** `src/engines/signal-engine.js` (`_riskGateOpen()`), `config.js`.

Unlike the two changes above, this one was explicitly requested to stay
reactivatable, so it's gated by a new config flag instead of being deleted:

```js
// config.js
risk: {
  dailyLossLimitPoints: -50,
  dailyLossKillSwitchEnabled: false,  // ← new, defaults off
  ...
}
```

```js
// signal-engine.js, _riskGateOpen()
if (config.risk.dailyLossKillSwitchEnabled && this.sessionPnL <= config.risk.dailyLossLimitPoints) {
  ...
}
```

**To restore:** set `dailyLossKillSwitchEnabled: true` in `config.js`. No
other code changes needed — the threshold (`dailyLossLimitPoints: -50`) was
never touched.

### Net effect

With all three changes, the live bot (`npm start`) will now fire a signal
any time the sweep → MSS → FVG → entry sequence completes, at any time of
day, with no cap on how many fire per session and no P&L-based cutoff. This
is intentional for this phase — it's meant to surface the model's raw
signal frequency, not a change to the trading logic itself (sweep
detection, MSS/CISD, FVG, SMT confluence are all untouched).

**Reminder:** the `htfZone` top-down rebuild noted in earlier sessions
(HTF zone as a precondition rather than a post-hoc score) has *not* been
done — `signal-engine.js` still runs sweep-first, HTF-scored-after. That's
a separate, larger change from this data-collection pass.
