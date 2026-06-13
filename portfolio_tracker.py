#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════╗
║  PORTEFEUILLE — Tracker d'investissement 100% local         ║
║  Usage : python3 portfolio_tracker.py                        ║
║  Ouvre : http://localhost:8080                                ║
║  Données : portfolio_data.json (même dossier)                ║
╚══════════════════════════════════════════════════════════════╝
"""
import http.server, http.cookiejar, json, urllib.request, urllib.parse
import webbrowser, threading, ssl, csv, zipfile, io
from pathlib import Path
from datetime import datetime

# parse_crypto_ticker — source de vérité partagée avec static/app.js (parseCryptoTicker)
# Toute modification des devises acceptées ou de la logique de parsing
# doit être répercutée manuellement dans les deux fichiers.

PORT = 8080
DATA_FILE = Path(__file__).parent / "portfolio_data.json"
STATIC_DIR = Path(__file__).parent / "static"

DEFAULT_DATA = {
    "settings": {
        "currency": "usd",
        "brokers": [],
        "classes": []
    },
    "cto": [],
    "crypto": [],
    "ctoTrades": [],
    "cryptoTrades": [],
    "historique": [],
    "ctoDivs": []
}

def load_data():
    if DATA_FILE.exists():
        try: return json.loads(DATA_FILE.read_text(encoding="utf-8"))
        except: pass
    return DEFAULT_DATA

def save_data(data):
    DATA_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

def fetch_yahoo(tickers):
    result = {}
    if not tickers: return result
    try:
        import yfinance as yf
        for t in tickers:
            try:
                info = yf.Ticker(t).fast_info
                p = info.get("lastPrice") or info.get("regularMarketPrice")
                if p:
                    price = float(p)
                    currency = info.get("currency")
                    if currency == "GBp":
                        price /= 100
                        currency = "GBP"
                    result[t] = {"price": price, "currency": currency.lower() if currency else None}
            except: pass
        if result:
            print(f"  yfinance: {len(result)}/{len(tickers)}")
            return result
    except ImportError:
        print("  yfinance absent — tentative directe Yahoo")
    try:
        ctx = ssl.create_default_context()
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(jar),
            urllib.request.HTTPSHandler(context=ctx))
        H = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
             "Accept": "text/html,*/*;q=0.8", "Accept-Language": "fr-FR,fr;q=0.9"}
        opener.open(urllib.request.Request("https://finance.yahoo.com/", headers=H), timeout=10)
        crumb = opener.open(urllib.request.Request(
            "https://query1.finance.yahoo.com/v1/test/getcrumb",
            headers={**H, "Referer": "https://finance.yahoo.com/"}), timeout=10).read().decode().strip()
        if crumb and len(crumb) < 60:
            url = ("https://query1.finance.yahoo.com/v7/finance/quote"
                   f"?symbols={urllib.parse.quote(','.join(tickers))}"
                   f"&crumb={urllib.parse.quote(crumb)}&fields=regularMarketPrice")
            data = json.loads(opener.open(urllib.request.Request(
                url, headers={**H, "Referer": "https://finance.yahoo.com/"}), timeout=10).read())
            for q in data.get("quoteResponse", {}).get("result", []):
                s, p = q.get("symbol", ""), q.get("regularMarketPrice")
                if s and p: result[s] = {"price": float(p), "currency": None}
            print(f"  Yahoo crumb: {len(result)}/{len(tickers)}")
    except Exception as e:
        print(f"  Yahoo error: {e}")
    return result

def fetch_coingecko(ids, currency='eur'):
    result = {}
    if not ids: return result
    try:
        ctx = ssl.create_default_context()
        url = f"https://api.coingecko.com/api/v3/simple/price?ids={','.join(ids)}&vs_currencies={currency}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        data = json.loads(urllib.request.urlopen(req, timeout=10, context=ctx).read())
        for cid, prices in data.items():
            if currency in prices: result[cid] = prices[currency]
        print(f"  CoinGecko: {len(result)}/{len(ids)}")
    except Exception as e:
        print(f"  CoinGecko error: {e}")
    return result

def fetch_fx_rates():
    """Récupère les taux de change du jour via Yahoo Finance."""
    pairs = {'eurusd': 'EURUSD=X', 'eurchf': 'EURCHF=X', 'usdchf': 'USDCHF=X',
             'eurgbp': 'EURGBP=X', 'eurjpy': 'EURJPY=X', 'eurhkd': 'EURHKD=X', 'eurcny': 'EURCNY=X'}
    result = {}
    try:
        import yfinance as yf
        for key, ticker in pairs.items():
            try:
                info = yf.Ticker(ticker).fast_info
                p = info.get("lastPrice") or info.get("regularMarketPrice")
                if p: result[key] = float(p)
            except: pass
        if result:
            print(f"  FX rates: {result}")
            return result
    except ImportError: pass
    try:
        ctx = ssl.create_default_context()
        tickers_str = ','.join(pairs.values())
        jar = http.cookiejar.CookieJar()
        opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(jar),
            urllib.request.HTTPSHandler(context=ctx))
        H = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
             "Accept": "text/html,*/*;q=0.8"}
        opener.open(urllib.request.Request("https://finance.yahoo.com/", headers=H), timeout=10)
        crumb = opener.open(urllib.request.Request(
            "https://query1.finance.yahoo.com/v1/test/getcrumb",
            headers={**H, "Referer": "https://finance.yahoo.com/"}), timeout=10).read().decode().strip()
        if crumb and len(crumb) < 60:
            url = (f"https://query1.finance.yahoo.com/v7/finance/quote"
                   f"?symbols={urllib.parse.quote(tickers_str)}"
                   f"&crumb={urllib.parse.quote(crumb)}&fields=regularMarketPrice")
            data = json.loads(opener.open(urllib.request.Request(
                url, headers={**H, "Referer": "https://finance.yahoo.com/"}), timeout=10).read())
            rev = {v: k for k, v in pairs.items()}
            for q in data.get("quoteResponse", {}).get("result", []):
                s, p = q.get("symbol", ""), q.get("regularMarketPrice")
                if s in rev and p: result[rev[s]] = float(p)
            print(f"  FX rates (crumb): {result}")
    except Exception as e:
        print(f"  FX rates error: {e}")
    return result


def fetch_fx_rate_at(base, target, date):
    """
    Récupère le taux historique base → target à la date donnée via Frankfurter.
    - base, target : codes devise 3 lettres ('USD', 'EUR', 'CHF'). Acceptés en
      minuscules aussi, normalisés en majuscules pour l'appel API.
    - date : str au format ISO 'YYYY-MM-DD' (garanti par l'UI depuis brief #0).
    Retourne un dict :
    - succès : {"ok": True, "rate": float, "source": "ok" | "auto"}
    - échec  : {"ok": False, "error": str}
    """
    if not date:
        return {"ok": False, "error": "date manquante"}
    BASE   = base.upper()
    TARGET = target.upper()
    if BASE == TARGET:
        return {"ok": True, "rate": 1.0, "source": "auto"}
    try:
        url = f"https://api.frankfurter.dev/v1/{date}?base={BASE}&symbols={TARGET}"
        req = urllib.request.Request(url, headers={"User-Agent": "portefeuille-tracker/2.19"})
        ctx = ssl.create_default_context()
        raw  = urllib.request.urlopen(req, timeout=10, context=ctx).read()
        data = json.loads(raw)
        if "message" in data:
            return {"ok": False, "error": data["message"]}
        rates = data.get("rates", {})
        if TARGET in rates:
            return {"ok": True, "rate": float(rates[TARGET]), "source": "ok"}
        return {"ok": False, "error": "réponse Frankfurter inattendue"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def parse_crypto_ticker(t):
    """Décompose un ticker crypto 'id:devise' → (id, devise) ou (None, None)."""
    if not t or not isinstance(t, str) or ":" not in t:
        return None, None
    parts = t.split(":")
    if len(parts) != 2:
        return None, None
    cid, cur = parts[0].strip(), parts[1].strip().lower()
    if not cid or cur not in ("eur", "usd", "chf", "gbp", "jpy", "hkd", "cny"):
        return None, None
    return cid, cur


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args): pass

    def send_json(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", len(body))
        self.end_headers(); self.wfile.write(body)

    def send_html(self, html):
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", len(body))
        self.end_headers(); self.wfile.write(body)

    def serve_static(self, filename):
        filepath = STATIC_DIR / filename
        if not filepath.exists():
            self.send_response(404); self.end_headers(); return
        ext = filepath.suffix.lower()
        content_types = {
            ".html": "text/html; charset=utf-8",
            ".css":  "text/css; charset=utf-8",
            ".js":   "application/javascript; charset=utf-8",
        }
        ct = content_types.get(ext, "application/octet-stream")
        body = filepath.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", len(body))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        try:
            if self.path == "/" or self.path == "/index.html":
                self.serve_static("index.html")
            elif self.path.startswith("/static/"):
                filename = self.path[len("/static/"):]
                self.serve_static(filename)
            elif self.path == "/api/data":        self.send_json(load_data())
            elif self.path == "/api/sync":        self.handle_sync("all")
            elif self.path == "/api/sync/cto":    self.handle_sync("cto")
            elif self.path == "/api/sync/crypto":   self.handle_sync("crypto")
            elif self.path == "/api/syncfx/cto":         self.handle_syncfx("cto")
            elif self.path == "/api/syncfx/crypto":       self.handle_syncfx("crypto")
            elif self.path == "/api/syncfx/historique":   self.handle_syncfx_historique()
            elif self.path == "/api/quit":          self.handle_quit()
            elif self.path == "/api/export":        self.handle_export()
            elif self.path == "/docs":              self.serve_static("docs.html")
            else: self.send_response(404); self.end_headers()
        except Exception as e:
            print(f"\033[91m✗ GET {self.path} → {e}\033[0m")
            import traceback; traceback.print_exc()
            self.send_json({"error": str(e), "stocks_ok":[],"stocks_fail":[],"crypto_ok":[],"crypto_fail":[],"data":load_data()}, 500)

    def do_POST(self):
        if self.path == "/api/data":
            n = int(self.headers.get("Content-Length", 0))
            save_data(json.loads(self.rfile.read(n).decode("utf-8")))
            self.send_json({"ok": True})
        else: self.send_response(404); self.end_headers()

    def handle_sync(self, scope="all"):
        data = load_data()
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        res = {"stocks_ok": [], "stocks_fail": [], "crypto_ok": [], "crypto_fail": []}

        if scope in ("all", "cto"):
            tickers = [p["ticker"] for p in data.get("cto", []) if p.get("ticker")]
            if tickers:
                yahoo = fetch_yahoo(tickers)
                for pos in data["cto"]:
                    t = pos.get("ticker", "")
                    if t in yahoo:
                        entry = yahoo[t]
                        pos["livePrice"] = entry["price"]; pos["priceSource"] = "auto"
                        pos["priceDate"] = now; res["stocks_ok"].append(t)
                        currency = entry.get("currency")
                        if currency is not None and pos.get("currency") != currency:
                            pos["currency"] = currency
                    elif t:
                        if pos.get("livePrice"): pos["priceSource"] = "stale"
                        res["stocks_fail"].append(t)

        if scope in ("all", "crypto"):
            # Grouper les cryptos par devise
            by_cur = {}
            for p in data.get("crypto", []):
                cid, cur = parse_crypto_ticker(p.get("ticker") or "")
                if cid and cur:
                    by_cur.setdefault(cur, []).append(cid)
            gecko_all = {}
            for cur, ids in by_cur.items():
                prices = fetch_coingecko(ids, cur)
                for cid, price in prices.items():
                    gecko_all[(cid, cur)] = price
            for pos in data["crypto"]:
                ticker = pos.get("ticker") or ""
                cid, cur = parse_crypto_ticker(ticker)
                if not ticker:
                    continue
                if not cid:
                    res["crypto_fail"].append(ticker)
                    continue
                key = (cid, cur)
                if key in gecko_all:
                    pos["livePrice"] = gecko_all[key]; pos["priceSource"] = "auto"
                    pos["priceDate"] = now; res["crypto_ok"].append(ticker)
                else:
                    if pos.get("livePrice"): pos["priceSource"] = "stale"
                    res["crypto_fail"].append(ticker)

        fx = fetch_fx_rates()
        if fx: data['fxRates'] = {**data.get('fxRates', {}), **fx}
        save_data(data)
        res["data"] = data
        self.send_json(res)

    def handle_syncfx(self, scope):
        """Sync des taux FX historiques (Frankfurter) pour ctoTrades ou cryptoTrades."""
        data = load_data()
        options_cur = data.get("settings", {}).get("currency", "eur")
        trades = data["ctoTrades"] if scope == "cto" else data["cryptoTrades"]
        fx_ok   = []
        fx_fail = []

        for trade in trades:
            trade_id = trade.get("id", "?")
            native = trade.get("currency")
            if not native:
                fx_fail.append({"id": trade_id, "error": "devise non définie"})
                continue

            for flow in ("buy", "sell"):
                date_field   = "buyDate"   if flow == "buy" else "sellDate"
                rate_field   = "fxRateBuy" if flow == "buy" else "fxRateSell"
                source_field = rate_field + "Source"
                date = trade.get(date_field)
                if not date:
                    continue
                r = fetch_fx_rate_at(native, options_cur, date)
                if r["ok"]:
                    trade[rate_field]   = r["rate"]
                    trade[source_field] = r["source"]
                    fx_ok.append({"id": trade_id, "flow": flow,
                                  "rate": r["rate"], "source": r["source"]})
                    print(f"  syncfx {scope} [{trade_id}] {flow}: "
                          f"{native}→{options_cur} @ {date} = {r['rate']} ({r['source']})")
                else:
                    fx_fail.append({"id": trade_id, "flow": flow, "error": r["error"]})
                    print(f"  syncfx {scope} [{trade_id}] {flow} ✗: {r['error']}")

        save_data(data)
        self.send_json({"fx_ok": fx_ok, "fx_fail": fx_fail, "data": data})

    def handle_syncfx_historique(self):
        """Sync des taux FX Frankfurter au 31/12 pour chaque ligne historique (⚪ et 🔴 uniquement)."""
        data = load_data()
        options_cur = data.get("settings", {}).get("currency", "eur")
        historique = data.get("historique", [])
        current_year = datetime.now().year
        fx_ok = 0
        fx_fail = 0

        for h in historique:
            year = h.get("year")
            if not year:
                continue
            source = h.get("fxRateSource")
            if source in ("frankfurter", "auto"):
                continue
            from_cur = (h.get("currency") or "eur").upper()
            to_cur   = options_cur.upper()
            if from_cur == to_cur:
                h["fxRate"]       = 1.0
                h["fxRateSource"] = "auto"
                fx_ok += 1
                continue
            if year < 1999:
                h["fxRateSource"] = "ko"
                fx_fail += 1
                continue
            if year >= current_year:
                date_str = datetime.now().strftime("%Y-%m-%d")
                r = fetch_fx_rate_at(from_cur, to_cur, date_str)
                if r["ok"]:
                    h["fxRate"]       = r["rate"]
                    h["fxRateSource"] = "today"
                    fx_ok += 1
                    print(f"  syncfx historique [{year}]: {from_cur}→{to_cur} today = {r['rate']}")
                else:
                    h["fxRateSource"] = "ko"
                    fx_fail += 1
                    print(f"  syncfx historique [{year}] ✗: {r['error']}")
            else:
                date_str = f"{year}-12-31"
                r = fetch_fx_rate_at(from_cur, to_cur, date_str)
                if r["ok"]:
                    h["fxRate"]       = r["rate"]
                    h["fxRateSource"] = "frankfurter"
                    fx_ok += 1
                    print(f"  syncfx historique [{year}]: {from_cur}→{to_cur} @ {date_str} = {r['rate']}")
                else:
                    h["fxRateSource"] = "ko"
                    fx_fail += 1
                    print(f"  syncfx historique [{year}] ✗: {r['error']}")

        save_data(data)
        self.send_json({"fx_ok": fx_ok, "fx_fail": fx_fail, "data": data})

    def handle_export(self):
        data = load_data()
        today = datetime.now().strftime("%Y%m%d")
        zip_name = f"export_{today}.zip"

        # ── Helpers ───────────────────────────────────────────────────────────

        def make_csv(headers, rows):
            """Sérialise headers + rows en bytes UTF-8 (séparateur virgule)."""
            buf = io.StringIO()
            writer = csv.DictWriter(buf, fieldnames=headers,
                                    extrasaction="ignore", restval="",
                                    lineterminator="\n")
            writer.writeheader()
            writer.writerows(rows)
            return buf.getvalue().encode("utf-8")

        def calc_pos(p):
            purchases = p.get('purchases', [])
            tq = sum((pu.get('qty') or 0) for pu in purchases)
            ti = sum((pu.get('qty') or 0) * (pu.get('price') or 0)
                     + (pu.get('fees') or 0) for pu in purchases)
            wac  = round(ti / tq, 2) if tq else 0
            live = round(p['livePrice'], 2) if p.get('livePrice') else None
            valo = round(tq * live, 2) if live else None
            gp   = round(valo - ti, 2) if live is not None else None
            evol = round((valo - ti) / ti * 100, 1) if (live and ti) else None
            return {'tq': tq, 'ti': round(ti, 2), 'wac': wac,
                    'live': live, 'valo': valo, 'gp': gp, 'evol': evol}

        def convert_fx(amount, from_cur, to_cur, fx):
            if amount is None or from_cur == to_cur: return amount
            f, t = from_cur.lower(), to_cur.lower()
            if t == 'eur':
                if f == 'usd': return amount / fx['eurusd'] if fx.get('eurusd') else None
                if f == 'chf': return amount / fx['eurchf'] if fx.get('eurchf') else None
                if f == 'gbp': return amount / fx['eurgbp'] if fx.get('eurgbp') else None
                if f == 'jpy': return amount / fx['eurjpy'] if fx.get('eurjpy') else None
                if f == 'hkd': return amount / fx['eurhkd'] if fx.get('eurhkd') else None
                if f == 'cny': return amount / fx['eurcny'] if fx.get('eurcny') else None
            if t == 'usd':
                if f == 'eur': return amount * fx['eurusd'] if fx.get('eurusd') else None
                if f == 'chf': return amount / fx['usdchf'] if fx.get('usdchf') else None
                if f == 'gbp': return amount / fx['eurgbp'] * fx['eurusd'] if (fx.get('eurgbp') and fx.get('eurusd')) else None
                if f == 'jpy': return amount / fx['eurjpy'] * fx['eurusd'] if (fx.get('eurjpy') and fx.get('eurusd')) else None
                if f == 'hkd': return amount / fx['eurhkd'] * fx['eurusd'] if (fx.get('eurhkd') and fx.get('eurusd')) else None
                if f == 'cny': return amount / fx['eurcny'] * fx['eurusd'] if (fx.get('eurcny') and fx.get('eurusd')) else None
            if t == 'chf':
                if f == 'eur': return amount * fx['eurchf'] if fx.get('eurchf') else None
                if f == 'usd': return amount * fx['usdchf'] if fx.get('usdchf') else None
                if f == 'gbp': return amount / fx['eurgbp'] * fx['eurchf'] if (fx.get('eurgbp') and fx.get('eurchf')) else None
                if f == 'jpy': return amount / fx['eurjpy'] * fx['eurchf'] if (fx.get('eurjpy') and fx.get('eurchf')) else None
                if f == 'hkd': return amount / fx['eurhkd'] * fx['eurchf'] if (fx.get('eurhkd') and fx.get('eurchf')) else None
                if f == 'cny': return amount / fx['eurcny'] * fx['eurchf'] if (fx.get('eurcny') and fx.get('eurchf')) else None
            if t == 'gbp':
                if f == 'eur': return amount * fx['eurgbp'] if fx.get('eurgbp') else None
                if f == 'usd': return amount / fx['eurusd'] * fx['eurgbp'] if (fx.get('eurusd') and fx.get('eurgbp')) else None
                if f == 'chf': return amount / fx['eurchf'] * fx['eurgbp'] if (fx.get('eurchf') and fx.get('eurgbp')) else None
                if f == 'jpy': return amount / fx['eurjpy'] * fx['eurgbp'] if (fx.get('eurjpy') and fx.get('eurgbp')) else None
                if f == 'hkd': return amount / fx['eurhkd'] * fx['eurgbp'] if (fx.get('eurhkd') and fx.get('eurgbp')) else None
                if f == 'cny': return amount / fx['eurcny'] * fx['eurgbp'] if (fx.get('eurcny') and fx.get('eurgbp')) else None
            if t == 'jpy':
                if f == 'eur': return amount * fx['eurjpy'] if fx.get('eurjpy') else None
                if f == 'usd': return amount / fx['eurusd'] * fx['eurjpy'] if (fx.get('eurusd') and fx.get('eurjpy')) else None
                if f == 'chf': return amount / fx['eurchf'] * fx['eurjpy'] if (fx.get('eurchf') and fx.get('eurjpy')) else None
                if f == 'gbp': return amount / fx['eurgbp'] * fx['eurjpy'] if (fx.get('eurgbp') and fx.get('eurjpy')) else None
                if f == 'hkd': return amount / fx['eurhkd'] * fx['eurjpy'] if (fx.get('eurhkd') and fx.get('eurjpy')) else None
                if f == 'cny': return amount / fx['eurcny'] * fx['eurjpy'] if (fx.get('eurcny') and fx.get('eurjpy')) else None
            if t == 'hkd':
                if f == 'eur': return amount * fx['eurhkd'] if fx.get('eurhkd') else None
                if f == 'usd': return amount / fx['eurusd'] * fx['eurhkd'] if (fx.get('eurusd') and fx.get('eurhkd')) else None
                if f == 'chf': return amount / fx['eurchf'] * fx['eurhkd'] if (fx.get('eurchf') and fx.get('eurhkd')) else None
                if f == 'gbp': return amount / fx['eurgbp'] * fx['eurhkd'] if (fx.get('eurgbp') and fx.get('eurhkd')) else None
                if f == 'jpy': return amount / fx['eurjpy'] * fx['eurhkd'] if (fx.get('eurjpy') and fx.get('eurhkd')) else None
                if f == 'cny': return amount / fx['eurcny'] * fx['eurhkd'] if (fx.get('eurcny') and fx.get('eurhkd')) else None
            if t == 'cny':
                if f == 'eur': return amount * fx['eurcny'] if fx.get('eurcny') else None
                if f == 'usd': return amount / fx['eurusd'] * fx['eurcny'] if (fx.get('eurusd') and fx.get('eurcny')) else None
                if f == 'chf': return amount / fx['eurchf'] * fx['eurcny'] if (fx.get('eurchf') and fx.get('eurcny')) else None
                if f == 'gbp': return amount / fx['eurgbp'] * fx['eurcny'] if (fx.get('eurgbp') and fx.get('eurcny')) else None
                if f == 'jpy': return amount / fx['eurjpy'] * fx['eurcny'] if (fx.get('eurjpy') and fx.get('eurcny')) else None
                if f == 'hkd': return amount / fx['eurhkd'] * fx['eurcny'] if (fx.get('eurhkd') and fx.get('eurcny')) else None
            return None

        def build_live_rows(positions, id_fields, headers):
            """
            Génère les lignes position / achat / séparateur pour un onglet live.
            id_fields : colonnes identitaires répétées sur les lignes 'achat'.
            """
            # Calcul de totI pour répartition_pct
            totI = 0.0
            for pos in positions:
                if not pos.get('livePrice'):
                    continue
                c = calc_pos(pos)
                v = convert_fx(c['ti'], pos.get('currency', ''), display_cur, fx)
                if v is not None:
                    totI += v

            E = ""  # cellule vide
            empty_row = {h: E for h in headers}
            rows = []
            for pos in positions:
                calc  = calc_pos(pos)
                ident = {k: pos.get(k, E) for k in id_fields}

                # repartition_pct : uniquement si totI > 0 et livePrice présent
                if totI and pos.get('livePrice'):
                    v = convert_fx(calc['ti'], pos.get('currency', ''), display_cur, fx)
                    rep = round(v / totI * 100, 1) if v is not None else E
                else:
                    rep = E

                # Ligne "position"
                rows.append({
                    **ident,
                    "row_type":               "position",
                    "qty_total":              calc['tq'],
                    "wac":                    calc['wac'],
                    "total_investi":          calc['ti'],
                    "live_price":             calc['live']  if calc['live']  is not None else E,
                    "valo":                   calc['valo']  if calc['valo']  is not None else E,
                    "evol_pct":               calc['evol']  if calc['evol']  is not None else E,
                    "gp":                     calc['gp']    if calc['gp']    is not None else E,
                    "repartition_pct":        rep,
                    "price_source":           pos.get('priceSource', E),
                    "price_date":             pos.get('priceDate',   E),
                    "purchase_date":          E, "purchase_qty":            E,
                    "purchase_price":         E, "purchase_fees":           E,
                    "purchase_total_investi": E, "purchase_lot_avg_cost":        E,
                })

                # Lignes "achat" (une par entrée purchases)
                for pu in pos.get('purchases') or []:
                    qty   = pu.get('qty')   or 0
                    price = pu.get('price') or 0
                    fees  = pu.get('fees')  or 0
                    pu_ti  = round(qty * price + fees, 2)
                    lot_avg_cost = round(pu_ti / qty, 2) if qty else E
                    rows.append({
                        **ident,
                        "row_type":               "achat",
                        "qty_total":              E, "wac":             E,
                        "total_investi":          E, "live_price":      E,
                        "valo":                   E, "evol_pct":        E,
                        "gp":                     E, "repartition_pct": E,
                        "price_source":           E, "price_date":      E,
                        "purchase_date":          pu.get('date',  E),
                        "purchase_qty":           pu.get('qty',   E),
                        "purchase_price":         pu.get('price', E),
                        "purchase_fees":          pu.get('fees',  E),
                        "purchase_total_investi": pu_ti,
                        "purchase_lot_avg_cost":       lot_avg_cost,
                    })

                # Ligne séparatrice (toutes cellules vides)
                rows.append(dict(empty_row))

            return rows

        fx          = data.get('fxRates', {})
        display_cur = data.get('settings', {}).get('currency', 'eur')

        # ── 1. CTO live ───────────────────────────────────────────────────────
        HEADERS_CTO_LIVE = [
            "row_type", "id", "name", "ticker", "isin", "broker", "classe", "currency",
            "qty_total", "wac", "total_investi", "live_price", "valo", "evol_pct", "gp",
            "repartition_pct", "price_source", "price_date",
            "purchase_date", "purchase_qty", "purchase_price", "purchase_fees",
            "purchase_total_investi", "purchase_lot_avg_cost",
        ]
        CTO_ID = ["id", "name", "ticker", "isin", "broker", "classe", "currency"]
        cto_live_rows = build_live_rows(data.get('cto', []), CTO_ID, HEADERS_CTO_LIVE)

        # ── 2. Crypto live ────────────────────────────────────────────────────
        HEADERS_CRYPTO_LIVE = [
            "row_type", "id", "name", "ticker", "currency",
            "qty_total", "wac", "total_investi", "live_price", "valo", "evol_pct", "gp",
            "repartition_pct", "price_source", "price_date",
            "purchase_date", "purchase_qty", "purchase_price", "purchase_fees",
            "purchase_total_investi", "purchase_lot_avg_cost",
        ]
        CRYPTO_ID = ["id", "name", "ticker", "currency"]
        crypto_live_rows = build_live_rows(data.get('crypto', []), CRYPTO_ID, HEADERS_CRYPTO_LIVE)

        # ── 3 & 4. Sorties CTO + Crypto (qBought exclu ; isin absent de crypto) ──
        HEADERS_CTO_SORTIES = [
            "id", "name", "ticker", "isin", "currency",
            "buyDate", "priceBuy", "feesBuy", "fxRateBuy", "fxRateBuySource",
            "sellDate", "qSold", "priceSell", "feesSell", "fxRateSell", "fxRateSellSource",
        ]
        HEADERS_CRYPTO_SORTIES = [
            "id", "name", "currency",
            "buyDate", "priceBuy", "feesBuy", "fxRateBuy", "fxRateBuySource",
            "sellDate", "qSold", "priceSell", "feesSell", "fxRateSell", "fxRateSellSource",
        ]
        cto_sorties_rows    = [{k: t.get(k, "") for k in HEADERS_CTO_SORTIES}
                               for t in data.get('ctoTrades', [])]
        crypto_sorties_rows = [{k: t.get(k, "") for k in HEADERS_CRYPTO_SORTIES}
                               for t in data.get('cryptoTrades', [])]

        # ── 5. Historique ─────────────────────────────────────────────────────
        # currency injectée depuis settings ; classes aplati en class_<clé> (union triée)
        historique = data.get('historique', [])
        all_class_keys = sorted({k for h in historique for k in (h.get('classes') or {})})
        HEADERS_HISTO  = ["year", "currency", "fxRate", "fxRateSource", "securities", "crypto", "total"] + [f"class_{k}" for k in all_class_keys]
        histo_rows = []
        for h in historique:
            row = {
                "year":         h.get('year',         ""),
                "currency":     h.get('currency', display_cur),
                "fxRate":       h.get('fxRate',       ""),
                "fxRateSource": h.get('fxRateSource', ""),
                "securities":   h.get('securities',   ""),
                "crypto":       h.get('crypto',       ""),
                "total":        h.get('total',        ""),
            }
            classes = h.get('classes') or {}
            for k in all_class_keys:
                row[f"class_{k}"] = classes.get(k, "")
            histo_rows.append(row)

        # ── Assemblage ZIP ────────────────────────────────────────────────────
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("cto_live.csv",       make_csv(HEADERS_CTO_LIVE,    cto_live_rows))
            zf.writestr("crypto_live.csv",    make_csv(HEADERS_CRYPTO_LIVE, crypto_live_rows))
            zf.writestr("cto_sorties.csv",    make_csv(HEADERS_CTO_SORTIES,    cto_sorties_rows))
            zf.writestr("crypto_sorties.csv", make_csv(HEADERS_CRYPTO_SORTIES, crypto_sorties_rows))
            zf.writestr("historique.csv",     make_csv(HEADERS_HISTO,       histo_rows))

        body = zip_buffer.getvalue()
        self.send_response(200)
        self.send_header("Content-Type", "application/zip")
        self.send_header("Content-Disposition", f'attachment; filename="{zip_name}"')
        self.send_header("Content-Length", len(body))
        self.end_headers()
        self.wfile.write(body)

    def handle_quit(self):
        self.send_json({"ok": True})
        threading.Timer(0.3, server.shutdown).start()

if __name__ == "__main__":
    print("╔══════════════════════════════════════════════════╗")
    print("║  📊 Portfolio Tracker — running locally         ║")
    print(f"║  → http://localhost:{PORT}                        ║")
    print(f"║  → Data file : {DATA_FILE.name}              ║")
    print("║  For stock prices :                             ║")
    print("║    pip install yfinance --break-system-packages ║")
    print("║  Ctrl+C to quit                                 ║")
    print("╚══════════════════════════════════════════════════╝")
    threading.Timer(1.0, lambda: webbrowser.open(f"http://localhost:{PORT}")).start()
    try:
        server = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 Stopped.")
        server.server_close()
