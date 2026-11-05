#!/usr/bin/env python3
"""Génère data/data.json pour l'application « Point du jour ».

Sources publiques uniquement (aucune donnée personnelle) : flux RSS,
Eurostat, BCE, Frankfurter (taux BCE), gold-api.com, Stooq,
calendrier.api.gouv.fr. Synthèse de l'actualité par l'API Claude (facultative).
Chaque bloc est indépendant : si une source tombe, les autres restent publiés.
"""
import csv
import html
import io
import json
import os
import sys
import time
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "data.json"
HIST = ROOT / "data" / "history.json"
TIMEOUT = 25
HEADERS = {"User-Agent": "point-du-jour/1.0 (https://github.com/arise-detox/point-du-jour)"}
MODEL = os.getenv("CLAUDE_MODEL") or "claude-haiku-5-5"
CURRENCIES = ["USD", "JPY", "THB", "GBP", "CHF"]
OZ = 31.1034768  # grammes par once troy

FEEDS = [
    ("franceinfo", "Une", "https://www.francetvinfo.fr/titres.rss"),
    ("Le Monde", "Une", "https://www.lemonde.fr/rss/une.xml"),
    ("franceinfo", "Monde", "https://www.francetvinfo.fr/monde.rss"),
    ("Le Monde", "Monde", "https://www.lemonde.fr/international/rss_full.xml"),
    ("franceinfo", "Éco", "https://www.francetvinfo.fr/economie.rss"),
    ("Le Monde", "Éco", "https://www.lemonde.fr/economie/rss_full.xml"),
]
EUROSTAT = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/"


def log(msg):
    print(msg, file=sys.stderr)


def get(url, **kwargs):
    last = None
    for _ in range(2):
        try:
            r = requests.get(url, timeout=TIMEOUT, headers=HEADERS, **kwargs)
            r.raise_for_status()
            return r
        except Exception as e:  # nouvelle tentative une fois
            last = e
            time.sleep(1.5)
    raise last


def safe(name, fn, *args):
    try:
        return fn(*args)
    except Exception as e:
        log(f"[{name}] {type(e).__name__}: {e}")
        return None


# --- Actualités -------------------------------------------------------------
def parse_ts(text):
    try:
        d = parsedate_to_datetime(text)
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return d.astimezone(timezone.utc).isoformat(timespec="seconds")
    except Exception:
        return None


def news():
    seen, items, per_cat = set(), [], {}
    for source, cat, url in FEEDS:
        try:
            root = ET.fromstring(get(url).content)
        except Exception as e:
            log(f"[RSS {source}/{cat}] {e}")
            continue
        taken = 0
        for it in root.iter("item"):
            title = html.unescape((it.findtext("title") or "").strip())
            link = (it.findtext("link") or "").strip()
            if not title or not link.startswith("http"):
                continue
            key = " ".join(title.lower().split())
            if key in seen or per_cat.get(cat, 0) >= 12:
                continue
            seen.add(key)
            per_cat[cat] = per_cat.get(cat, 0) + 1
            items.append({"t": title, "u": link, "s": source, "c": cat,
                          "ts": parse_ts(it.findtext("pubDate") or "")})
            taken += 1
            if taken >= 8:
                break
    if not items:
        raise RuntimeError("aucun flux d'actualités disponible")
    items.sort(key=lambda x: x["ts"] or "", reverse=True)
    return items


def synthese(items):
    key = os.getenv("ANTHROPIC_API_KEY")
    if not key or not items:
        return None
    heads = "\n".join(f"- [{i['c']}] {i['t']} ({i['s']})" for i in items[:30])
    prompt = (
        "Voici les titres de l'actualité du jour (France et monde).\n"
        "Rédige, avec tes propres mots, 5 à 6 points de synthèse en français, "
        "classés par importance, une phrase courte chacun (25 mots maximum), "
        "factuels, sans emoji, sans rien ajouter qui ne soit déductible des titres.\n"
        'Réponds uniquement en JSON : {"points": ["...", "..."]}\n\n' + heads
    )
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": key, "anthropic-version": "2023-06-01",
                 "content-type": "application/json"},
        json={"model": MODEL, "max_tokens": 700,
              "messages": [{"role": "user", "content": prompt}]},
        timeout=60,
    )
    r.raise_for_status()
    text = r.json()["content"][0]["text"]
    data = json.loads(text[text.find("{"): text.rfind("}") + 1])
    points = [str(p).strip() for p in data.get("points", []) if str(p).strip()]
    return points[:6] or None


