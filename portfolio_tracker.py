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
            elif self.path == "/api/syncfx/cto-purchases":    self.handle_syncfx_lots("cto")
            elif self.path == "/api/syncfx/crypto-purchases": self.handle_syncfx_lots("crypto")
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
        """Sync du taux FX de vente (Frankfurter) pour ctoTrades ou cryptoTrades.
        v2.0 : plus de volet achat. `currency` est structurellement toujours renseignée
        (copiée à la création, création bloquée sinon) — plus de garde-fou devise vide."""
        data = load_data()
        options_cur = data.get("settings", {}).get("currency", "eur")
        trades = data["ctoTrades"] if scope == "cto" else data["cryptoTrades"]
        fx_ok   = []
        fx_fail = []

        for trade in trades:
            trade_id = trade.get("id", "?")
            native = trade.get("currency")
            date = trade.get("sellDate")
            if not date:
                continue
            r = fetch_fx_rate_at(native, options_cur, date)
            if r["ok"]:
                trade["fxRateSell"]       = r["rate"]
                trade["fxRateSellSource"] = r["source"]
                fx_ok.append({"id": trade_id, "rate": r["rate"], "source": r["source"]})
                print(f"  syncfx {scope} [{trade_id}] sell: "
                      f"{native}→{options_cur} @ {date} = {r['rate']} ({r['source']})")
            else:
                fx_fail.append({"id": trade_id, "error": r["error"]})
                print(f"  syncfx {scope} [{trade_id}] sell ✗: {r['error']}")

        save_data(data)
        self.send_json({"fx_ok": fx_ok, "fx_fail": fx_fail, "data": data})

    def handle_syncfx_lots(self, scope):
        """Sync des taux FX historiques (Frankfurter) pour les lots d'achat cto[] ou crypto[].
        Même logique que handle_syncfx mais itère purchases[] au lieu des cessions :
        native = position.currency, date = lot.date. Retraite tous les lots datés."""
        data = load_data()
        options_cur = data.get("settings", {}).get("currency", "eur")
        positions = data["cto"] if scope == "cto" else data["crypto"]
        fx_ok   = []
        fx_fail = []

        for pos in positions:
            pos_id = pos.get("id", "?")
            native = pos.get("currency")
            for i, lot in enumerate(pos.get("purchases", [])):
                date = lot.get("date")
                if not date:
                    continue  # lot sans date : ignoré silencieusement (ni succès ni échec)
                if not native:
                    fx_fail.append({"id": pos_id, "lot": i, "error": "devise non définie"})
                    continue
                r = fetch_fx_rate_at(native, options_cur, date)
                if r["ok"]:
                    lot["fxRate"]       = r["rate"]
                    lot["fxRateSource"] = r["source"]
                    fx_ok.append({"id": pos_id, "lot": i,
                                  "rate": r["rate"], "source": r["source"]})
                    print(f"  syncfx {scope}-purchases [{pos_id}/{i}]: "
                          f"{native}→{options_cur} @ {date} = {r['rate']} ({r['source']})")
                else:
                    fx_fail.append({"id": pos_id, "lot": i, "error": r["error"]})
                    print(f"  syncfx {scope}-purchases [{pos_id}/{i}] ✗: {r['error']}")

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

        def calc_pos(p, trades):
            """Miroir Python de calcPos JS (spec Securities/Cryptos v3.0 §4.5).
            Duplication sensible : les deux implémentations doivent produire les mêmes
            tq/wac/wac_base/remaining ET le même wac_base_at(date) daté sur les mêmes
            données (spec §9). Valeurs NON arrondies (arrondi à l'écriture CSV)."""
            purchases = p.get('purchases', [])
            tq = sum((pu.get('qty') or 0) for pu in purchases)
            ti = sum((pu.get('qty') or 0) * (pu.get('price') or 0)
                     + (pu.get('fees') or 0) for pu in purchases)
            # tout-ou-rien : test sur fxRateSource, JAMAIS sur fxRate != null.
            # all([]) == True → tiBase = 0 si aucun lot (mais wacBase reste None car tq=0).
            all_fx = all((pu.get('fxRateSource') in ('ok', 'auto', 'manual')) for pu in purchases)
            ti_base = (sum(((pu.get('qty') or 0) * (pu.get('price') or 0) + (pu.get('fees') or 0))
                           * (pu.get('fxRate') or 0) for pu in purchases)
                       if all_fx else None)
            wac = ti / tq if tq else 0
            wac_base = ti_base / tq if (tq and ti_base is not None) else None

            # [v3.0] Accesseur DATÉ — miroir EXACT de wacBaseAt JS (Securities/Cryptos v3.0 §4.5).
            # Coût moyen pondéré des seuls lots date ≤ date, en devise de reporting. Tout-ou-rien
            # DATE-RESTREINT sur fxRateSource ∈ {'ok','auto','manual'} (jamais fxRate is not None) :
            # un lot postérieur non résolu ne bloque jamais wac_base_at(date). Fermé sur `purchases`.
            def wac_base_at(date):
                if not date:
                    return None
                tq_up = 0
                ti_base_up = 0.0
                all_resolved = True
                for pu in purchases:
                    d = pu.get('date')
                    if not d or d > date:
                        continue
                    tq_up += (pu.get('qty') or 0)
                    if pu.get('fxRateSource') not in ('ok', 'auto', 'manual'):
                        all_resolved = False
                    ti_base_up += ((pu.get('qty') or 0) * (pu.get('price') or 0)
                                   + (pu.get('fees') or 0)) * (pu.get('fxRate') or 0)
                if tq_up <= 0 or not all_resolved:
                    return None
                return ti_base_up / tq_up

            sold_qty = sum((t.get('qSold') or 0) for t in trades if t.get('posId') == p.get('id'))
            remaining = tq - sold_qty
            neg = remaining < 0
            invested_remaining = remaining * wac_base if (wac_base is not None and not neg) else None
            live = p.get('livePrice')
            valo = None if neg else (remaining * live if live else 0)          # devise NATIVE
            valo_base = (convert_fx(valo, p.get('currency', ''), display_cur, fx)
                         if (valo is not None and p.get('currency')) else None)  # devise de reporting
            gp = (valo_base - invested_remaining) if (valo_base is not None and invested_remaining is not None) else None
            evol = (gp / invested_remaining) if (gp is not None and invested_remaining and invested_remaining > 0) else None
            return {'tq': tq, 'ti': ti, 'wac': wac, 'wac_base': wac_base,
                    'wac_base_at': wac_base_at,
                    'remaining': remaining, 'invested_remaining': invested_remaining,
                    'live': live, 'valo': valo, 'valo_base': valo_base, 'gp': gp, 'evol': evol}

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

        def build_live_rows(positions, id_fields, headers, trades):
            """
            Génère les lignes position / achat / séparateur pour un onglet live.
            id_fields : colonnes identitaires répétées sur les lignes 'achat'.
            trades : cessions du même onglet (posId) pour dériver remaining/wacBase.
            """
            # totI pour weight_pct : Σ invested_remaining des positions valorisées
            # (livePrice ET wacBase disponibles = invested_remaining non None), déjà en
            # devise de reporting — PAS de convert_fx (piège §4.10 / cf. priced JS).
            totI = 0.0
            for pos in positions:
                c = calc_pos(pos, trades)
                if pos.get('livePrice') and c['invested_remaining'] is not None:
                    totI += c['invested_remaining']

            E = ""  # cellule vide
            empty_row = {h: E for h in headers}
            rows = []
            for pos in positions:
                calc  = calc_pos(pos, trades)
                ident = {k: pos.get(k, E) for k in id_fields}
                if 'classe' in ident:
                    ident['class'] = ident.pop('classe')

                inv_rem = calc['invested_remaining']
                # weight_pct : uniquement si totI > 0, livePrice présent et invested_remaining dispo
                if totI and pos.get('livePrice') and inv_rem is not None:
                    rep = round(inv_rem / totI * 100, 1)
                else:
                    rep = E

                # Ligne "position"
                rows.append({
                    **ident,
                    "row_type":               "position",
                    "qty_total":              calc['tq'],
                    "qty_remaining":          calc['remaining'],
                    "wac":                    round(calc['wac'], 2),
                    "wac_base":               round(calc['wac_base'], 4) if calc['wac_base'] is not None else E,
                    "wac_base_currency":      display_cur if calc['wac_base'] is not None else E,
                    "invested_remaining":     round(inv_rem, 2) if inv_rem is not None else E,
                    "live_price":             round(calc['live'], 2) if calc['live'] is not None else E,
                    "valuation":              round(calc['valo_base'], 2) if calc['valo_base'] is not None else E,
                    "change_pct":             round(calc['evol'] * 100, 1) if calc['evol'] is not None else E,
                    "pnl":                    round(calc['gp'], 2) if calc['gp'] is not None else E,
                    "weight_pct":             rep,
                    "price_source":           pos.get('priceSource', E),
                    "price_date":             pos.get('priceDate',   E),
                    "purchase_date":          E, "purchase_qty":            E,
                    "purchase_price":         E, "purchase_fees":           E,
                    "purchase_fx_rate":       E, "purchase_fx_rate_source": E,
                    "purchase_total_invested": E, "purchase_lot_avg_cost":        E,
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
                        "row_type":               "purchase",
                        "qty_total":              E, "qty_remaining":   E,
                        "wac":                    E, "wac_base":        E,
                        "wac_base_currency":      E, "invested_remaining": E,
                        "live_price":             E, "valuation":       E,
                        "change_pct":             E, "pnl":             E,
                        "weight_pct":             E, "price_source":    E,
                        "price_date":             E,
                        "purchase_date":          pu.get('date',  E),
                        "purchase_qty":           pu.get('qty',   E),
                        "purchase_price":         pu.get('price', E),
                        "purchase_fees":          pu.get('fees',  E),
                        "purchase_fx_rate":       pu.get('fxRate') if pu.get('fxRate') is not None else E,
                        "purchase_fx_rate_source": pu.get('fxRateSource') if pu.get('fxRateSource') is not None else E,
                        "purchase_total_invested": pu_ti,
                        "purchase_lot_avg_cost":       lot_avg_cost,
                    })

                # Ligne séparatrice (toutes cellules vides)
                rows.append(dict(empty_row))

            return rows

        fx          = data.get('fxRates', {})
        display_cur = data.get('settings', {}).get('currency', 'eur')

        # ── 1. CTO live ───────────────────────────────────────────────────────
        HEADERS_CTO_LIVE = [
            "row_type", "id", "name", "isin", "ticker", "broker", "class", "currency",
            "qty_total", "qty_remaining", "wac", "wac_base", "wac_base_currency",
            "invested_remaining", "live_price", "valuation", "change_pct", "pnl",
            "weight_pct", "price_source", "price_date",
            "purchase_date", "purchase_qty", "purchase_price", "purchase_fees",
            "purchase_fx_rate", "purchase_fx_rate_source",
            "purchase_total_invested", "purchase_lot_avg_cost",
        ]
        CTO_ID = ["id", "name", "ticker", "isin", "broker", "classe", "currency"]
        cto_live_rows = build_live_rows(data.get('cto', []), CTO_ID, HEADERS_CTO_LIVE, data.get('ctoTrades', []))

        # ── 2. Crypto live ────────────────────────────────────────────────────
        HEADERS_CRYPTO_LIVE = [
            "row_type", "id", "name", "ticker", "currency",
            "qty_total", "qty_remaining", "wac", "wac_base", "wac_base_currency",
            "invested_remaining", "live_price", "valuation", "change_pct", "pnl",
            "weight_pct", "price_source", "price_date",
            "purchase_date", "purchase_qty", "purchase_price", "purchase_fees",
            "purchase_fx_rate", "purchase_fx_rate_source",
            "purchase_total_invested", "purchase_lot_avg_cost",
        ]
        CRYPTO_ID = ["id", "name", "ticker", "currency"]
        crypto_live_rows = build_live_rows(data.get('crypto', []), CRYPTO_ID, HEADERS_CRYPTO_LIVE, data.get('cryptoTrades', []))

        # ── 3 & 4. Sorties CTO + Crypto (qBought exclu ; isin absent de crypto) ──
        CCY = display_cur.upper()
        SORTIES_OPT_HEADERS = [f"total_buy_{CCY}", f"total_sell_{CCY}", f"pnl_{CCY}", "pnl_pct"]

        def calc_sortie_opts(t, pos):
            """[v3.0] Coût de base DATÉ calculé à l'export : wb = pos.wac_base_at(sellDate),
            déjà en devise de reporting (plus de wacBaseAtSale figé ni de convert). pos est le
            résultat calc_pos de la position d'origine, ou None si orpheline (posId sans position).
            tb = qSold × wb ; None si wb indisponible (orpheline, aucun lot ≤ sellDate, lot non
            résolu, sellDate absente). Totaux Options disponibles seulement si fxRateSell résolu
            ET wb non None (double condition, miroir de calcTradeOptions JS — pas seulement fxRateSell)."""
            q_sold, price_sell = t.get('qSold') or 0, t.get('priceSell') or 0
            fees_sell = t.get('feesSell') or 0
            wb = pos['wac_base_at'](t.get('sellDate')) if pos else None
            ts = q_sold * price_sell - fees_sell if (q_sold > 0 and price_sell > 0) else 0
            tb = q_sold * wb if wb is not None else None
            fx_sell = t.get('fxRateSell')
            resolved = fx_sell is not None and t.get('fxRateSellSource') != 'ko'
            if resolved and tb is not None:
                total_buy  = round(tb, 2)
                total_sell = round(ts * fx_sell, 2)
                pnl        = round(total_sell - total_buy, 2)
                pct        = round(pnl / total_buy * 100, 1) if total_buy > 0 else ""
            else:
                total_buy = total_sell = pnl = pct = ""
            return {f"total_buy_{CCY}": total_buy, f"total_sell_{CCY}": total_sell,
                    f"pnl_{CCY}": pnl, "pnl_pct": pct}

        HEADERS_CTO_SORTIES = [
            "id", "name", "ticker", "isin", "currency", "pos_id",
            "avg_cost_at_sale",
            "sellDate", "qSold", "priceSell", "feesSell", "fxRateSell", "fxRateSellSource",
        ] + SORTIES_OPT_HEADERS
        HEADERS_CRYPTO_SORTIES = [
            "id", "name", "currency", "pos_id",
            "avg_cost_at_sale",
            "sellDate", "qSold", "priceSell", "feesSell", "fxRateSell", "fxRateSellSource",
        ] + SORTIES_OPT_HEADERS

        def sortie_row(t, pos):
            """[v3.0] Ligne cession. pos = résultat calc_pos de la position d'origine (ou None si
            orpheline). pos_id vide si orpheline ; avg_cost_at_sale = wac_base_at(sellDate) CALCULÉ
            à l'export (devise de reporting), vide si indisponible (orpheline, aucun lot ≤ sellDate,
            lot non résolu, sellDate absente). Ne lit JAMAIS wacBaseAtSale/wacBaseCurrency (supprimés)."""
            wb = pos['wac_base_at'](t.get('sellDate')) if pos else None
            r = {
                "id":        t.get("id", ""),
                "name":      t.get("name", ""),
                "ticker":    t.get("ticker", ""),
                "isin":      t.get("isin", ""),
                "currency":  t.get("currency", ""),
                "pos_id":    t.get("posId") if t.get("posId") is not None else "",
                "avg_cost_at_sale":  round(wb, 4) if wb is not None else "",
                "sellDate":  t.get("sellDate", ""),
                "qSold":     t.get("qSold", ""),
                "priceSell": t.get("priceSell", ""),
                "feesSell":  t.get("feesSell", ""),
                "fxRateSell":       t.get("fxRateSell") if t.get("fxRateSell") is not None else "",
                "fxRateSellSource": t.get("fxRateSellSource") or "",
            }
            r.update(calc_sortie_opts(t, pos))
            return r

        # [v3.0] Lookup id → calc_pos(position) par scope, construit avant la boucle : fournit
        # l'accesseur daté wac_base_at à sortie_row. .get(posId) → None si orpheline (posId sans position).
        cto_pos_by_id    = {p.get('id'): calc_pos(p, data.get('ctoTrades', []))    for p in data.get('cto', [])}
        crypto_pos_by_id = {p.get('id'): calc_pos(p, data.get('cryptoTrades', [])) for p in data.get('crypto', [])}
        cto_sorties_rows    = [sortie_row(t, cto_pos_by_id.get(t.get('posId')))    for t in data.get('ctoTrades', [])]
        crypto_sorties_rows = [sortie_row(t, crypto_pos_by_id.get(t.get('posId'))) for t in data.get('cryptoTrades', [])]

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

        # ── 6. Summary (KPIs consolidés, devise Options) ─────────────────────────
        def consolidated_totals(positions, trades):
            """KPIs consolidés v2.0 (§4.10 Securities) : positions valorisées
            (livePrice ET wacBase → invested_remaining non None). invested_remaining
            déjà en devise de reporting (PAS de convert_fx) ; valo reste NATIVE (convert_fx)."""
            inv = val = 0.0
            for pos in positions:
                c = calc_pos(pos, trades)
                if not (pos.get('livePrice') and c['invested_remaining'] is not None):
                    continue
                inv += c['invested_remaining']
                vv = convert_fx(c['valo'], pos.get('currency', ''), display_cur, fx)
                if vv is not None:
                    val += vv
            return round(inv, 2), round(val, 2)

        def realized_pnl(trades, pos_by_id):
            """Σ pnl_<CCY> (= gpOpt) des cessions complètes — même condition que calc_sortie_opts
            (fxRateSell résolu ET avg_cost_at_sale daté disponible). pos_by_id : lookup id → calc_pos
            du scope, pour résoudre la position (ou None si orpheline) et son coût de base daté."""
            total = 0.0
            for t in trades:
                v = calc_sortie_opts(t, pos_by_id.get(t.get('posId')))[f"pnl_{CCY}"]
                if v != "":
                    total += v
            return round(total, 2)

        sec_inv, sec_val = consolidated_totals(data.get('cto', []),    data.get('ctoTrades', []))
        cry_inv, cry_val = consolidated_totals(data.get('crypto', []), data.get('cryptoTrades', []))

        HEADERS_SUMMARY = ["metric", "value", "currency"]
        summary_rows = [
            {"metric": "total_valuation",        "value": round(sec_val + cry_val, 2),               "currency": CCY},
            {"metric": "securities_invested",     "value": sec_inv,                                    "currency": CCY},
            {"metric": "securities_valuation",    "value": sec_val,                                    "currency": CCY},
            {"metric": "securities_pnl",          "value": round(sec_val - sec_inv, 2),               "currency": CCY},
            {"metric": "securities_realized_pnl", "value": realized_pnl(data.get('ctoTrades', []), cto_pos_by_id),   "currency": CCY},
            {"metric": "cryptos_invested",        "value": cry_inv,                                    "currency": CCY},
            {"metric": "cryptos_valuation",       "value": cry_val,                                    "currency": CCY},
            {"metric": "cryptos_pnl",             "value": round(cry_val - cry_inv, 2),               "currency": CCY},
            {"metric": "cryptos_realized_pnl",    "value": realized_pnl(data.get('cryptoTrades', []), crypto_pos_by_id),"currency": CCY},
        ]

        # ── Assemblage ZIP ────────────────────────────────────────────────────
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("securities_live.csv",  make_csv(HEADERS_CTO_LIVE,    cto_live_rows))
            zf.writestr("cryptos_live.csv",      make_csv(HEADERS_CRYPTO_LIVE, crypto_live_rows))
            zf.writestr("securities_sales.csv", make_csv(HEADERS_CTO_SORTIES,    cto_sorties_rows))
            zf.writestr("cryptos_sales.csv",    make_csv(HEADERS_CRYPTO_SORTIES, crypto_sorties_rows))
            zf.writestr("history.csv",          make_csv(HEADERS_HISTO,       histo_rows))
            zf.writestr("summary.csv",          make_csv(HEADERS_SUMMARY,      summary_rows))

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
    print("║  Portfolio Tracker — running locally             ║")
    print("║  → http://localhost:8080                         ║")
    print("║  → Data file : portfolio_data.json               ║")
    print("║  For stock prices :                              ║")
    print("║    pip install yfinance --break-system-packages  ║")
    print("║  Ctrl+C to quit                                  ║")
    print("╚══════════════════════════════════════════════════╝")
    threading.Timer(1.0, lambda: webbrowser.open(f"http://localhost:{PORT}")).start()
    try:
        server = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n👋 Stopped.")
        server.server_close()
