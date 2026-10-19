"""Sales months the city's two sales files don't cover yet, rebuilt from ACRIS deeds (Brief 49 PR 6).

The rolling sales file (usep-8jbt) covers the last 12 months, and each calendar year reaches the
annualized file (w2pb-icbu) about June of the next. So a run between February and June finds the
months between the end of the annualized file and the start of the rolling file in neither file:
1 month in February, up to 5 in June (Ryan's open item 5.4). Before this, those months had no
sales at all: fewer training sales, fewer nearby sales for comps, and a hole in the price index.

They are rebuilt here from the deeds ACRIS recorded for them (Master + Legals only, already loaded:
no names, Brief 44 revision 3). Each deed on a 1-4 family lot becomes one row in the DOF sales
table's shape: the deed's date and amount, and the building's facts from PLUTO, as sellers' rows
are built (DOF's facts "at the time of sale" don't exist for these months). The rows then go
through the same deed match and the same name-free arm's-length screen as every DOF sale
(deeds.py, frame.py). In a month the files cover, nothing here runs.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from . import config
from .features import xy

SOURCE = "acris_deeds"  # the rebuilt rows' `src`


def missing_months(info: dict) -> list[pd.Timestamp]:
    """The months strictly between the annualized file's last sale and the rolling file's cut-over."""
    if not info.get("annual_last_sale") or not info.get("cutover"):
        return []
    first = pd.Timestamp(info["annual_last_sale"]).to_period("M") + 1
    cut = pd.Timestamp(info["cutover"]).to_period("M")
    return [p.to_timestamp() for p in pd.period_range(first, cut - 1, freq="M")] if first < cut else []


def deed_sales(deeds: pd.DataFrame, pluto: pd.DataFrame, sales: pd.DataFrame, months: list[pd.Timestamp]) -> pd.DataFrame:
    """Rows in the DOF sales table's shape for every deed dated in `months` on a 1-4 family lot."""
    if not months:
        return sales.iloc[0:0].copy()
    lo, hi = min(months), max(months) + pd.offsets.MonthBegin(1)
    D = deeds[(deeds["ddate"] >= lo) & (deeds["ddate"] < hi) & (deeds["amt"] > 0) & deeds["bbl"].str.match(r"^[34]\d{9}$")]
    # The city repeats some documents with different amounts (Brief 44.1); one row per deed and lot,
    # and one per lot, day and amount (the same sale recorded twice).
    D = (D.sort_values(["document_id", "amt"], ascending=[True, False], kind="mergesort").drop_duplicates(["document_id", "bbl"])
         .drop_duplicates(["bbl", "ddate", "amt"]))
    P = pluto.drop_duplicates("bbl").set_index("bbl")
    D = D[D["bbl"].isin(P.index)]
    cls = P.loc[D["bbl"], "bldgclass"].fillna("").str.upper().to_numpy()
    fam = pd.Series(cls).str.match(config.FAMILY_CLASSES).to_numpy()
    D, cls = D[fam], cls[fam]
    if D.empty:
        return sales.iloc[0:0].copy()
    p = P.loc[D["bbl"]]
    num = lambda c: pd.to_numeric(p[c], errors="coerce").to_numpy(float)  # noqa: E731
    res, tot = np.nan_to_num(num("unitsres")), np.nan_to_num(num("unitstotal"))
    out = pd.DataFrame({
        "borough": D["bbl"].str[0].astype(int).to_numpy(), "block": D["bbl"].str[1:6].astype(int).to_numpy(),
        "lot": D["bbl"].str[6:].astype(int).to_numpy(), "bbl": D["bbl"].to_numpy(),
        "neighborhood": neighborhoods(D["bbl"].to_numpy(), pluto, sales),
        "bcc": None, "tax_class_present": None, "bldg_class_present": cls, "bldg_class_sale": cls,
        # DOF's own records: A/B/C0 homes are tax class 1 and four-family (C3) homes class 2, in every
        # 1-4 family sale of the annualized and rolling files on 2026-10-18.
        "tax_class_sale": np.where(cls == "C3", "2", "1"),
        "address": p["address"].to_numpy(), "apt": None, "zip": p["zipcode"].to_numpy(),
        "res_units": res, "com_units": np.maximum(tot - res, 0.0), "tot_units": tot,
        "land_sqft": num("lotarea"), "gross_sqft": num("bldgarea"), "year_built": num("yearbuilt"),
        "price": D["amt"].to_numpy(float), "date": D["ddate"].dt.normalize().to_numpy(), "src": SOURCE,
        "latitude": num("latitude"), "longitude": num("longitude"),
    })
    for c in ["block", "lot", "borough"]:
        out[c] = out[c].astype("Int64")
    return drop_dof_twins(out, sales).reset_index(drop=True)


def drop_dof_twins(rows: pd.DataFrame, sales: pd.DataFrame) -> pd.DataFrame:
    """Leaves out a rebuilt row that is a DOF sale's own deed: on the same lot, within 10 days, or
    within 120 days at the same amount (to 0.5%), the rule deeds.py matches sales to deeds by. A
    deed dated in late January for a sale DOF dates February 1 would otherwise count twice."""
    if rows.empty or sales.empty:
        return rows
    k = rows[["bbl", "date", "price"]].reset_index().rename(columns={"index": "_i"})
    J = k.merge(sales[["bbl", "date", "price"]], on="bbl", suffixes=("", "_dof"))
    dd = (J["date"] - J["date_dof"]).dt.days.abs()
    same = (J["price"] - J["price_dof"]).abs() <= np.maximum(1, 0.005 * J["price_dof"])
    twins = set(J.loc[(dd <= 10) | (same & (dd <= 120)), "_i"])
    return rows[~rows.index.isin(twins)]


def neighborhoods(lots, pluto: pd.DataFrame, sales: pd.DataFrame) -> np.ndarray:
    """Each lot's DOF neighborhood: its own latest DOF sale record (any building class), else the
    nearest lot that has one (as seller rows get theirs, build.py)."""
    own = sales.dropna(subset=["neighborhood"]).sort_values("date", kind="mergesort").groupby("bbl")["neighborhood"].last()
    out = np.array([own.get(b) for b in lots], dtype=object)
    need = np.array([v is None for v in out])
    if need.any():
        P = pluto.drop_duplicates("bbl").set_index("bbl")[["latitude", "longitude"]].dropna()
        known = P[P.index.isin(own.index)]
        if len(known):
            tree = cKDTree(xy(known["latitude"], known["longitude"]))
            for i in np.flatnonzero(need):
                if lots[i] in P.index:
                    q = P.loc[lots[i]]
                    out[i] = own[known.index[tree.query(xy([q["latitude"]], [q["longitude"]]))[1][0]]]
    return out