# --- Économie France ---------------------------------------------------------
def eurostat_last(dataset, params, n=3):
    p = dict(params, format="JSON", lang="EN", lastTimePeriod=n)
    j = get(EUROSTAT + dataset, params=p).json()
    idx = j["dimension"]["time"]["category"]["index"]
    vals = j["value"]
    out = []
    for per in sorted(idx, key=idx.get):
        v = vals[idx[per]] if isinstance(vals, list) else vals.get(str(idx[per]))
        if v is not None:
            out.append((per, float(v)))
    if not out:
        raise RuntimeError("série vide")
    return out


def inflation():
    # Depuis 2026 Eurostat publie l'IPCH selon la nomenclature ECOICOP v2 (jeu prc_hicp_minr,
    # dimension coicop18). L'ancien jeu prc_hicp_manr s'arrête en décembre 2025.
    s = eurostat_last("prc_hicp_minr", {"geo": "FR", "coicop18": "TOTAL", "unit": "RCH_A"})
    return {"value": s[-1][1], "period": s[-1][0],
            "previous": s[-2][1] if len(s) > 1 else None}


def unemployment():
    s = eurostat_last("une_rt_m", {"geo": "FR", "s_adj": "SA", "age": "TOTAL",
                                   "unit": "PC_ACT", "sex": "T"})
    return {"value": s[-1][1], "period": s[-1][0],
            "previous": s[-2][1] if len(s) > 1 else None}


def ecb_rate():
    j = get("https://data-api.ecb.europa.eu/service/data/FM/D.U2.EUR.4F.KR.DFR.LEV",
            params={"lastNObservations": 1, "format": "jsondata"}).json()
    series = next(iter(j["dataSets"][0]["series"].values()))
    k = max(series["observations"], key=int)
    dates = j["structure"]["dimensions"]["observation"][0]["values"]
    return {"value": series["observations"][k][0], "date": dates[int(k)]["id"]}


def holidays():
    today = date.today()
    out = []
    for y in (today.year, today.year + 1):
        j = get(f"https://calendrier.api.gouv.fr/jours-feries/metropole/{y}.json").json()
        out += [{"date": d, "name": n} for d, n in j.items() if d >= today.isoformat()]
    out.sort(key=lambda x: x["date"])
    return out[:4]


# --- Marchés -----------------------------------------------------------------
def fx_raw():
    start = (date.today() - timedelta(days=50)).isoformat()
    j = get(f"https://api.frankfurter.dev/v1/{start}..",
            params={"base": "EUR", "symbols": ",".join(CURRENCIES)}).json()
    return j["rates"]


def fx_block(rates):
    days = sorted(rates)
    out = {"date": days[-1], "rates": {}}
    for cur in CURRENCIES:
        s = [rates[d][cur] for d in days if cur in rates[d]]
        if len(s) >= 2:
            out["rates"][cur] = {"last": s[-1], "prev": s[-2], "series": s[-32:]}
    return out


def stooq(symbol, n=45):
    r = get("https://stooq.com/q/d/l/", params={"s": symbol, "i": "d"})
    if not r.text.startswith("Date"):
        raise RuntimeError("réponse Stooq inattendue")
    rows = list(csv.DictReader(io.StringIO(r.text)))
    out = [(x["Date"], float(x["Close"])) for x in rows[-n:] if x.get("Close")]
    if len(out) < 2:
        raise RuntimeError("série trop courte")
    return out


def market(symbol):
    rows = stooq(symbol)
    s = [v for _, v in rows]
    return {"last": s[-1], "prev": s[-2], "series": s[-32:], "date": rows[-1][0]}


