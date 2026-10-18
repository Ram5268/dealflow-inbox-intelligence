"""Load the public-record files once and build model rows for past sales and CRM sellers.

Sellers are valued "as of" a date (the first day after the newest sale in the files): their rows
get that date, and every input counts only records dated before it, exactly like a sale's row.
"""
from __future__ import annotations

import time

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from . import config
from .deeds import deed_table, match_deeds
from .features import alteration_events, base_features, cond_features, month_indexes, r2_features, xy
from .frame import build_frame, class_group, roll_for, roll_releases, subjects
from .raw import Raw
from .sales import build_sales


class Inputs:
    """Everything the model needs from one data folder."""

    def __init__(self, raw: Raw, screen: str = "name-free", flags: pd.DataFrame | None = None,
                 min_ratio: float = config.MIN_PRICE_TO_MARKET_VALUE, log=print):
        t0 = time.time()
        self.raw, self.log = raw, log
        self.sales, self.sales_info = build_sales(raw)
        self.end = (self.sales["date"].max() + pd.Timedelta(days=1)).normalize()
        log(f"sales: {len(self.sales):,} rows, cut-over {self.sales_info['cutover']}, through {self.sales_info['rolling_last_sale']} ({time.time() - t0:.0f}s)")
        self.pluto = raw.pluto().drop_duplicates("bbl").reset_index(drop=True)
        self.deeds = deed_table(raw.acris_master(), raw.acris_legals())
        self.cand = match_deeds(self.sales, self.deeds, self.end)
        log(f"deeds matched: {int(self.cand['acris_matched'].sum()):,} of {len(self.cand):,} 1-4 family sales since {config.ACRIS_START.date()} ({time.time() - t0:.0f}s)")
        self.roll = raw.roll(set(self.cand["bbl"]))
        self.stations = raw.stations()
        self.rescreen(screen, flags, min_ratio)

    def rescreen(self, screen: str, flags: pd.DataFrame | None = None, min_ratio: float = config.MIN_PRICE_TO_MARKET_VALUE) -> None:
        """(Re)build the sales frame with an arm's-length screen (frame.py)."""
        t0 = time.time()
        self.S = build_frame(self.sales, self.pluto, self.cand, self.roll, screen=screen, flags=flags, min_ratio=min_ratio)
        self.screen, self.min_ratio = screen, min_ratio
        self.log(f"frame: {len(self.S):,} 1-4 family sales, {int(self.S['clean'].sum()):,} arm's-length ({screen} screen) ({time.time() - t0:.0f}s)")

    def extend_roll(self, lots: set[str]) -> None:
        """Add roll rows for lots not yet loaded (sellers' lots)."""
        missing = set(lots) - set(self.roll["parid"])
        if missing:
            self.roll = pd.concat([self.roll, self.raw.roll(missing)], ignore_index=True)

    # ---- rows ----------------------------------------------------------------------------
    def sale_rows(self, start: pd.Timestamp, end: pd.Timestamp) -> pd.DataFrame:
        """Model rows for the sales the model trains on and is scored on, in [start, end)."""
        S = self.S
        X = S[subjects(S) & (S["date"] >= start) & (S["date"] < end)].copy().reset_index(drop=True)
        X["month"] = X["date"].dt.to_period("M").dt.to_timestamp()
        X["is_seller"] = False
        return X

    def seller_rows(self, sellers: pd.DataFrame, asof: pd.Timestamp) -> pd.DataFrame:
        """Model rows for matched 1-4 family sellers (columns: contactId, bbl), as of `asof`.

        Building facts come from PLUTO, as the research valued sellers (value_sellers_ml.py)."""
        P = self.pluto.set_index("bbl")
        S = self.S
        self.extend_roll(set(sellers["bbl"]))
        R = self.roll[self.roll["mv"] > 0]
        rel = roll_releases(sorted(R["year"].unique()))
        rl = roll_for(asof, rel)
        taxclass = R[(R["year"] == rl[0]) & (R["period"] == rl[1])].drop_duplicates("parid").set_index("parid")["curtaxclass"] if rl else pd.Series(dtype=object)
        # Neighborhood: the lot's own latest DOF sale record (any building class), else the nearest sale's.
        own = (self.sales.dropna(subset=["neighborhood"]).sort_values("date", kind="mergesort")
               .groupby("bbl")["neighborhood"].last().str.upper().str.strip())
        geo = S.dropna(subset=["lat"]).drop_duplicates("bbl")
        tree = cKDTree(xy(geo["lat"], geo["lon"]))
        blk = self.pluto.assign(blk=self.pluto["bbl"].str[:6]).groupby("blk")[["latitude", "longitude"]].mean()
        rows = []
        for cid, b in zip(sellers["contactId"], sellers["bbl"]):
            p = P.loc[b]
            lat, lon = p["latitude"], p["longitude"]
            if pd.isna(lat) and b[:6] in blk.index:
                lat, lon = blk.loc[b[:6], "latitude"], blk.loc[b[:6], "longitude"]
            nb = own.get(b)
            if nb is None and pd.notna(lat):
                nb = geo["neighborhood"].iat[tree.query(xy([lat], [lon]))[1][0]]
            num = lambda v: float(v) if pd.notna(v) and float(v) > 0 else np.nan  # noqa: E731
            res = float(p["unitsres"]) if pd.notna(p["unitsres"]) else 0.0
            tot = float(p["unitstotal"]) if pd.notna(p["unitstotal"]) else 0.0
            rows.append({"contactId": cid, "bbl": b, "borough": int(b[0]), "neighborhood": nb, "grp": class_group(p["bldgclass"]),
                         "bldg_class_sale": p["bldgclass"], "lat": lat, "lon": lon, "sqft": num(p["bldgarea"]), "land_sqft": num(p["lotarea"]),
                         "year_built": num(p["yearbuilt"]), "res_units": res, "com_units": max(tot - res, 0.0),
                         "tax_class_sale": taxclass.get(b), "date": asof, "month": asof, "price": np.nan, "is_seller": True})
        return pd.DataFrame(rows)

    # ---- features ----------------------------------------------------------------------------
    def features(self, X: pd.DataFrame, comps_out: dict | None = None) -> pd.DataFrame:
        """All model inputs for the rows in X (sales and/or sellers). With `comps_out`, each seller
        row's nearby sales are collected for the CRM card (features.base_features)."""
        t0 = time.time()
        X = X.reset_index(drop=True)
        lots = set(X["bbl"])
        raw = self.raw
        sel = lambda df, col="bbl": df[df[col].isin(lots)]  # noqa: E731
        bis = sel(raw.dob_permits())
        nj = raw.dobnow_jobs()
        npm = sel(raw.dobnow_permits())
        alt = alteration_events(bis, nj, npm)
        nj = sel(nj)
        IDX = month_indexes(self.S, X["month"].unique())
        self.log(f"  price indexes for {len(IDX)} months ({time.time() - t0:.0f}s)")
        self.alt = alt
        X = base_features(X, self.S, IDX, self.roll, self.pluto, self.stations, alt, comps_out)
        self.log(f"  model e inputs ({time.time() - t0:.0f}s)")
        F = cond_features(X, self.S, bis, npm, sel(raw.dobnow_electrical(), "bbl_key"), sel(raw.dob_jobs()), nj,
                          raw.hpd_violations(lots), sel(raw.dob_violations(), "bbl_key"), sel(raw.ecb_violations(), "bbl_key"))
        self.log(f"  condition clues ({time.time() - t0:.0f}s)")
        fp = raw.footprints()
        ex = raw.exemptions_421a()
        N = r2_features(X, self.pluto, fp[fp["base_bbl"].isin(lots)], ex[ex["parid"].isin(lots)])
        self.log(f"  footprints and 421-a ({time.time() - t0:.0f}s)")
        return pd.concat([X, F, N], axis=1)
