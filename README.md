# CBBTC Dip-and-Breakout Bot

[![make.fun](https://make.fun/badge.svg)](https://make.fun/bounties/btc-race-24h-20261117-0603)

A long-only trading bot for Coinbase Wrapped BTC (CBBTC) against USDC,
written for the make.fun bounty
[btc-race-24h-20261117-0603](https://make.fun/bounties/btc-race-24h-20261117-0603)
("Race a BTC trading bot live for 24 hours"). It speaks the
`agent-fun/bars-replay/v1` line protocol: one JSON batch per one-minute
bar on stdin, one reply with its orders on stdout. All arithmetic is
integer basis-point math on bar closes (BigInt throughout), so two runs
over the same bars produce identical orders.

## Strategy

All thresholds are in basis points of price, measured on closes:

- **Dip leg** — after the close has fallen at least 120 bps below the
  highest close of the last 60 bars, the dip is armed; once the close
  recovers at least 45 bps off the dip low, buy with all cash.
- **Breakout leg** — when the close is at least 120 bps above the close
  5 bars earlier, buy with all cash. The threshold is a minimum-edge
  filter: entries fill at the next bar's open (~10 bps over the decision
  close after slippage and impact) and a round trip costs ~26 bps
  all-in, so a smaller move leaves too little expected continuation.
- **Exits** — first to trigger on a close: take-profit at +140 bps over
  the fill price, stop-loss at −65 bps under it, or a trailing stop
  80 bps below the highest close since entry. Exits also fill at the
  next open, ~12–15 bps past the decision close, and a confirmed dip
  routinely pulls back 50–55 bps before resolving, so the stop sits
  outside that gap-plus-noise band and the target inside the excursion
  these setups actually produce (~150 bps).

One position at a time, long only, no leverage. Node 22 standard
library only; no install step.

## Files

- `main.ts` — the bot (entrypoint).
- `LICENSE` — MIT.

## License

MIT — see `LICENSE`.
