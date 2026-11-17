// Dip-and-breakout long-only bot for CBBTC on agent-fun/bars-replay/v1.
//
// The bot speaks newline-delimited JSON on stdin/stdout: it reads one
// hello, then one batch per minute bar, and answers every batch with
// exactly one reply carrying its orders. All arithmetic is integer
// basis-point math on bar closes (BigInt throughout), so two runs over
// the same bars produce identical orders.
//
// Strategy (all thresholds in bps of price, measured on closes):
//   * Dip leg: after the close has fallen at least 120 bps below the
//     highest close of the last 60 bars, watch the dip; once the close
//     recovers at least 45 bps off the dip low, buy with all cash.
//   * Breakout leg: when the close is at least 90 bps above the close
//     5 bars earlier, buy with all cash (momentum continuation).
//   * Exits, first to trigger on a close: take-profit at +180 bps over
//     the fill price, stop-loss at -50 bps under it, or a trailing stop
//     80 bps below the highest close since entry.
// One position at a time, long only, no leverage.

import { createInterface } from "node:readline";

const SYMBOL = "CBBTC";
const BPS = 10000n;

const DIP_WINDOW = 60; // bars in the rolling high for the dip leg
const DIP_TRIGGER_BPS = 120n; // fall from the rolling high that arms the dip
const DIP_CONFIRM_BPS = 45n; // recovery off the dip low that confirms entry
const BREAKOUT_SPAN = 5; // bars over which the breakout move is measured
const BREAKOUT_BPS = 90n; // 5-bar rise that triggers the breakout leg
const TAKE_PROFIT_BPS = 180n;
const STOP_LOSS_BPS = 50n;
const TRAILING_BPS = 80n;
const ENTRY_SLIPPAGE_BPS = 250;
const EXIT_SLIPPAGE_BPS = 300;

type Bar = { symbol: string; c: string };
type Fill = {
  symbol: string;
  side: string;
  status: string;
  price: string;
};
type Account = {
  cash_quote_units: string;
  positions: { symbol: string; qty: string }[];
};
type Batch = { seq: number; bars: Bar[]; fills: Fill[]; account: Account };
type Order = Record<string, string | number>;

class Bot {
  warmupBars: number;
  closes: bigint[] = [];
  cash: bigint;
  qty: bigint = 0n;
  entryPrice: bigint | null = null;
  peakPrice: bigint | null = null;
  dipArmed = false;
  dipLow: bigint | null = null;
  orderSeq = 0;

  constructor(hello: { warmup_bars?: number; capital: { quote_units: string } }) {
    this.warmupBars = hello.warmup_bars ?? 0;
    this.cash = BigInt(hello.capital.quote_units);
  }

  applyFills(fills: Fill[]): void {
    for (const fill of fills) {
      if (fill.symbol !== SYMBOL || fill.status !== "filled") continue;
      if (fill.side === "buy") {
        this.entryPrice = BigInt(fill.price);
        this.peakPrice = this.entryPrice;
        this.dipArmed = false;
        this.dipLow = null;
      } else if (fill.side === "sell") {
        this.entryPrice = null;
        this.peakPrice = null;
      }
    }
  }

  applyAccount(account: Account): void {
    this.cash = BigInt(account.cash_quote_units);
    this.qty = 0n;
    for (const pos of account.positions) {
      if (pos.symbol === SYMBOL) this.qty = BigInt(pos.qty);
    }
  }

  buyOrder(): Order {
    this.orderSeq += 1;
    return {
      side: "buy",
      client_id: `buy-${this.orderSeq}`,
      symbol: SYMBOL,
      notional_quote_units: this.cash.toString(),
      max_slippage_bps: ENTRY_SLIPPAGE_BPS,
    };
  }

  sellOrder(): Order {
    this.orderSeq += 1;
    return {
      side: "sell",
      client_id: `sell-${this.orderSeq}`,
      symbol: SYMBOL,
      qty: this.qty.toString(),
      max_slippage_bps: EXIT_SLIPPAGE_BPS,
    };
  }

  exitTriggered(close: bigint): boolean {
    const entry = this.entryPrice as bigint;
    if (close * BPS >= entry * (BPS + TAKE_PROFIT_BPS)) return true;
    if (close * BPS <= entry * (BPS - STOP_LOSS_BPS)) return true;
    if (
      this.peakPrice !== null &&
      close * BPS <= this.peakPrice * (BPS - TRAILING_BPS)
    ) {
      return true;
    }
    return false;
  }

  dipSignal(close: bigint): boolean {
    if (this.closes.length < DIP_WINDOW) return false;
    let high = 0n;
    for (const c of this.closes.slice(-DIP_WINDOW)) {
      if (c > high) high = c;
    }
    if (!this.dipArmed) {
      if (close * BPS <= high * (BPS - DIP_TRIGGER_BPS)) {
        this.dipArmed = true;
        this.dipLow = close;
      }
      return false;
    }
    if (close >= high) {
      // Back at the rolling high: the dip is over, start over.
      this.dipArmed = false;
      this.dipLow = null;
      return false;
    }
    if (this.dipLow === null || close < this.dipLow) this.dipLow = close;
    return close * BPS >= (this.dipLow as bigint) * (BPS + DIP_CONFIRM_BPS);
  }

  breakoutSignal(close: bigint): boolean {
    if (this.closes.length <= BREAKOUT_SPAN) return false;
    const base = this.closes[this.closes.length - BREAKOUT_SPAN - 1];
    return close * BPS >= base * (BPS + BREAKOUT_BPS);
  }

  onBatch(batch: Batch): { type: string; seq: number; orders: Order[] } {
    this.applyFills(batch.fills);
    this.applyAccount(batch.account);
    let bar: Bar | undefined;
    for (const candidate of batch.bars) {
      if (candidate.symbol === SYMBOL) bar = candidate;
    }
    const orders: Order[] = [];
    if (bar !== undefined) {
      const close = BigInt(bar.c);
      this.closes.push(close);
      if (this.qty > 0n && this.entryPrice !== null) {
        if (this.peakPrice === null || close > this.peakPrice) {
          this.peakPrice = close;
        }
        if (this.exitTriggered(close)) orders.push(this.sellOrder());
      } else if (batch.seq >= this.warmupBars) {
        if (this.dipSignal(close) || this.breakoutSignal(close)) {
          orders.push(this.buyOrder());
        }
      }
    }
    return { type: "reply", seq: batch.seq, orders };
  }
}

let bot: Bot | null = null;
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  const message = JSON.parse(trimmed);
  if (message.type === "hello") {
    bot = new Bot(message);
  } else if (message.type === "batch" && bot !== null) {
    process.stdout.write(JSON.stringify(bot.onBatch(message)) + "\n");
  } else if (message.type === "done") {
    rl.close();
  }
});
