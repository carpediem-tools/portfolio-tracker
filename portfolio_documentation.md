# 📊 Portfolio — User Documentation

> 100% local investment tracker · Python 3.13
> Access: `http://localhost:8080` after launching `python3 portfolio_tracker.py`

---

## Table of contents

1. [General architecture](#1-general-architecture)
2. [Dashboard tab](#2-dashboard-tab)
3. [CTO tab](#3-cto-tab)
4. [Cryptos tab](#4-cryptos-tab)
5. [CTO Sales / Crypto Sales tabs](#5-sales-tabs)
6. [History tab](#6-history-tab)
7. [Options tab](#7-options-tab)
8. [Currencies — complete guide](#8-currencies--complete-guide)
9. [Ticker formats](#9-ticker-formats)
10. [Yahoo Finance API](#10-yahoo-finance-api)
11. [Historical FX rates (Frankfurter)](#11-historical-fx-rates-frankfurter)
12. [Calculations](#12-calculations)
13. [Price synchronization](#13-price-synchronization)
14. [Data and storage](#14-data-and-storage)
15. [CSV export](#15-csv-export)
16. [Upcoming features](#16-upcoming-features)

---

## 1. General architecture

The tracker runs entirely locally, with no cloud or mandatory external dependencies.

| Component | Details |
|---|---|
| Server | `http.server` Python, `localhost:8080` |
| Data | `portfolio_data.json` — same folder as the script |
| Stock prices | Yahoo Finance via `yfinance` (pip) or direct HTTP fallback |
| Crypto prices | CoinGecko public API, no key required |
| Daily FX rates | Yahoo Finance — EUR-based pairs for all supported currencies (EUR, USD, CHF, GBP, JPY, HKD, CNY) — Dashboard consolidations |
| Historical FX rates | Frankfurter API (ECB) — realized P&L in Sales screens |
| Frontend | HTML/CSS/JS vanilla, embedded in the Python script |

**No automatic synchronization.** All prices and rates are fetched only when the 🔄 button is clicked.

---

## 2. Dashboard tab

Consolidated view of the entire portfolio.

### Main KPI
- **Total valuation** converted to the currency selected in Options (today's rate).
- Only positions with a live price AND a configured currency contribute to the total.

### Pie charts
Four breakdown charts, all expressed in the **Options currency** (converted at today's rate):
- By asset class (Actions / Métaux / Immo / Cryptos)
- Individual CTO positions
- Individual Crypto positions
- By broker (CTO only)

> ⚠️ If exchange rates have not been synced yet, positions in other currencies will not appear in the pie charts.

### Annual trend chart
Change in total valuation year over year, fed by data entered in the History tab.

Each history row has its own entry currency. The chart converts each value to the Options currency at today's rate. Years with missing FX data are dropped from the chart. The axis and label symbol dynamically follows the Options currency.

### Annual snapshot table
Below the chart, a table summarizes year by year the totals, share by asset class, crypto share, and the change (`%` vs. the previous year). All values are converted to the Options currency. Cells showing `—` indicate that an FX conversion was missing for that row.

---

## 3. CTO tab

Open positions in an ordinary securities account.

### Main columns

| Column | Entry / Computed | Notes |
|---|---|---|
| Name | Manual entry | Free label |
| ISIN | Manual entry | Optional |
| Yahoo Ticker | Manual entry, **validated** | See [section 9](#9-ticker-formats) |
| Broker | Selection | Configurable list in Options |
| Class | Selection | Configurable list in Options |
| **Currency** | **Read-only, inferred from ticker** | See [section 8](#8-currencies--complete-guide) |
| Qty | **Computed** | Sum of purchases |
| Avg cost (PRU) | **Computed** | Total invested / total quantity |
| Invested | **Computed** | Sum (qty × price + fees) across all purchases |
| Live price | Sync or manual | Color based on freshness |
| Valuation | **Computed** | Qty × live price |
| Chg. | **Computed** | (Valuation − Invested) / Invested |
| P&L | **Computed** | Valuation − Invested |
| Weight | **Computed** | % of the tab's total invested |

### Ticker entry

The currency field is no longer editable. Each time the ticker is modified, the currency is automatically recalculated from the Yahoo Finance suffix (see [section 9](#9-ticker-formats)).

If a ticker with an unrecognized suffix is entered, the change is **rejected**: an error message at the bottom of the screen lists the accepted suffixes and the previous value is restored.

Clearing a ticker resets the currency to `—`.

> **Important:** when the ticker changes, the live price is **invalidated** automatically (livePrice reset to null, ⚪ status indicator). A new sync is needed to fetch the price in the corresponding currency.

### Purchase sub-table
Clicking a row expands the purchase details. Each purchase row contains:
- Date, Qty, Price, Fees
- Lot total = `qty × price + fees`
- Lot avg cost = `total / qty`

The **Total** row shows the overall quantity, cumulative fees, total invested, and overall WAC.

### Live price status indicators

| Color | Meaning |
|---|---|
| 🟢 Green | Price fetched or entered today |
| 🟡 Yellow | Existing price but stale (date ≠ today) |
| 🔴 Red | Last sync failed |
| ⚪ White | Never synced (or invalidated after ticker change) |

---

## 4. Cryptos tab

Works like the CTO tab with the following differences:

| Field | CTO | Crypto |
|---|---|---|
| Identifier | Yahoo Ticker (`CW8.PA`) | Composite ticker (`bitcoin:usd`) |
| ISIN | Yes | No |
| Broker / Class | Yes | No |
| Price source | Yahoo Finance | CoinGecko |
| **Currency** | Inferred from Yahoo suffix | **Inferred from `id:currency` format** |

### Ticker entry

The expected format is `id:currency` (see [section 9](#9-ticker-formats)). Each time the ticker is modified, the currency is recalculated. An invalid format is rejected with an error message at the bottom of the screen.

As with CTO, changing the ticker invalidates the live price (sync required).

---

<a id="5-sales-tabs"></a>

## 5. CTO Sales / Crypto Sales tabs

Record of completed disposals (partial or full sales).

### Entry logic

Each row represents **a symmetric disposal**: same quantity for both the buy and the sell side.

| Field | Content |
|---|---|
| Sell date | Date of the sale |
| **FX S** | **Exchange rate (native currency → Options currency) at the sell date** |
| Name | Asset label |
| **Ticker** | **Sale identifier** (CTO or Crypto) |
| Currency | **Read-only, inferred from ticker** |
| Qty | Quantity sold |
| Unit sell price | Unit sell price (in native currency) |
| Sell fees | Brokerage fees on the sale (in native currency) |
| Total S | `(qty × unit sell price − sell fees) × fxRateSell` — in Options currency |
| Buy date | Reference buy date |
| **FX B** | **Exchange rate (native currency → Options currency) at the buy date** |
| Buy avg cost | Unit cost (calculated manually from the position) |
| Buy fees | Proportional share of purchase fees for the quantity sold |
| Total B | `(qty × buy avg cost + buy fees) × fxRateBuy` — in Options currency |
| P&L | `Total S − Total B` — in Options currency |
| P&L % | `P&L / Total B` — ratio, currency-agnostic |

### Ticker validation

Same rules as the live screens:
- **CTO Sales**: Yahoo Finance suffix (see [section 9](#9-ticker-formats))
- **Crypto Sales**: `id:currency` format
- An invalid ticker is rejected with an error toast, the previous value is restored.

> **A sale's ticker is not linked to an existing position.** You can enter historical sales of assets you no longer hold without recreating the original position.

> **Important:** when selling a partial lot (e.g. 3 out of 10 shares purchased across multiple lots), enter `qty = 3`, `buy avg cost = overall WAC of the position`, `buy fees = proportional share of the original purchase fees`.

### Sales KPIs

A single **Realized P&L** KPI expressed in the **Options currency**, calculated using the FX rates fixed at each transaction date (fxRateSell and fxRateBuy). See [section 11](#11-historical-fx-rates-frankfurter) for full FX rate management.

- Sales without an FX rate (⚪ status indicator) are excluded from the total; their count is shown below the KPI in gray.
- A ⚠️ **No FX rate** KPI appears if at least one sale is missing a rate, prompting a re-sync.

### FX S and FX B columns

Each FX cell has an ✏️ button: clicking it opens an input box to enter the rate manually (useful if Frankfurter is unavailable or if you want to use your broker's exact rate). See [section 11](#11-historical-fx-rates-frankfurter).

---

<a id="6-history-tab"></a>

## 6. History tab

Manual entry of portfolio valuations as of December 31 each year.

| Field | Content |
|---|---|
| Year | Fiscal year |
| **Currency** | **Row entry currency** (EUR / USD / CHF) |
| Total | Total valuation as of 31/12 |
| (configurable asset classes) | Share by asset class |
| Crypto | Crypto share |

When a row is created, the default currency is the current Options currency. It can be changed row by row.

Values are entered in **each row's own currency**. When displayed on the Dashboard, each value is converted to the Options currency at today's rate, exactly like live positions.

> **The number and names of asset classes depend on the Options settings.** Adding a class makes it appear in all existing history rows (defaulting to 0).

This data feeds the line chart and annual snapshot table in the Dashboard.

---

<a id="7-options-tab"></a>

## 7. Options tab

### Reporting currency
Select EUR, USD, CHF, GBP, JPY, HKD or CNY then click **💾 Save** to apply.

**Exact scope of the currency change:**

| Screen / KPI | Currency used |
|---|---|
| Dashboard — Total valuation | **Options currency** (consolidation) |
| Dashboard — Pie charts | **Options currency** (converted at today's rate) |
| Dashboard — Annual trend chart + snapshot table | **Options currency** (converted from each history row's currency) |
| CTO tab — Top banner (total CTO valuation) | **Options currency** |
| Cryptos tab — Top banner (total Crypto valuation) | **Options currency** |
| Individual CTO and Crypto rows | Native currency (never converted) |
| Sales tabs — P&L KPIs | **Options currency** (via fixed FX rates — see [section 11](#11-historical-fx-rates-frankfurter)) |
| Individual Sales rows — Total S / Total B / P&L | **Options currency** (via fixed FX rates) |
| Individual Sales rows — Unit price / Avg cost / Fees | Native currency of the sale |
| History entry | Independent (each row has its own currency) |

**Changing the Options currency** updates all consolidated displays (Dashboard, top banners, Sales KPIs). It also invalidates the **fixed FX rates** for all sales (CTO Sales and Crypto Sales): a warning toast is displayed and rates switch to 🔴 (see [section 11](#11-historical-fx-rates-frankfurter)). 🟡 (manual) rates are preserved. Outside of sales, it invalidates no positions, triggers no live price re-sync, and pre-fills no fields.

### Brokers and asset classes
Configurable lists. Brokers and asset classes can be added, renamed, and deleted. A deletion first checks that no position (CTO or history row) references the item; otherwise it is blocked with an explicit message.

### Export / Import JSON
- **Export**: downloads `portfolio_data.json` — useful for backup or migration.
- **Import**: loads an existing JSON file and overwrites the current data.

### Export CSV (ZIP)
Clicking **Export** generates an `export_YYYYMMDD.zip` file containing
5 timestamped CSV files. See [section 15](#15-csv-export) for full details.

---

<a id="8-currencies--complete-guide"></a>

## 8. Currencies — complete guide

This is the most important concept to understand when using the tracker.

### Core principle

Seven currencies are supported: **EUR, USD, CHF, GBP (£), JPY (¥), HKD (HK$) and CNY (CN¥)**.

> **Note on JPY:** Japanese yen amounts are displayed without decimal places (e.g. ¥7,203, not ¥7,203.00), consistent with standard JPY notation.

| Amount type | Currency | Conversion |
|---|---|---|
| Purchase price, Avg cost (WAC), Invested | Native currency (= ticker currency) | Never converted |
| Live price, Per-row valuation | Native currency | Never converted |
| Per-row P&L (CTO and Crypto) | Native currency | Never converted |
| Values entered in History | Each row's native currency | Never converted at entry |
| KPI totals (Dashboard, CTO and Crypto top banners) | Options currency | Converted at today's rate |
| Annual trend chart + snapshot table (Dashboard) | Options currency | Converted at today's rate |
| **Total S / Total B / Realized P&L (Sales)** | **Options currency** | **Via fixed FX rates at each transaction date** |

> **Why not convert the invested amount?**
> Converting a historical purchase at today's exchange rate gives an inaccurate result. The EUR/USD rate in January 2023 is not the same as in 2026. Only the live valuation (today's price) can be meaningfully converted at today's rate.

### The ticker encodes the currency

This is the guiding principle:

- For **CTO** positions, the currency is determined by the **Yahoo Finance ticker suffix**.
- For **Crypto** positions, the currency is the part after `:` in the composite ticker.
- No Currency field is editable in the CTO, Crypto, CTO Sales, or Crypto Sales screens. All display the currency as read-only, calculated from the ticker.

See [section 9](#9-ticker-formats) for details on accepted formats.

### Impact of changing a ticker

When the ticker of a position or a sale is changed:

- The currency is immediately recalculated.
- If the new ticker is valid, **the live price is invalidated** (livePrice → null, ⚪ status indicator). A re-sync is needed.
- Stored purchases (`purchases[]`) remain unchanged but are **reinterpreted in the new currency**. For example, a purchase of 15,000 entered when the position was in USD will now display as 15,000 EUR if you switch the ticker to `bitcoin:eur`.
- On the Sales screens, if the new currency differs from the previous one, the fixed FX rates are invalidated (see [section 11](#11-historical-fx-rates-frankfurter)).

> This behavior is consistent with the "ticker encodes currency" design: it ensures a position is always single-currency and that everything is self-contained within the row. But it also means **changing the ticker of a position that has purchases implicitly changes the currency of all stored amounts.** The application detects the currency change and marks the affected FX rates with a 🔴 indicator.

### Exchange rates

The tracker uses **two distinct FX rate sources** depending on the use case:

**Daily rates** — fetched from Yahoo Finance at each synchronization (🔄 button):
- `EURUSD=X` : EUR/USD rate
- `EURCHF=X` : EUR/CHF rate
- `USDCHF=X` : USD/CHF rate
- `EURGBP=X` : EUR/GBP rate
- `EURJPY=X` : EUR/JPY rate
- `EURHKD=X` : EUR/HKD rate
- `EURCNY=X` : EUR/CNY rate

Stored in `portfolio_data.json` under the `fxRates` key, used for Dashboard consolidations and CTO/Crypto top banners.

**Historical rates** — fetched from the Frankfurter API (ECB), fixed at the date of each transaction (purchase / sale). Used to calculate realized P&L in the Sales screens. See [section 11](#11-historical-fx-rates-frankfurter) for full details.

---

<a id="9-ticker-formats"></a>

## 9. Ticker formats

This section describes the exact expected format for each ticker type. It is the authoritative reference for input validation.

<a id="ticker-cto"></a>

### Ticker CTO

Format: **native Yahoo Finance ticker** (e.g. `AAPL`, `CW8.PA`, `NESN.SW`).

The currency is inferred from the suffix:

| Suffix | Currency | Examples |
|---|---|---|
| (no suffix) | USD | `AAPL`, `MSFT`, `NVDA`, `BNPQY` |
| `.PA` `.AS` `.DE` `.F` `.MI` `.BR` `.LS` `.MC` | EUR | `CW8.PA`, `ASML.AS`, `SAP.DE`, `ENEL.MI` |
| `.SW` `.VX` | CHF | `NESN.SW`, `ROG.VX` |
| `.L` | GBP | `SHEL.L`, `AZN.L` |
| `.T` | JPY | `7203.T`, `6758.T` |
| `.HK` | HKD | `0700.HK`, `9988.HK` |
| `.SS` `.SZ` | CNY | `600519.SS`, `000858.SZ` |
| Any other suffix | **Rejected at entry** | `AAPL.XX`, `XYZ.JP`, etc. |

<a id="ticker-crypto"></a>

### Ticker Crypto

Format: **`id:currency`** (e.g. `bitcoin:usd`, `ethereum:eur`, `solana:chf`).

| Part | Rule |
|---|---|
| `id` (before the `:`) | CoinGecko identifier, lowercase. Must not be empty. |
| `:` | Required separator. Must appear exactly once in the ticker (e.g. bitcoin:usd — one colon, no more). |
| `currency` (after the `:`) | `eur`, `usd`, `chf`, `gbp`, `jpy`, `hkd` or `cny`. Case-insensitive at entry (normalized to lowercase). JPY amounts are displayed without decimal places. |

> **Important:** the `id` is the CoinGecko identifier, **not the symbol**:
> - ✅ `bitcoin:usd`, `ethereum:eur`, `solana:chf`, `cardano:gbp`, `bitcoin:jpy`, `ethereum:hkd`, `solana:cny`
> - ❌ `BTC:USD`, `ETH:EUR`, `SOL:USD` (symbols are not recognized by the CoinGecko API)

**Where to find the CoinGecko `id`?**
On coingecko.com, the `id` appears in the URL of the coin's page. For example, `coingecko.com/en/coins/bitcoin` → the `id` is `bitcoin`. The symbol `BTC` displayed next to the name is different and does not work with the API.

### Entry and rejection

On every ticker change (CTO or Crypto, live screens or Sales):
- If the ticker is empty → accepted, currency reset to `—`.
- If the ticker is valid → accepted, currency recomputed, **live price invalidated** on live screens.
- If the ticker is invalid → **rejected**, an error toast at the bottom of the screen lists the expected format, and the previous value is restored.

---

<a id="10-yahoo-finance-api"></a>

## 10. Yahoo Finance API

This section covers everything related to Yahoo Finance: the Python library, ticker formats, live price states, and troubleshooting.

### Library and installation

The tracker uses the Python **yfinance** library to fetch CTO prices.

```bash
pip install yfinance --break-system-packages
```

yfinance queries Yahoo Finance, a free source requiring no API key. Prices are fetched only when the sync button is clicked — never automatically.

Without `yfinance`, the tracker falls back to a direct Yahoo Finance API call (less reliable).

### Yahoo Finance ticker formats

Tickers follow Yahoo Finance naming conventions. The suffix determines the exchange and the position's native currency:

| Suffix | Exchange | Native currency |
|---------|--------|---------------|
| (none) | NYSE / NASDAQ (US) | USD |
| `.PA` | Euronext Paris | EUR |
| `.AS` | Euronext Amsterdam | EUR |
| `.DE` or `.F` | Xetra / Frankfurt | EUR |
| `.MI` | Borsa Italiana | EUR |
| `.BR` | Euronext Brussels | EUR |
| `.LS` | Euronext Lisbon | EUR |
| `.MC` | Bolsa de Madrid | EUR |
| `.SW` or `.VX` | SIX Swiss Exchange | CHF |
| `.L` | London Stock Exchange | GBP |
| `.T` | Tokyo Stock Exchange | JPY |
| `.HK` | Hong Kong Stock Exchange | HKD |
| `.SS` | Shanghai Stock Exchange | CNY |
| `.SZ` | Shenzhen Stock Exchange | CNY |

Examples: `AAPL` (Apple, USD), `CW8.PA` (MSCI World ETF, EUR), `NESN.SW` (Nestlé, CHF), `SHEL.L` (Shell, GBP), `7203.T` (Toyota, JPY), `0700.HK` (Tencent, HKD), `600519.SS` (Moutai, CNY)

The native currency is automatically inferred from the suffix when the ticker is entered. Tickers with unrecognized suffixes are rejected — the tracker displays an error and reverts to the previous value (see [section 9](#9-ticker-formats) for the full list and validation rules).

### Live price states (status indicators)

| Indicator | Meaning | Condition |
|----------|---------------|-----------|
| ⚪ | Never synced | No sync performed |
| 🟢 | Today's price | Sync date = today |
| 🟡 | Stale price | Sync date ≠ today |
| 🔴 | Sync failed | Yahoo Finance unreachable or invalid ticker |

A 🟡 price is still used in calculations (P&L, valuation) but may no longer reflect current market conditions.

### Yahoo Finance troubleshooting

- **Invalid ticker** → verify on [finance.yahoo.com](https://finance.yahoo.com) that the ticker exists and its suffix is in the list above.
- **Full failure (🔴 everywhere)** → Yahoo Finance temporarily unavailable, or `yfinance` not installed (`pip install yfinance --break-system-packages`).
- **Price missing from Dashboard** → a position without a live price (⚪ or 🔴) is excluded from Dashboard KPIs and pie charts.

---

<a id="11-historical-fx-rates-frankfurter"></a>

## 11. Historical FX rates (Frankfurter)

### Overview

The CTO Sales and Crypto Sales screens display realized P&L in the Options currency (configured in ⚙️ Options). To convert native amounts (USD, CHF, EUR) to this currency, the tracker uses **FX rates fixed at each transaction date** (buy and sell), not the current rate.

This matches standard broker behavior (Swissquote, etc.): realized P&L in account currency is calculated at the rate in effect on each transaction date, not the current rate.

Each sale stores two independent rates:
- **fxRateBuy**: rate (native currency → Options currency) at the buy date
- **fxRateSell**: rate (native currency → Options currency) at the sell date

**P&L in Options currency** = (Sale total × fxRateSell) − (Buy total × fxRateBuy)

### Rate source — Frankfurter API

| Attribute | Value |
|---|---|
| Source | https://api.frankfurter.dev/ (free service, no API key) |
| Data | Official European Central Bank (ECB) rates |
| Coverage | From January 4, 1999 (first business day post-euro) |
| Updated | Once per business day, around 4:00 PM CET |
| Currencies | EUR, USD, CHF, GBP, JPY, HKD, CNY (all supported currencies) |

API response format (example USD → EUR on 2024-01-15):
```json
{"amount": 1.0, "base": "USD", "date": "2024-01-15", "rates": {"EUR": 0.91366}}
```

**Special cases:**

- **Weekend or ECB holiday**: the API automatically returns the rate from the last business day. No action required. Example: a sale on Saturday May 23 will use the rate from Friday May 22.
- **Date before 1999 or future date**: the API returns an error. The row remains without a rate (⚪) — manual entry required.
- **Native currency = Options currency**: the rate is automatically 1.0 (no network call, source `auto`). Example: selling a EUR stock with Options = EUR.

### FX rate states (status indicators)

Each FX rate (buy and sell) has an independent state, shown as a status indicator in the Sales table. The ✏️ button opens a manual entry input.

| Indicator | Source | Meaning | Recommended action |
|----------|--------|---------------|--------------------|
| ⚪ | `null` | No rate entered | Click 🔄 Sync FX rates |
| 🟢 | `ok` | Frankfurter rate up to date | Nothing |
| 🟢 | `auto` | Automatic rate (= 1.0, same currency) | Nothing |
| 🟡 | `manual` | Manually entered rate | Overwritten at next FX sync |
| 🔴 | `ko` | Stale rate (date or currency changed) | Re-sync |

When a rate switches to 🔴, the previously calculated value is **kept** for reference but is no longer used in calculations until re-synced.

### Rate synchronization

The **🔄 Sync FX rates** button in the toolbar of each Sales screen:

- Queries the Frankfurter API for all ⚪ or 🔴 rows
- **Overwrites** 🟡 (manual) rows: sync is date-based, not source-based
- **Skips** 🟢 rows that are already up to date
- Displays a result toast: `FX rates: N OK / M failed`

### Manual rate entry

Clicking the ✏️ button on an FX cell opens an input box.

Enter the exchange rate (e.g. `1.0742` for 1 USD = 1.0742 EUR).

The source switches to 🟡 `manual`. This rate will be **overwritten** by the next FX sync.

**Use cases:** Frankfurter unavailable, historical rate not available (before 1999), or exact broker rate preferred — in the latter case, do not re-sync after entry.

### Automatic rate invalidation

Rates automatically switch to 🔴 (`ko`) in the following cases:

| User action | Rate invalidated |
|---|---|
| **Buy date** changed | fxRateBuy |
| **Sell date** changed | fxRateSell |
| **Ticker change** (if the native currency changes) | fxRateBuy and fxRateSell |
| **Options currency changed** in ⚙️ Options | All rates for all sales |

🟡 (manual) rates follow the same invalidation rules: they switch to 🔴 if the date or currency is changed.

When the Options currency changes, an orange **warning toast** is displayed: `⚠️ Display currency changed — FX rates for exits invalidated. Please re-sync.`

> 🟡 (manual) rates are also invalidated in this case. To preserve an exact broker rate after an Options currency change, re-enter it manually after the re-sync.

---

<a id="12-calculations"></a>

## 12. Calculations

This section details all calculation formulas used by the tracker. All position and sale calculations are performed in the **native currency** (the currency inferred from the ticker); conversion to the Options currency only occurs at Dashboard consolidation level and in the CTO/Crypto top banners.

### 12.1 Position calculations (CTO or Crypto)

From a position containing one or more purchases (`purchases[]`), each with `qty`, `price` and `fees`, and an optional `livePrice`, six values are computed:

#### Total quantity (`tq`)

```
tq = Σ purchases[i].qty
```

Sum of quantities across all purchase lots.

*Example: 2 purchase lots of 10 and 5 shares → `tq = 15`.*

#### Total invested (`ti`)

```
ti = Σ (purchases[i].qty × purchases[i].price + purchases[i].fees)
```

For each lot, the purchase value (`qty × price`) is added to the brokerage fees for that lot. The sum across all lots gives the total invested.

*Example:*
- *Lot 1: 10 shares at 150 € + 5 € in fees → 1,505 €*
- *Lot 2: 5 shares at 160 € + 5 € in fees → 805 €*
- `ti = 2,310 €`

#### Weighted average cost — WAC (`pru`)

```
pru = ti / tq   (si tq > 0, sinon 0)
```

Fee-inclusive weighted average cost per unit.

*Example using the previous values: `pru = 2,310 / 15 = 154 €`.*

#### Valuation (`valo`)

```
valo = tq × livePrice   (si livePrice présent, sinon 0)
```

Current value of the position at the live price. If no live price is available, valuation is 0 and the position is excluded from Dashboard KPIs.

*Example: 15 shares × 175 € live price → `valo = 2,625 €`.*

#### P&L — Unrealized gain/loss (`gp`)

```
gp = valo − ti
```

Difference between current value and total invested. Positive = unrealized gain, negative = unrealized loss.

*Example: `gp = 2,625 − 2,310 = +315 €`.*

#### Chg — Percentage change (`evol`)

```
evol = (valo − ti) / ti   (si ti > 0, sinon 0)
```

Percentage change relative to the total invested.

*Example: `evol = 315 / 2,310 ≈ 13.6%`.*

### 12.2 Sale calculations (CTO Sales and Crypto Sales)

From a sale row containing `qSold`, `priceSell`, `feesSell`, `priceBuy`, `feesBuy`, `fxRateSell` and `fxRateBuy`, the following values are computed:

#### Native sale total (`ts`)

```
ts = qSold × priceSell − feesSell
```

Net amount received from the sale, in native currency, after deducting brokerage fees.

*Example: 5 shares sold at 200 € with 5 € in fees → `ts = 995 €`.*

#### Native buy total (`tb`)

```
tb = qSold × priceBuy + feesBuy
```

Initial amount invested for the sold units: purchase price × quantity, plus the proportional share of buy fees. A proportional `feesBuy` must be entered for the quantity being sold (see [section 5](#5-sales-tabs)).

*Example: 5 shares at a WAC of 150 € + 2.50 € in fees (proportional share) → `tb = 752.50 €`.*

#### Sale total in Options currency (`tsOpt`)

```
tsOpt = ts × fxRateSell
```

*Example (USD→EUR, fxRateSell = 0.92): `tsOpt = 995 × 0.92 = 915.40 €`.*

#### Buy total in Options currency (`tbOpt`)

```
tbOpt = tb × fxRateBuy
```

*Example (USD→EUR, fxRateBuy = 0.94): `tbOpt = 752.50 × 0.94 = 707.35 €`.*

#### Realized P&L in Options currency (`gpOpt`)

```
gpOpt = tsOpt − tbOpt
```

Actual gain or loss realized, expressed in the Options currency.

*Example: `gpOpt = 915.40 − 707.35 = +208.05 €`.*

> If `fxRateSell` or `fxRateBuy` is null, the Total S, Total B and P&L columns display `—` and the sale is excluded from the consolidated KPI.

#### P&L % (`pct`)

```
pct = (ts − tb) / tb   (si tb > 0, sinon 0)
```

Realized return as a percentage. This ratio is calculated in the native currency — it is currency-agnostic and always displayed, even without FX rates.

*Example: `pct = 242.50 / 752.50 ≈ 32.2%`.*

### 12.3 Currency conversion

The `convert(amount, fromCur, toCur)` function converts amounts between EUR, USD, CHF, GBP, JPY, HKD and CNY using the rates stored in `fxRates`. EUR ↔ USD and EUR ↔ CHF use direct Yahoo Finance rates (`EURUSD=X`, `EURCHF=X`, `USDCHF=X`). Conversions involving GBP, JPY, HKD or CNY use EUR-based rates (`EURGBP=X`, `EURJPY=X`, `EURHKD=X`, `EURCNY=X`); cross-currency conversions not involving EUR (e.g. GBP → USD) triangulate through EUR.

| From → To | Formula |
|---|---|
| EUR → USD | `amount × eurusd` |
| EUR → CHF | `amount × eurchf` |
| USD → EUR | `amount / eurusd` |
| USD → CHF | `amount × usdchf` |
| CHF → EUR | `amount / eurchf` |
| CHF → USD | `amount / usdchf` |

GBP, JPY, HKD and CNY conversions all triangulate through EUR. For example: GBP → USD = `amount / eurgbp × eurusd`; JPY → CHF = `amount / eurjpy × eurchf`.

If source and destination currencies are the same, the amount is returned unchanged. If the required rate is not available in `fxRates` (never synced), the conversion returns `null` and the value is treated as unavailable in downstream calculations.

*Example: converting 1,000 USD to EUR with `eurusd = 1.08` → `1,000 / 1.08 ≈ 925.93 €`.*

### 12.4 Dashboard consolidation and CTO/Crypto top banners

#### Total valuation (main Dashboard KPI and top banners)

```
Valo totale = Σ convert(position.valo, position.currency, deviseOptions)
```

The valuations of all live positions are summed after individual conversion to the Options currency. Positions without a `livePrice` or with missing FX data are silently excluded; an `excludedCount` indicator appears in the Dashboard.

*Example, Options currency = EUR, two positions:*
- *AAPL: valo = 2,000 USD, converted with `eurusd = 1.08` → 1,851.85 €*
- *CW8.PA: valo = 1,500 €, already in EUR → 1,500 €*
- *Total Dashboard valuation = 3,351.85 €*

#### Consolidated total invested

```
Investi total = Σ convert(position.ti, position.currency, deviseOptions)
```

Same logic as for valuation, applied to total invested amounts. Used to calculate the consolidated P&L.

> ⚠️ **Converted at today's rate** — Purchases are historical but converted at today's rate since no per-purchase historical rate is stored. This is an acknowledged approximation: it is consistent for comparing valuation and invested amounts (both converted at the same rate), but does not exactly reflect what was paid in Options currency at the time of purchase.

#### Consolidated P&L and percentage

```
G/P consolidé = Valo totale − Investi total
%             = G/P consolidé / Investi total
```

Calculated from the values already converted to the Options currency.

### 12.5 Dashboard pie charts

The four pie charts (by asset class, by broker, CTO positions, Crypto positions) use **valuations converted to the Options currency**, exactly like the main KPI. Positions with unavailable FX data are excluded. No specific calculation: these are views of the same aggregated value grouped by different keys.

### 12.6 Annual trend chart

```
Pour chaque année h ∈ historique :
  point.y = convert(h.total, h.currency, deviseOptions)
```

Each history row is converted from its own currency to the Options currency. Years for which the conversion returns `null` (missing FX) are excluded from the chart.

The annual change in the table below the chart is calculated **after conversion**, i.e. in the Options currency:

```
Variation année N = (h[N].total_converti − h[N−1].total_converti) / h[N−1].total_converti
```

### 12.7 Realized P&L KPI (Sales)

The realized P&L is displayed in the **Options currency**, consolidated across all sales with available fixed FX rates:

```
gpTotal = Σ gpOpt pour les cessions avec fxRateBuy != null et fxRateSell != null
```

Sales without a rate (⚪ status indicator) are excluded from this total and counted separately (shown below the KPI in gray). A ⚠️ No FX rate KPI lists the number of incomplete sales.

The P&L % for each individual row remains in the native currency (currency-agnostic ratio, always displayed even without FX rates).

See [section 11](#11-historical-fx-rates-frankfurter) for complete management of fixed FX rates.

---

<a id="13-price-synchronization"></a>
## 13. Price synchronization

### 🔄 Sync all prices button (header)
Simultaneously triggers:
1. CTO price fetch via Yahoo Finance
2. Crypto price fetch via CoinGecko (grouped by currency)
3. FX rate fetch via Yahoo Finance

### Per-tab 🔄 buttons
- **Sync CTO prices**: Yahoo Finance only + FX
- **Sync Crypto prices**: CoinGecko only + FX

### 🔄 Sync FX rates button (Sales screens)
Dedicated to historical FX rates for sales. Queries Frankfurter for all rows without a valid rate. See [section 11](#11-historical-fx-rates-frankfurter).

### Sync result toast
Displays for each type:
- `Stocks: N ✅ M ❌` with the list of failed tickers in parentheses.
- `Crypto: N ✅ M ❌` with the list of failed composite tickers.

A total failure on cryptos (`0 ✅`) usually indicates an identifier issue: use the CoinGecko `id`, not the symbol (see [section 9](#ticker-crypto)).

### Prerequisites for CTO prices
```bash
pip install yfinance --break-system-packages
```
Without `yfinance`, the tracker falls back to a direct Yahoo Finance API call (less reliable).

### Manual price entry ✏️
Each position has an ✏️ button for manual price entry. Useful for unlisted assets or when synchronization fails. The entered price is treated as today's price (🟢 indicator).

> **Warning:** a manually entered price will be **overwritten** by the next sync (🔄 button). If Yahoo Finance or CoinGecko return a price for that ticker, it will replace the entered value.

### Behavior after a ticker change
The live price is invalidated. No automatic sync is triggered at this point: a sync must be launched explicitly. This avoids unnecessary network calls during successive keystrokes (corrections, hesitations).

---

<a id="14-data-and-storage"></a>
## 14. Data and storage

### File `portfolio_data.json`

Every change made in the interface is **saved immediately** to this file. There is no global Save button.

### File structure

```json
{
  "settings": {
    "currency": "eur",
    "brokers": ["Broker 1", "Broker 2"],
    "classes": ["Stocks", "Metals", "Real estate"]
  },
  "cto": [
    {
      "id": 1,
      "name": "Apple",
      "isin": "US0378331005",
      "ticker": "AAPL",
      "broker": "Broker 1",
      "classe": "Actions",
      "currency": "usd",
      "purchases": [ {"date": "...", "qty": 10, "price": 150, "fees": 5} ],
      "livePrice": 180,
      "priceSource": "auto",
      "priceDate": "2026-05-23 10:30:00"
    }
  ],
  "crypto": [
    {
      "id": 1,
      "name": "Bitcoin",
      "ticker": "bitcoin:usd",
      "currency": "usd",
      "purchases": [ ... ],
      "livePrice": 95000,
      "priceSource": "auto",
      "priceDate": "..."
    }
  ],
  "ctoTrades": [
    {
      "id": 1,
      "sellDate": "2024-03-15",
      "name": "Apple",
      "ticker": "AAPL",
      "currency": "usd",
      "qSold": 5,
      "priceSell": 200,
      "feesSell": 5,
      "buyDate": "2023-01-10",
      "priceBuy": 150,
      "feesBuy": 2.5,
      "fxRateSell": 0.9137,
      "fxRateSellSource": "ok",
      "fxRateBuy": 0.9411,
      "fxRateBuySource": "ok"
    }
  ],
  "cryptoTrades": [ ... ],
  "historique": [
    {
      "year": 2025,
      "currency": "eur",
      "total": 100000,
      "crypto": 20000,
      "classes": { "Stocks": 50000, "Metals": 10000, "Real estate": 20000 }
    }
  ],
  "ctoDivs": [],
  "fxRates": { "eurusd": 1.08, "eurchf": 0.96, "usdchf": 0.89, "eurgbp": 0.85, "eurjpy": 163.2, "eurhkd": 8.41, "eurcny": 7.78 }
}
```

**`fxRateBuySource` / `fxRateSellSource` values:**

| Value | Meaning |
|---|---|
| `null` | No rate entered |
| `"ok"` | Frankfurter rate up to date |
| `"auto"` | Automatic rate (= 1.0, native currency = Options currency) |
| `"manual"` | Manually entered rate (never overwritten automatically) |
| `"ko"` | Stale rate (date or currency changed since last sync) |

### Recommended backup
The JSON file can be copied, versioned (git), or exported from the Options tab. It is human-readable and can be edited manually if needed.

---

<a id="15-csv-export"></a>
## 15. CSV export

### Overview
The **Export** button in the Options tab generates a timestamped ZIP file
(`export_YYYYMMDD.zip`) downloadable directly from the browser.
The ZIP contains 5 CSV files, one per data type.

No external dependency: the export uses only the Python standard
library (`csv`, `zipfile`, `io`).

### Generated files

| File | Content |
|---|---|
| `cto_live.csv` | Active CTO positions with individual purchase detail |
| `crypto_live.csv` | Active Crypto positions with individual purchase detail |
| `cto_sorties.csv` | CTO sales (realized trades) |
| `crypto_sorties.csv` | Crypto sales (realized trades) |
| `historique.csv` | Annual portfolio history |

### Live file structure (CTO and Crypto)

The `cto_live.csv` and `crypto_live.csv` files use a two-level
row structure, identified by the `row_type` column:

| `row_type` value | Meaning |
|---|---|
| `position` | Position summary row (overall WAC, valuation, P&L, chg%, weight%) |
| `achat` | Individual purchase detail row |

An empty row separates each position+purchases block in the CSV.

> **Note:** `live_price` is rounded to 2 decimal places in the export.

### Columns per file

**`cto_live.csv`** — 24 columns

| # | Colonne |
|---|---|
| 1 | `row_type` |
| 2 | `id` |
| 3 | `name` |
| 4 | `ticker` |
| 5 | `isin` |
| 6 | `broker` |
| 7 | `classe` |
| 8 | `currency` |
| 9 | `qty_total` |
| 10 | `pru` |
| 11 | `total_investi` |
| 12 | `live_price` |
| 13 | `valo` |
| 14 | `evol_pct` |
| 15 | `gp` |
| 16 | `repartition_pct` |
| 17 | `price_source` |
| 18 | `price_date` |
| 19 | `purchase_date` |
| 20 | `purchase_qty` |
| 21 | `purchase_price` |
| 22 | `purchase_fees` |
| 23 | `purchase_total_investi` |
| 24 | `purchase_pru_lot` |

**`crypto_live.csv`** — 21 columns

| # | Colonne |
|---|---|
| 1 | `row_type` |
| 2 | `id` |
| 3 | `name` |
| 4 | `ticker` |
| 5 | `currency` |
| 6 | `qty_total` |
| 7 | `pru` |
| 8 | `total_investi` |
| 9 | `live_price` |
| 10 | `valo` |
| 11 | `evol_pct` |
| 12 | `gp` |
| 13 | `repartition_pct` |
| 14 | `price_source` |
| 15 | `price_date` |
| 16 | `purchase_date` |
| 17 | `purchase_qty` |
| 18 | `purchase_price` |
| 19 | `purchase_fees` |
| 20 | `purchase_total_investi` |
| 21 | `purchase_pru_lot` |

**`cto_sorties.csv`** — 16 columns

| # | Colonne |
|---|---|
| 1 | `id` |
| 2 | `name` |
| 3 | `ticker` |
| 4 | `isin` |
| 5 | `currency` |
| 6 | `buyDate` |
| 7 | `priceBuy` |
| 8 | `feesBuy` |
| 9 | `fxRateBuy` |
| 10 | `fxRateBuySource` |
| 11 | `sellDate` |
| 12 | `qSold` |
| 13 | `priceSell` |
| 14 | `feesSell` |
| 15 | `fxRateSell` |
| 16 | `fxRateSellSource` |

**`crypto_sorties.csv`** — 15 columns

| # | Colonne |
|---|---|
| 1 | `id` |
| 2 | `name` |
| 3 | `ticker` |
| 4 | `currency` |
| 5 | `buyDate` |
| 6 | `priceBuy` |
| 7 | `feesBuy` |
| 8 | `fxRateBuy` |
| 9 | `fxRateBuySource` |
| 10 | `sellDate` |
| 11 | `qSold` |
| 12 | `priceSell` |
| 13 | `feesSell` |
| 14 | `fxRateSell` |
| 15 | `fxRateSellSource` |

**`historique.csv`** — dynamic columns

| # | Colonne |
|---|---|
| 1 | `year` |
| 2 | `currency` |
| 3 | `total` |
| 4 | `crypto` |
| 5+ | `class_<clé>` (une colonne par classe, clés triées alphabétiquement) |

`currency` is injected from the settings (`settings.currency`). The `class_<key>` columns are generated dynamically from the union of all `classes` keys present in the history, sorted alphabetically.

---

<a id="16-upcoming-features"></a>
## 16. Upcoming features

### Dividends (CTO)

The data structure already includes a `ctoDivs` field in the JSON file, but the interface is not yet implemented.

Open questions before development:
- Per-position entry or global per year?
- Gross or net-of-tax dividends?
- Impact on overall P&L calculation (total return = capital gain + dividends)?
- Display in the Dashboard (dedicated KPI? integrated into P&L?)
- Should crypto staking income (validation rewards, DeFi interest) have a separate tab? The tax and accounting nature of staking differs from stock dividends — same tab or two separate tabs?

### Additional currency support

This feature is now implemented. GBP (£), JPY (¥), HKD (HK$) and CNY (CN¥) are fully supported alongside EUR, USD and CHF. See [section 8](#8-currencies--complete-guide) for the currencies guide and [section 9](#9-ticker-formats) for the complete list of accepted ticker suffixes.

---

*Portfolio Tracker — May 2026*
