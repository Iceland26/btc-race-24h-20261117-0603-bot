#!/usr/bin/env python3
"""Dip-and-breakout long-only bot for CBBTC on agent-fun/bars-replay/v1.

The bot speaks newline-delimited JSON on stdin/stdout: it reads one hello,
then one batch per minute bar, and answers every batch with exactly one
reply carrying its orders. All arithmetic is integer basis-point math on
bar closes, so two runs over the same bars produce identical orders.

Strategy (all thresholds in bps of price, measured on closes):
  * Dip leg: after the close has fallen at least 120 bps below the highest
    close of the last 60 bars, watch the dip; once the close recovers at
    least 45 bps off the dip low, buy with all cash.
  * Breakout leg: when the close is at least 90 bps above the close 5 bars
    earlier, buy with all cash (momentum continuation).
  * Exits, first to trigger on a close: take-profit at +180 bps over the
    fill price, stop-loss at -50 bps under it, or a trailing stop 80 bps
    below the highest close since entry.
One position at a time, long only, no leverage.
"""

import json
import sys

SYMBOL = "CBBTC"
BPS = 10_000

DIP_WINDOW = 60          # bars in the rolling high for the dip leg
DIP_TRIGGER_BPS = 120    # fall from the rolling high that arms the dip
DIP_CONFIRM_BPS = 45     # recovery off the dip low that confirms entry
BREAKOUT_SPAN = 5        # bars over which the breakout move is measured
BREAKOUT_BPS = 90        # 5-bar rise that triggers the breakout leg
TAKE_PROFIT_BPS = 180
STOP_LOSS_BPS = 50
TRAILING_BPS = 80
ENTRY_SLIPPAGE_BPS = 250
EXIT_SLIPPAGE_BPS = 300


class Bot:
    def __init__(self, hello):
        self.hello = hello
        self.warmup_bars = int(hello.get("warmup_bars", 0))
        self.closes = []            # close prices (ints) in arrival order
        self.cash = int(hello["capital"]["quote_units"])
        self.qty = 0                # held quantity of CBBTC (int, qty scale)
        self.entry_price = None     # fill price of the open position
        self.peak_price = None      # highest close since entry
        self.dip_armed = False
        self.dip_low = None
        self.order_seq = 0

    # -- state updates ----------------------------------------------------
    def apply_fills(self, fills):
        for fill in fills:
            if fill.get("symbol") != SYMBOL or fill.get("status") != "filled":
                continue
            if fill["side"] == "buy":
                self.entry_price = int(fill["price"])
                self.peak_price = self.entry_price
                self.dip_armed = False
                self.dip_low = None
            elif fill["side"] == "sell":
                self.entry_price = None
                self.peak_price = None

    def apply_account(self, account):
        self.cash = int(account["cash_quote_units"])
        self.qty = 0
        for pos in account["positions"]:
            if pos["symbol"] == SYMBOL:
                self.qty = int(pos["qty"])

    # -- order helpers ------------------------------------------------------
    def buy_order(self):
        self.order_seq += 1
        return {
            "side": "buy",
            "client_id": f"buy-{self.order_seq}",
            "symbol": SYMBOL,
            "notional_quote_units": str(self.cash),
            "max_slippage_bps": ENTRY_SLIPPAGE_BPS,
        }

    def sell_order(self):
        self.order_seq += 1
        return {
            "side": "sell",
            "client_id": f"sell-{self.order_seq}",
            "symbol": SYMBOL,
            "qty": str(self.qty),
            "max_slippage_bps": EXIT_SLIPPAGE_BPS,
        }

    # -- strategy -----------------------------------------------------------
    def exit_triggered(self, close):
        entry = self.entry_price
        if close * BPS >= entry * (BPS + TAKE_PROFIT_BPS):
            return True
        if close * BPS <= entry * (BPS - STOP_LOSS_BPS):
            return True
        if self.peak_price is not None and (
            close * BPS <= self.peak_price * (BPS - TRAILING_BPS)
        ):
            return True
        return False

    def dip_signal(self, close):
        """Update dip tracking with this close; True when the dip confirms."""
        if len(self.closes) < DIP_WINDOW:
            return False
        high = max(self.closes[-DIP_WINDOW:])
        if not self.dip_armed:
            if close * BPS <= high * (BPS - DIP_TRIGGER_BPS):
                self.dip_armed = True
                self.dip_low = close
            return False
        if close >= high:
            # Back at the rolling high: the dip is over, start over.
            self.dip_armed = False
            self.dip_low = None
            return False
        if close < self.dip_low:
            self.dip_low = close
        return close * BPS >= self.dip_low * (BPS + DIP_CONFIRM_BPS)

    def breakout_signal(self, close):
        if len(self.closes) <= BREAKOUT_SPAN:
            return False
        base = self.closes[-BREAKOUT_SPAN - 1]
        return close * BPS >= base * (BPS + BREAKOUT_BPS)

    def on_batch(self, batch):
        self.apply_fills(batch["fills"])
        self.apply_account(batch["account"])
        bar = None
        for candidate in batch["bars"]:
            if candidate["symbol"] == SYMBOL:
                bar = candidate
        orders = []
        if bar is not None:
            close = int(bar["c"])
            self.closes.append(close)
            if self.qty > 0 and self.entry_price is not None:
                if self.peak_price is None or close > self.peak_price:
                    self.peak_price = close
                if self.exit_triggered(close):
                    orders.append(self.sell_order())
            elif batch["seq"] >= self.warmup_bars:
                if self.dip_signal(close) or self.breakout_signal(close):
                    orders.append(self.buy_order())
        return {"type": "reply", "seq": batch["seq"], "orders": orders}


def main():
    bot = None
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        message = json.loads(line)
        kind = message.get("type")
        if kind == "hello":
            bot = Bot(message)
        elif kind == "batch" and bot is not None:
            reply = bot.on_batch(message)
            out.write(json.dumps(reply) + "\n")
            out.flush()
        elif kind == "done":
            break


if __name__ == "__main__":
    main()
