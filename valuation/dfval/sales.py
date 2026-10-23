"""One table of Brooklyn and Queens DOF sales, 2003 to the newest month (research: build_sales.py).

Three city sources, stitched end to end:
- the 26 DOF Excel files for 2003-2015;
- DOF annualized sales (w2pb-icbu) from 2016 up to the cut-over;
- DOF rolling sales (usep-8jbt) from the cut-over on.

The rolling file covers the last 12 months and the annualized file whole calendar years, so
the two overlap (in October 2026, by Oct-Dec 2025). The cut-over is chosen each run as the
first full month of the rolling file; each sale comes from exactly one source, so overlap
months are never counted twice (Brief 44 revision 6).
"""
from __future__ import annotations

import pandas as pd

from .raw import Raw

KEEP = ["borough", "neighborhood", "bcc", "tax_class_present", "block", "lot", "bldg_class_present", "address", "apt", "zip",
        "res_units", "com_units", "tot_units", "land_sqft", "gross_sqft", "year_built", "tax_class_sale", "bldg_class_sale",
        "price", "date", "src", "latitude", "longitude"]
NUMERIC = ["res_units", "com_units", "tot_units", "land_sqft", "gross_sqft", "year_built", "price", "latitude", "longitude"]
TEXT = ["neighborhood", "bcc", "bldg_class_sale", "bldg_class_present", "tax_class_sale", "tax_class_present", "address", "apt"]


def rolling_cutover(rolling_dates: pd.Series) -> pd.Timestamp:
    """The first month of the rolling file that is at least half as full as its typical month.

    A stray early-dated row can't pull the cut-over back into months the rolling file
    doesn't really cover."""
    months = rolling_dates.dropna().dt.to_period("M").value_counts().sort_index()
    if months.empty:
        raise RuntimeError("the rolling sales file has no dated sales")
    full = months[months >= 0.5 * months.median()]
    return full.index[0].to_timestamp()


def build_sales(raw: Raw) -> tuple[pd.DataFrame, dict]:
    xls = raw.dof_xls()
    ann = raw.sales_open_data("sales_annual")
    rol = raw.sales_open_data("sales_rolling")
    cut = rolling_cutover(rol["date"])
    ann = ann[ann["date"] < cut]
    rol = rol[rol["date"] >= cut]
    # Months with no sales in either file (the annualized year not yet posted): counted here and
    # rebuilt from ACRIS deeds later, once the deeds are loaded (gapfill.py, Brief 49 PR 6).
    ann_last = ann["date"].max()
    gap_months = max(0, (cut.year - ann_last.year) * 12 + cut.month - ann_last.month - 1) if pd.notna(ann_last) else None
    allf = pd.concat([xls, ann, rol], ignore_index=True)
    allf = allf[[c for c in KEEP if c in allf.columns]].copy()
    for c in NUMERIC:
        t = allf[c].astype(str).str.replace(r"[,$\s]", "", regex=True).replace({"-": None, "": None, "nan": None, "None": None, "<NA>": None})
        allf[c] = pd.to_numeric(t, errors="coerce")
    for c in ["borough", "block", "lot"]:
        allf[c] = pd.to_numeric(allf[c], errors="coerce").astype("Int64")
    allf = allf.dropna(subset=["borough", "block", "lot", "date"])
    allf = allf[allf["borough"].isin([3, 4])]
    # Rebuilt from borough/block/lot, as the research did: the city's own bbl column points
    # condo sales at the building's billing lot and is blank on some rows (Brief 44.1).
    allf["bbl"] = (allf["borough"].astype(str) + allf["block"].astype(int).astype(str).str.zfill(5)
                   + allf["lot"].astype(int).astype(str).str.zfill(4))
    for c in TEXT:
        allf[c] = allf[c].astype(str).str.strip().replace({"nan": None, "None": None, "<NA>": None})
    allf["bldg_class_sale"] = allf["bldg_class_sale"].str.upper()
    info = {
        "cutover": cut.date().isoformat(),
        "annual_last_sale": ann_last.date().isoformat() if pd.notna(ann_last) else None,
        "rolling_last_sale": rol["date"].max().date().isoformat(),
        "gap_months": gap_months,
        "rows": int(len(allf)),
    }
    return allf.reset_index(drop=True), info
