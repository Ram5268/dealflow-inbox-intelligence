"""The sales frame every later step uses (research: bt_common.load_sales).

Adds the unit-count group, coordinates, size, the deed match and the arm's-length screen.
Two screens exist:

- **"name-free"** (production; Brief 44 revision 3): an ordinary deed for one lot and 100% of
  the interest, a DOF price of at least $100k on one lot, and a price not implausibly low next to
  the city's market value for the lot. It reads no names.
- **"flags"** (the reproduction check's part 1 only, run locally): the research's saved per-deed
  yes/no flags (shared surname, same party on both sides, referee deed) in place of the
  market-value test. That file holds no names; it stays on the research Mac and is never
  committed, uploaded or put in a CI artifact (Brief 44 §5).
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from . import config


def class_group(c) -> str | None:
    c = (c or "").upper()
    if c[:1] == "A":
        return "1F"
    if c[:1] == "B":
        return "2F"
    if c == "C0":
        return "3F"
    if c == "C3":
        return "4F"
    return None


# The roll in effect before a date: tentative rolls come out about Jan 15, final rolls about
# Jun 1, of the year before the fiscal year (research: backtest.py ROLLS).
def roll_releases(years, present: set | None = None) -> list[tuple[int, int, pd.Timestamp]]:
    """With `present` (the (year, period) pairs in the file), only rolls that exist: a year whose
    final roll isn't posted yet falls back to its tentative roll instead of to no value at all."""
    return [(fy, per, pd.Timestamp(f"{fy - 1}-01-15") if per == 1 else pd.Timestamp(f"{fy - 1}-06-01"))
            for fy in years for per in (1, 3) if present is None or (fy, per) in present]


def roll_releases_of(R: pd.DataFrame) -> list[tuple[int, int, pd.Timestamp]]:
    return roll_releases(sorted(R["year"].unique()), present=set(zip(R["year"], R["period"])))


def roll_for(d: pd.Timestamp, releases) -> tuple[int, int] | None:
    ok = [(fy, per, rel) for fy, per, rel in releases if rel < d]
    return max(ok, key=lambda x: x[2])[:2] if ok else None


def load_flags(path: str) -> pd.DataFrame:
    """The research's saved per-deed flags (part 1 of the reproduction check only)."""
    with open(path) as fh:
        fl = json.load(fh)
    df = pd.DataFrame.from_dict(fl, orient="index")
    keep = ["shared_surname", "same_party", "referee"]
    for c in keep:
        df[c] = df[c].astype("boolean").fillna(False).astype(bool)
    return df[keep]


def build_frame(sales: pd.DataFrame, pluto: pd.DataFrame, cand: pd.DataFrame, roll: pd.DataFrame | None,
                screen: str = "name-free", flags: pd.DataFrame | None = None,
                min_ratio: float = config.MIN_PRICE_TO_MARKET_VALUE) -> pd.DataFrame:
    S = sales.copy()
    S["grp"] = S["bldg_class_sale"].map(class_group)
    S = S[S["grp"].notna()].copy()
    S["neighborhood"] = S["neighborhood"].str.upper().str.strip()
    # DOF-side multi-lot sale: the same borough, date and price on more than one lot.
    k = S.groupby(["borough", "date", "price"])["bbl"].transform("nunique")
    S["dof_multi"] = (k > 1) & (S["price"] > 0)
    # Coordinates: PLUTO by tax lot, else DOF's latitude/longitude, else the block's centre.
    P = pluto[["bbl", "latitude", "longitude", "bldgarea", "yearbuilt"]]
    S = S.merge(P.rename(columns={"latitude": "p_lat", "longitude": "p_lon", "bldgarea": "p_area", "yearbuilt": "p_yb"}), on="bbl", how="left")
    blk = P.assign(blk=P["bbl"].str[:6]).groupby("blk")[["latitude", "longitude"]].mean().rename(columns={"latitude": "b_lat", "longitude": "b_lon"})
    S["blk"] = S["bbl"].str[:6]
    S = S.merge(blk, left_on="blk", right_index=True, how="left")
    S["lat"] = S["p_lat"].fillna(S["latitude"]).fillna(S["b_lat"])
    S["lon"] = S["p_lon"].fillna(S["longitude"]).fillna(S["b_lon"])
    S["sqft"] = S["gross_sqft"].where(S["gross_sqft"] > 200)
    C = cand[["bbl", "date", "price", "document_id", "doc_type", "pct", "n_lots", "acris_matched"]].drop_duplicates(["bbl", "date", "price"])
    S = S.merge(C, on=["bbl", "date", "price"], how="left")
    S["acris_matched"] = S["acris_matched"].astype("boolean").fillna(False).astype(bool)
    partial = (S["pct"].fillna(100) < 100) | (S["n_lots"].fillna(1) > 1)
    if screen == "flags":
        if flags is None:
            raise ValueError("the flags screen needs the research's saved flags file")
        S = S.merge(flags, left_on="document_id", right_index=True, how="left")
        for c in ["shared_surname", "same_party", "referee"]:
            S[c] = S[c].astype("boolean").fillna(False).astype(bool)
        S["low_vs_mv"] = False
        S["nonarm"] = S["shared_surname"] | S["same_party"] | S["referee"] | partial
    elif screen == "name-free":
        S["price_to_mv"] = price_to_market_value(S, roll)
        S["low_vs_mv"] = S["price_to_mv"] < min_ratio  # NaN (no roll for the lot) compares False: kept
        S["nonarm"] = S["low_vs_mv"] | partial
    else:
        raise ValueError(f"unknown screen {screen!r}")
    S["dof_multi"] = S["dof_multi"] & ~(S["acris_matched"] & (S["n_lots"] == 1))
    S["clean"] = (S["price"] >= config.FLOOR_PRICE) & ~S["dof_multi"] & ~S["nonarm"]
    # A stable order (date, then lot, then price) so every run builds the same rows in the same order.
    S = S.sort_values(["date", "bbl", "price"], kind="mergesort").reset_index(drop=True)
    S["sale_id"] = np.arange(len(S))
    return S


def price_to_market_value(S: pd.DataFrame, roll: pd.DataFrame | None) -> pd.Series:
    """Sale price / the city's market value for the lot, on the roll in effect before the sale.

    Only deed-matched sales get a ratio (the window the deed screen covers); no roll → NaN."""
    out = pd.Series(np.nan, index=S.index)
    if roll is None or roll.empty:
        return out
    R = roll[roll["mv"] > 0]
    rel = roll_releases_of(R)
    mv = {(p, y, q): v for p, y, q, v in zip(R["parid"], R["year"], R["period"], R["mv"])}
    m = S["acris_matched"].to_numpy()
    vals = []
    for b, d in zip(S.loc[m, "bbl"], S.loc[m, "date"]):
        rl = roll_for(d, rel)
        vals.append(mv.get((b, rl[0], rl[1]), np.nan) if rl else np.nan)
    out.loc[m] = np.asarray(S.loc[m, "price"], float) / np.asarray(vals, float)
    return out


def subjects(S: pd.DataFrame) -> pd.Series:
    """Sales the model trains on and is scored on: clean, deed-matched, an ordinary deed."""
    return S["clean"] & S["acris_matched"] & (S["doc_type"] == config.ORDINARY_DEED)
