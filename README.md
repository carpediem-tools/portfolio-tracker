# 📊 Portfolio Tracker

A 100% local, multi-currency investment portfolio tracker built in Python.
No cloud. No account.

---

## Features

- **Securities** — open positions with purchase history, weighted average
  cost, live valuation, P&L and weight per position
- **Crypto positions** — same logic, powered by CoinGecko
- **Multi-currency** — EUR, USD, CHF, GBP, JPY, HKD and CNY supported;
  all values consolidated into a chosen reporting currency
- **Live price sync** — stocks via Yahoo Finance, crypto via CoinGecko,
  FX rates via Yahoo Finance — all free, no API key required;
  one-click Sync all covers prices and FX in one shot
- **Sales tracking** — realized P&L for both Securities and crypto
  disposals, with historical FX rates at transaction date (Frankfurter / ECB)
- **Dashboard** — total valuation, pie charts by asset class / broker /
  position, annual trend chart and year-over-year snapshot
  (Securities + Cryptos + Total)
- **Portfolio history** — manual annual snapshots with Dec 31 FX rates
  (Frankfurter / ECB); fixed columns Securities + Cryptos; sortable by year
- **Fully configurable** — brokers and asset classes defined freely
  in Options, no hardcoded defaults
- **CSV export** — timestamped ZIP with one CSV per data type,
  no external dependency
---

## Privacy

All personal financial data is stored locally in `portfolio_data.json`
and never leaves the machine.

Live prices and exchange rates are fetched from the following external
services, on explicit user request only — no automatic background calls
are made:

- Yahoo Finance — live stock prices and daily FX rates
- CoinGecko — live crypto prices
- Frankfurter (ECB) — historical FX rates for realized P&L (transaction
  date) and annual History snapshots (Dec 31)

## Requirements

- Python 3.10+
- yfinance library

```bash
pip install yfinance
```

---

## Usage

```bash
python3 portfolio_tracker.py
```

Then the browser opens at `http://localhost:8080`.

---

## Data storage

All data is saved in `portfolio_data.json` in the project folder.
This file is excluded from the repository and stays on the local machine
only. It can be backed up manually or exported as CSV from the Options tab.

## APIs used

| API | Purpose | Key required |
|-----|---------|--------------|
| Yahoo Finance (yfinance) | Stock prices + daily FX rates | No |
| CoinGecko public API | Crypto prices | No |
| Frankfurter (ECB) | Historical FX rates — Sales (transaction date) + History snapshots (Dec 31) — from 1999-01-04 | No |

## License

MIT