def metals(rates, hist):
    xau = float(get("https://api.gold-api.com/price/XAU").json()["price"])
    xag = float(get("https://api.gold-api.com/price/XAG").json()["price"])
    usd = {d: v["USD"] for d, v in rates.items() if "USD" in v}
    eurusd = usd[sorted(usd)[-1]]
    today = date.today().isoformat()
    hist[today] = {"xau_usd": round(xau, 2), "xag_usd": round(xag, 3), "eurusd": eurusd}
    spot = xau / eurusd / OZ

    pts = []  # (date, €/g)
    try:  # historique fourni par Stooq si disponible
        for d, close in stooq("xauusd"):
            if d in usd:
                pts.append((d, close / usd[d] / OZ))
    except Exception as e:
        log(f"[Stooq or] {e}")
    if len(pts) < 10:  # sinon : historique constitué jour après jour
        pts = [(d, v["xau_usd"] / v["eurusd"] / OZ)
               for d, v in sorted(hist.items()) if v.get("xau_usd") and v.get("eurusd")]
    if pts and pts[-1][0] == today:
        pts[-1] = (today, spot)
    else:
        pts.append((today, spot))
    series = [round(v, 2) for _, v in pts][-32:]
    return {"usd_oz": xau, "eur_oz": xau / eurusd, "eur_g": spot, "series": series,
            "ag_usd_oz": xag, "ag_eur_g": xag / eurusd / OZ}


# --- Anecdote du jour --------------------------------------------------------
def anecdote():
    """Événements marquants de ce jour (Wikipédia FR, « Ce jour-là ») ; un par jour est mis en avant."""
    now = datetime.now(ZoneInfo("Europe/Paris"))
    j = get("https://api.wikimedia.org/feed/v1/wikipedia/fr/onthisday/selected/"
            f"{now.month:02d}/{now.day:02d}").json()
    events = []
    for e in j.get("selected", []):
        text = (e.get("text") or "").strip()
        if not text:
            continue
        pages = []
        for p in (e.get("pages") or [])[:2]:
            url = ((p.get("content_urls") or {}).get("desktop") or {}).get("page")
            title = (p.get("titles") or {}).get("normalized") or p.get("title")
            if url and title:
                pages.append({"t": title, "u": url})
        events.append({"y": e.get("year"), "t": text, "p": pages})
    if not events:
        raise RuntimeError("aucun événement pour ce jour")
    events.sort(key=lambda x: x["y"] or 0, reverse=True)
    return {"date": now.date().isoformat(), "events": events[:8],
            "pick": now.timetuple().tm_yday % len(events[:8])}


# --- Historique --------------------------------------------------------------
def load_hist():
    try:
        return json.loads(HIST.read_text(encoding="utf-8"))
    except Exception:
        return {}


def main():
    hist = load_hist()
    data = {"generated": datetime.now(timezone.utc).isoformat(timespec="seconds")}

    items = safe("actualités", news) or []
    data["news"] = items
    data["synthese"] = safe("synthèse", synthese, items)
    data["inflation"] = safe("inflation", inflation)
    data["unemployment"] = safe("chômage", unemployment)
    data["ecb"] = safe("taux BCE", ecb_rate)
    data["holidays"] = safe("jours fériés", holidays) or []
    data["anecdote"] = safe("anecdote", anecdote)

    rates = safe("change", fx_raw)
    data["fx"] = safe("change", fx_block, rates) if rates else None
    data["gold"] = safe("métaux", metals, rates, hist) if rates else None
    data["markets"] = {"cac": safe("CAC 40", market, "^cac"),
                       "brent": safe("Brent", market, "cb.f")}

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    keep = dict(sorted(hist.items())[-400:])
    HIST.write_text(json.dumps(keep, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8")

    ok = [k for k in ("news", "inflation", "unemployment", "ecb", "fx", "gold") if data.get(k)]
    print(f"Données générées ({len(ok)} blocs sur 6) : {', '.join(ok) or 'aucun'}")
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
