"""Brief 49 PR 6: months neither DOF sales file covers yet are rebuilt from ACRIS deeds.
Invented data only; no network."""
import numpy as np
import pandas as pd

from valuation.dfval import config
from valuation.dfval.build import Inputs
from valuation.dfval.gapfill import SOURCE, deed_sales, drop_dof_twins, missing_months
from valuation.dfval.raw import Raw
from valuation.dfval.sales import KEEP

from .conftest import write_folder

M = pd.Timestamp


def test_missing_months_lie_between_the_annual_file_and_the_rolling_cutover():
    assert missing_months({"annual_last_sale": "2024-12-31", "cutover": "2025-02-01"}) == [M("2025-01-01")]  # a February run
    assert missing_months({"annual_last_sale": "2024-12-30", "cutover": "2025-06-01"}) == [M(f"2025-0{k}-01") for k in range(1, 6)]  # June
    assert missing_months({"annual_last_sale": "2025-12-31", "cutover": "2025-10-01"}) == []  # October: the files overlap
    assert missing_months({"annual_last_sale": "2025-09-30", "cutover": "2025-10-01"}) == []
    assert missing_months({"annual_last_sale": None, "cutover": "2025-10-01"}) == []


def _pluto():
    rows = [("3000010001", "B1", "101 EXAMPLE STREET", 40.68, -73.95), ("3000010002", "C3", "103 EXAMPLE STREET", 40.6801, -73.95),
            ("3000010003", "D4", "105 EXAMPLE STREET", 40.6802, -73.95),   # 6+ unit building: not a 1-4 family home
            ("3000020001", "A1", "7 SAMPLE AVENUE", 40.70, -73.90)]
    return pd.DataFrame([{"bbl": b, "bldgclass": c, "address": a, "zipcode": "11216", "latitude": la, "longitude": lo, "unitsres": 3.0,
                          "unitstotal": 3.0, "lotarea": 2000.0, "bldgarea": 2400.0, "yearbuilt": 1905.0} for b, c, a, la, lo in rows])


def _deeds(rows):
    return pd.DataFrame([{"document_id": d, "bbl": b, "doc_type": "DEED", "amt": a, "ddate": M(dd), "pct": 100.0, "recorded_datetime": None, "n_lots": 1}
                         for d, b, a, dd in rows])


def _dof(rows):
    return pd.DataFrame([{"bbl": b, "date": M(d), "price": p, "neighborhood": nb} for b, d, p, nb in rows])


def test_deeds_in_the_missing_months_become_sales_rows():
    deeds = _deeds([("D1", "3000010001", 1_500_000, "2025-01-14"),
                    ("D1", "3000010001", 1_400_000, "2025-01-14"),   # the city repeats a document with another amount: one row
                    ("D2", "3000010002", 2_100_000, "2025-01-20"),
                    ("D3", "3000010003", 3_000_000, "2025-01-21"),   # not a 1-4 family lot
                    ("D4", "3000010001", 0, "2025-01-25"),           # no amount
                    ("D5", "3000020001", 900_000, "2025-02-03"),     # outside the missing month
                    ("D6", "3000020001", 950_000, "2025-01-30")])
    dof = _dof([("3000010001", "2019-05-01", 900_000, "BUSHWICK"), ("3000010002", "2018-02-01", 800_000, "BUSHWICK")])
    out = deed_sales(deeds, _pluto(), dof, [M("2025-01-01")])
    assert list(out["bbl"]) == ["3000010001", "3000010002", "3000020001"]
    assert list(out["price"]) == [1_500_000, 2_100_000, 950_000] and list(out["date"].dt.day) == [14, 20, 30]
    assert list(out["bldg_class_sale"]) == ["B1", "C3", "A1"] and list(out["tax_class_sale"]) == ["1", "2", "1"]
    # neighborhood: the lot's own latest DOF record, else the nearest lot that has one
    assert list(out["neighborhood"]) == ["BUSHWICK", "BUSHWICK", "BUSHWICK"]
    assert set(out["src"]) == {SOURCE} and list(out["address"]) == ["101 EXAMPLE STREET", "103 EXAMPLE STREET", "7 SAMPLE AVENUE"]
    assert set(KEEP) <= set(out.columns)
    assert deed_sales(deeds, _pluto(), dof, []).empty  # no missing month: nothing


