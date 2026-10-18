"""Match each 1-4 family DOF sale to its ACRIS deed (research: match_deeds.py).

ACRIS Master + Legals only: no parties dataset and no names (Brief 44 revision 3). The
Legals borough is the property's borough; Master's recorded_borough is the recording office
and isn't used (research gotcha, Brief 39 REPORT §6).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import config


def deed_table(master: pd.DataFrame, legals: pd.DataFrame) -> pd.DataFrame:
    """One row per (deed, lot), with the deed's type, amount, date, share and lot count."""
    M = master.copy()
    M["amt"] = pd.to_numeric(M["document_amt"], errors="coerce").fillna(0)
    M["ddate"] = pd.to_datetime(M["document_date"], errors="coerce")
    M["pct"] = pd.to_numeric(M["percent_trans"], errors="coerce")
    L = legals[legals["document_id"].isin(set(M["document_id"]))]
    lots = L.groupby("document_id")["bbl"].nunique().rename("n_lots")
    return (L[["document_id", "bbl"]].drop_duplicates()
            .merge(M[["document_id", "doc_type", "amt", "ddate", "pct", "recorded_datetime"]], on="document_id")
            .merge(lots, on="document_id"))


def match_deeds(sales: pd.DataFrame, deeds: pd.DataFrame, end: pd.Timestamp) -> pd.DataFrame:
    """1-4 family sales from ACRIS_START to `end`, each with its best-matching deed (or none).

    A deed matches a sale on the same lot when its document date is within 10 days of the sale,
    or within 120 days with the same amount (to 0.5%); the amount match wins, then the closer date."""
    fam = sales["bldg_class_sale"].fillna("").str.match(config.FAMILY_CLASSES)
    win = (sales["date"] >= config.ACRIS_START) & (sales["date"] < end)
    C = sales[fam & win].copy().reset_index(drop=True)
    C["cand_id"] = np.arange(len(C))
    J = C[["cand_id", "bbl", "date", "price"]].merge(deeds, on="bbl", how="left")
    J["dd"] = (J["ddate"] - J["date"]).dt.days.abs()
    J["amt_ok"] = (J["amt"] - J["price"]).abs() <= np.maximum(1, 0.005 * J["price"])
    J = J[(J["dd"] <= 10) | (J["amt_ok"] & (J["dd"] <= 120))]
    J["score"] = J["amt_ok"].astype(int) * 10 - J["dd"].fillna(999) / 100
    # Ties broken by document id so every run picks the same deed (the research's sort wasn't stable).
    best = J.sort_values(["score", "document_id"], ascending=[False, True], kind="mergesort").drop_duplicates("cand_id")
    C = C.merge(best[["cand_id", "document_id", "doc_type", "amt", "ddate", "pct", "n_lots", "amt_ok", "dd"]], on="cand_id", how="left")
    C["acris_matched"] = C["document_id"].notna()
    C["amt_ok"] = C["amt_ok"].astype(float)
    return C.drop(columns="cand_id")
