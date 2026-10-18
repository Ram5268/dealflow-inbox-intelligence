"""The CRM card's facts and nearby sales for each seller (Brief 44 §5 whitelist).

Only public-record facts about the building and lot. Never an owner or party name, and no
personal-circumstance detail (Ryan's decision, 2026-10-17; Brief 44 §5). The tax-lien-sale fact
and mortgage records are left out (Brief 44 revision 5, data minimization).
"""
from __future__ import annotations

import re

import numpy as np
import pandas as pd

from . import config
from .frame import roll_for, roll_releases

COMP_ADDRESS = re.compile(r"^[0-9]+(-[0-9]+)?[A-Z]? [A-Za-z0-9 #&'().,/-]{2,72}$")
ZONING = re.compile(r"^[A-Z0-9/.-]{1,16}$")
BLDG_CLASS = re.compile(r"^[A-Z][0-9A-Z]$")


def comp_address(a: str | None) -> str | None:
    """A DOF sale address for display: "12 EXAMPLE STREET, 2" -> "12 Example Street". Anything that
    doesn't start with a house number (e.g. "N/A BEACH 28 STREET") is dropped."""
    a = re.sub(r"\s+", " ", str(a or "")).strip().split(",")[0].strip()
    m = re.match(r"^(\d+(?:-\d+)?[A-Z]?)\s+(.+)$", a.upper())
    if not m:
        return None
    words = [w.lower() if w[:1].isdigit() else w.capitalize() for w in m.group(2).split(" ")]
    out = f"{m.group(1)} {' '.join(words)}"
    return out if COMP_ADDRESS.match(out) else None


def card_comps(sub: pd.DataFrame | None, asof: pd.Timestamp) -> list[dict]:
    """Up to MAX_COMPS nearby earlier arm's-length sales, nearest first (public sales records)."""
    if sub is None:
        return []
    out = []
    for r in sub.itertuples():
        addr = comp_address(r.address)
        if addr is None or not (r.date < asof) or not (r.price > 0) or not (0 < r.ppsf <= 50_000):
            continue
        out.append({"address": addr, "date": r.date.date().isoformat(), "price": float(round(r.price)),
                    "pricePerSqft": round(float(r.ppsf), 2), "distanceMiles": round(float(r.dist), 3)})
        if len(out) == config.MAX_COMPS:
            break
    return out


def _num(v, lo=None, hi=None):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(f) or (lo is not None and f < lo) or (hi is not None and f > hi):
        return None
    return f


def permits_7y(alt: pd.DataFrame, lots: set[str], asof: pd.Timestamp) -> dict[str, dict]:
    """DOB alteration permits in the 7 years before `asof`, per lot: a count and whether any was major."""
    w = alt[alt["bbl"].isin(lots) & (alt["d"] < asof) & (alt["d"] >= asof - pd.Timedelta(days=2557))]
    g = w.groupby("bbl")["major"].agg(["size", "any"])
    return {b: {"count": int(r["size"]), "major": bool(r["any"])} for b, r in g.iterrows()}


class FactSources:
    """The per-lot tables the facts read, filtered to the sellers' lots."""

    def __init__(self, inp, lots: set[str], asof: pd.Timestamp):
        raw = inp.raw
        self.asof = asof
        self.pluto = inp.pluto.set_index("bbl")
        clean = inp.S[inp.S["clean"] & (inp.S["date"] < asof) & inp.S["bbl"].isin(lots)].sort_values("date", kind="mergesort")
        self.last_sale = clean.groupby("bbl")[["date", "price"]].last()
        inp.extend_roll(lots)
        R = inp.roll[(inp.roll["mv"] > 0) & inp.roll["parid"].isin(lots)]
        rl = roll_for(asof, roll_releases(sorted(R["year"].unique())))
        self.roll_year = rl[0] if rl else None
        self.mv = R[(R["year"] == rl[0]) & (R["period"] == rl[1])].drop_duplicates("parid").set_index("parid")["mv"] if rl else pd.Series(dtype=float)
        dv = raw.dob_violations()
        dv = dv[dv["bbl_key"].isin(lots) & dv["violation_category"].fillna("").str.upper().str.contains("ACTIVE")]
        ev = raw.ecb_violations()
        ev = ev[ev["bbl_key"].isin(lots) & (ev["ecb_violation_status"].fillna("").str.upper() == "ACTIVE")]
        hv = raw.hpd_violations(lots)
        hv = hv[hv["violationstatus"] == "Open"]
        self.open_dob = dv.groupby("bbl_key").size()
        self.open_ecb = ev.groupby("bbl_key").size()
        self.open_hpd = hv.groupby("bbl").size()


def facts_for(src: FactSources, bbl: str, permits: dict, subway_mi, lead_units, lead_sqft) -> dict | None:
    """The whitelisted facts for one matched lot (valued or not)."""
    if bbl not in src.pluto.index:
        return None
    p = src.pluto.loc[bbl]
    units = _num(p["unitsres"], 0, 1_000_000)
    bsqft = _num(p["bldgarea"], 1)
    zoning = p["zonedist1"] if isinstance(p["zonedist1"], str) and ZONING.match(p["zonedist1"]) else None
    cls = p["bldgclass"] if isinstance(p["bldgclass"], str) and BLDG_CLASS.match(p["bldgclass"]) else None
    yb = _num(p["yearbuilt"], 1700, 2100)
    ls = src.last_sale.loc[bbl] if bbl in src.last_sale.index else None
    mv = src.mv.get(bbl)
    lu = _num(lead_units, 0, 1_000_000)
    lsq = _num(lead_sqft, 1)
    vs_units = {"lead": int(lu), "city": int(units)} if (lu is not None and units is not None and int(lu) != int(units)) else None
    vs_sqft = ({"lead": round(lsq), "city": round(bsqft)} if (lsq is not None and bsqft is not None and abs(lsq / bsqft - 1) > 0.10) else None)
    subway = _num(subway_mi, 0, 25)
    return {
        "units": int(units) if units is not None else None,
        "buildingSqft": round(bsqft) if bsqft is not None else None,
        "lotSqft": round(v) if (v := _num(p["lotarea"], 1)) is not None else None,
        "yearBuilt": int(yb) if yb is not None else None,
        "floors": _num(p["numfloors"], 0, 200),
        "zoning": zoning,
        "buildingClass": cls,
        "historicDistrict": bool(pd.notna(p["histdist"])),
        "lastSale": {"date": ls["date"].date().isoformat(), "price": float(ls["price"])} if ls is not None else None,
        "dofMarketValue": {"value": float(mv), "fiscalYear": int(src.roll_year)} if (mv is not None and pd.notna(mv) and mv > 0) else None,
        "permits7y": permits,
        "openViolations": {"dob": int(src.open_dob.get(bbl, 0)), "ecb": int(src.open_ecb.get(bbl, 0)), "hpd": int(src.open_hpd.get(bbl, 0))},
        "subwayMiles": round(subway, 2) if subway is not None else None,
        "leadVsCity": {"units": vs_units, "buildingSqft": vs_sqft},
    }