def test_a_deed_that_is_a_dof_sales_own_deed_is_left_out():
    rows = pd.DataFrame({"bbl": ["3000010001", "3000010002", "3000020001"], "date": [M("2025-01-30"), M("2025-01-10"), M("2025-01-10")],
                         "price": [1_000_000.0, 2_000_000.0, 700_000.0]})
    dof = _dof([("3000010001", "2025-02-01", 1_000_000, "X"),    # DOF dates it Feb 1: the same sale
                ("3000010002", "2025-04-20", 2_004_000, "X"),    # same amount, 100 days later: the same sale
                ("3000020001", "2025-06-01", 700_000, "X")])     # same amount, 142 days later: another sale
    assert list(drop_dof_twins(rows, dof)["bbl"]) == ["3000020001"]


def test_a_february_run_rebuilds_january_and_screens_it_like_any_sale(tmp_path, world):
    L, Sx = world
    full = Inputs(Raw(write_folder(str(tmp_path / "full"), L, Sx)), log=lambda m: None)
    gap = Inputs(Raw(write_folder(str(tmp_path / "gap"), L, Sx, cutover="2025-02-01", annual_end="2025-01-01")), log=lambda m: None)
    assert full.sales_info["gap_sales_rebuilt"] == 0 and full.sales_info["gap_months_rebuilt"] == 0
    assert gap.sales_info["gap_months"] == 1 and gap.sales_info["gap_months_rebuilt"] == 1
    jan = lambda S: S[(S["date"] >= "2025-01-01") & (S["date"] < "2025-02-01")]  # noqa: E731
    assert len(jan(gap.sales[gap.sales["src"] != SOURCE])) == 0  # no DOF sales in January without the rebuild
    rebuilt = gap.sales[gap.sales["src"] == SOURCE]
    assert gap.sales_info["gap_sales_rebuilt"] == len(rebuilt) > 0
    # The fixture's deeds are dated 2 days before the DOF sale: each January sale comes back once, at its own price.
    want = Sx[(Sx["date"] >= "2025-01-03") & (Sx["date"] < "2025-02-01")]
    assert sorted(zip(rebuilt["bbl"], rebuilt["price"])) == sorted(zip(want["bbl"], want["price"].astype(float)))
    # Matched to their deeds and screened like DOF sales: the same January sales are model sales as with the full files.
    sub = lambda inp: jan(inp.S[inp.S["clean"] & inp.S["acris_matched"] & (inp.S["doc_type"] == config.ORDINARY_DEED)])  # noqa: E731
    pairs = lambda S: set(zip(S["bbl"], S["price"].astype(float)))  # noqa: E731
    got, ref = pairs(sub(gap)), pairs(sub(full)[sub(full)["date"] >= "2025-01-03"])
    assert got and got <= pairs(sub(full)) and len(got & ref) >= 0.95 * len(ref)
    # Nothing is counted twice: the deeds of February 1-2 sales (dated Jan 30-31) aren't rebuilt.
    feb = Sx[(Sx["date"] >= "2025-02-01") & (Sx["date"] < "2025-02-03")]
    assert not set(zip(feb["bbl"], feb["price"].astype(float))) & set(zip(rebuilt["bbl"], rebuilt["price"]))


def test_without_a_missing_month_the_sales_table_is_unchanged(data_dir):
    inp = Inputs(Raw(data_dir), log=lambda m: None)
    assert inp.sales_info["gap_sales_rebuilt"] == 0 and SOURCE not in set(inp.sales["src"])
    assert np.isfinite(inp.sales["price"]).all()
