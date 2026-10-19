import numpy as np
import pandas as pd
import pytest

from valuation.dfval import config
from valuation.dfval.deeds import match_deeds
from valuation.dfval.features import base_features, count_window, r2_features
from valuation.dfval.frame import build_frame, roll_for, roll_releases, subjects
from valuation.dfval.index import build_pairs, fit_index
from valuation.dfval.raw import Raw, bbl_from_parts, clean_bbl
from valuation.dfval.runjob import gate_checks, plan_months
from valuation.dfval.sales import build_sales, rolling_cutover


# ---- raw readers -------------------------------------------------------------------------------
def test_bbl_helpers():
    assert list(bbl_from_parts(["3", "4", "3"], ["00012", "00345", "x"], ["00034", "56", "1"])) == ["3000120034", "4003450056", pd.NA]
    assert list(clean_bbl(pd.Series(["4000120034.00000000", "4123456", None, "3000120034"]))) == ["4000120034", pd.NA, pd.NA, "3000120034"]


def test_incomplete_download_is_refused(tmp_path):
    (tmp_path / "raw").mkdir()
    (tmp_path / "manifest.json").write_text('{"run": {"status": "failed"}, "files": {}}')
    with pytest.raises(RuntimeError, match="did not complete"):
        Raw(str(tmp_path)).manifest


# ---- sales: one source per sale across the overlap --------------------------------------------
def test_rolling_cutover_ignores_stray_early_rows():
    d = pd.Series(pd.to_datetime(["2025-06-03"] + ["2025-10-05"] * 50 + ["2025-11-05"] * 60 + ["2026-09-01"] * 55))
    assert rolling_cutover(d) == pd.Timestamp("2025-10-01")


def test_sales_are_stitched_without_overlap(data_dir, world):
    _, Sx = world
    sales, info = build_sales(Raw(data_dir))
    assert info["cutover"] == "2025-10-01" and info["gap_months"] == 0
    # the annualized file in the fixture covers Oct-Dec 2025 too; each sale is counted once
    assert len(sales) == len(Sx)
    assert not sales.duplicated(["bbl", "date", "price"]).any()
    assert set(sales.loc[sales["date"] >= "2025-10-01", "src"]) == {config.DATASETS["sales_rolling"]}
    assert sales["bbl"].str.match(r"^[34]\d{9}$").all()


# ---- deeds and the arm's-length screens ----------------------------------------------------------
def _sale(bbl, date, price, cls="B1", nb="BUSHWICK", sqft=2000.0):
    return {"bbl": bbl, "date": pd.Timestamp(date), "price": price, "bldg_class_sale": cls, "neighborhood": nb, "borough": int(bbl[0]),
            "gross_sqft": sqft, "tax_class_sale": "1", "latitude": np.nan, "longitude": np.nan, "address": f"{int(bbl[-4:]) + 100} EXAMPLE STREET"}


def _deeds(rows):
    return pd.DataFrame([{"document_id": d, "bbl": b, "doc_type": t, "amt": a, "ddate": pd.Timestamp(dd), "pct": pc, "recorded_datetime": None, "n_lots": n}
                         for d, b, t, a, dd, pc, n in rows])


def test_deed_match_rules():
    sales = pd.DataFrame([_sale("3000010001", "2024-03-10", 1_000_000), _sale("3000010002", "2024-03-10", 900_000),
                          _sale("3000010003", "2024-03-10", 800_000)])
    deeds = _deeds([("D1", "3000010001", "DEED", 1_000_000, "2024-01-20", 100, 1),   # same amount within 120 days: matches
                    ("D2", "3000010001", "DEED", 0, "2024-03-12", 100, 1),           # within 10 days, no amount: loses to D1
                    ("D3", "3000010002", "DEED", 1, "2024-07-30", 100, 1),           # too far, wrong amount: no match
                    ("D4", "3000010003", "DEEDO", 800_000, "2024-03-08", 100, 1)])
    C = match_deeds(sales, deeds, pd.Timestamp("2026-09-01")).set_index("bbl")
    assert C.loc["3000010001", "document_id"] == "D1"
    assert not C.loc["3000010002", "acris_matched"]
    assert C.loc["3000010003", "doc_type"] == "DEEDO"


def _pluto(bbls):
    return pd.DataFrame({"bbl": bbls, "latitude": 40.68, "longitude": -73.95, "bldgarea": 2000.0, "yearbuilt": 1910})


def test_screens():
    b = [f"30000200{i:02d}" for i in range(7)]
    sales = pd.DataFrame([_sale(b[0], "2024-05-01", 1_000_000),           # ordinary
                          _sale(b[1], "2024-05-01", 90_000),              # under $100k
                          _sale(b[2], "2024-05-02", 1_200_000), _sale(b[3], "2024-05-02", 1_200_000),  # one price on two lots (DOF multi-lot)
                          _sale(b[4], "2024-05-03", 1_100_000),           # half the interest
                          _sale(b[5], "2024-05-04", 300_000),             # far below the city's market value
                          _sale(b[6], "2024-05-05", 1_050_000)])          # a family transfer per the saved flags
    cand = pd.DataFrame({"bbl": b, "date": sales["date"], "price": sales["price"], "document_id": [f"D{i}" for i in range(7)],
                         "doc_type": "DEED", "pct": [100, 100, 100, 100, 50, 100, 100], "n_lots": [1, 1, 2, 2, 1, 1, 1], "acris_matched": True})
    roll = pd.DataFrame({"parid": b, "year": 2025, "period": 1, "mv": 1_000_000.0})
    S = build_frame(sales, _pluto(b), cand, roll, screen="name-free", min_ratio=0.4).set_index("bbl")
    assert S["clean"].to_dict() == {b[0]: True, b[1]: False, b[2]: False, b[3]: False, b[4]: False, b[5]: False, b[6]: True}
    assert S.loc[b[5], "low_vs_mv"] and not S.loc[b[0], "low_vs_mv"]
    flags = pd.DataFrame({"shared_surname": [True], "same_party": [False], "referee": [False]}, index=["D6"])
    F = build_frame(sales, _pluto(b), cand, roll, screen="flags", flags=flags).set_index("bbl")
    assert not F.loc[b[6], "clean"] and F.loc[b[5], "clean"]  # the flags screen has no market-value test
    with pytest.raises(ValueError):
        build_frame(sales, _pluto(b), cand, roll, screen="flags")


def test_roll_in_effect():
    rel = roll_releases([2026, 2027])
    assert roll_for(pd.Timestamp("2025-01-14"), rel) is None          # before FY2026's tentative roll (Jan 15, 2025)
    assert roll_for(pd.Timestamp("2026-01-14"), rel) == (2026, 3)     # FY2026 final (Jun 1, 2025)
    assert roll_for(pd.Timestamp("2026-01-16"), rel) == (2027, 1)     # FY2027 tentative (Jan 15, 2026)
    assert roll_for(pd.Timestamp("2026-06-02"), rel) == (2027, 3)


# ---- no leakage --------------------------------------------------------------------------------
def test_index_uses_only_pairs_before_the_cutoff():
    rng = np.random.default_rng(5)
    rows = []
    for k in range(40):
        rows += [_sale(f"30000300{k:02d}", "2020-01-15", 500_000), _sale(f"30000300{k:02d}", "2024-02-15", 700_000 * float(np.exp(rng.normal(0, 0.05))))]
    rows += [_sale(f"30000300{k:02d}", "2024-09-15", 2_000_000) for k in range(40)]  # after the cutoff: must not count
    S = pd.DataFrame(rows).assign(clean=True, grp="2F", sqft=2000.0)
    P = build_pairs(S)
    ix = fit_index(P, pd.Timestamp("2024-06-01"))[3]
    growth = np.exp(ix.level("BUSHWICK", ix.qlast) - ix.level("BUSHWICK", 68))  # 2020Q1 -> now
    assert abs(growth - 1.4) < 0.05


def test_comps_use_only_earlier_sales_on_other_lots():
    S = pd.DataFrame([_sale(f"30000400{k:02d}", f"2024-0{1 + k % 5}-10", 1_000_000 + 10_000 * k) for k in range(12)]
                     + [_sale("3000040099", "2024-07-01", 9_000_000),   # later than the subject: never a comp
                        _sale("3000040098", "2024-06-15", 9_000_000)])  # the subject's own day: never a comp
    S = S.assign(clean=True, grp="2F", sqft=2000.0, lat=40.68, lon=-73.95)
    X = pd.DataFrame([{**_sale("3000040000", "2024-06-15", np.nan), "grp": "2F", "sqft": 2000.0, "lat": 40.68, "lon": -73.95,
                       "month": pd.Timestamp("2024-06-01"), "is_seller": True}])
    IDX = {pd.Timestamp("2024-06-01"): fit_index(build_pairs(S), pd.Timestamp("2024-06-01"))}
    pluto = pd.DataFrame({"bbl": ["3000040000"], "lotfront": "20", "lotdepth": "100", "bldgfront": "20", "bldgdepth": "50", "builtfar": "1",
                          "residfar": "2", "zonedist1": "R6B", "histdist": None, "landmark": None, "proxcode": "2", "irrlotcode": "False",
                          "bsmtcode": "2", "ext": None, "numfloors": 3.0, "lotarea": 2000.0, "yearalter1": 0.0, "yearalter2": 0.0})
    out = {}
    R = base_features(X, S, IDX, pd.DataFrame({"parid": [], "year": [], "period": [], "mv": []}), pluto,
                      pd.DataFrame({"lat": [40.69], "lon": [-73.95]}), pd.DataFrame({"bbl": [], "d": [], "major": []}), out)
    used = out[0]
    assert len(used) == 11 and (used["date"] < "2024-06-15").all() and "3000040000" not in set(S.loc[used.index, "bbl"])
    assert not (used["price"] == 9_000_000).any()
    assert R.loc[0, "comps_n"] == 11 and R.loc[0, "comps_est"] < 1_200_000


def test_count_window_is_strictly_before_the_date():
    X = pd.DataFrame({"bbl": ["L"], "date": [pd.Timestamp("2024-06-01")], "ps_date": [pd.Timestamp("2022-01-01")]})
    ev = {"L": np.sort(pd.to_datetime(["2021-07-01", "2022-01-01", "2023-01-01", "2024-06-01", "2024-07-01"]).values.astype("int64"))}
    assert count_window(X, ev, pd.Timedelta(days=1096))[0] == 3      # the 3 before the sale day; not the sale day, not after
    assert count_window(X, ev, since=True)[0] == 1                   # strictly after the prior sale
    assert np.isnan(count_window(X.assign(ps_date=pd.NaT), ev, since=True)[0])


def test_footprint_edited_after_the_date_is_ignored():
    X = pd.DataFrame({"bbl": ["3000050001", "3000050001"], "date": pd.to_datetime(["2020-01-01", "2024-01-01"])})
    fp = pd.DataFrame({"base_bbl": ["3000050001"], "shape_area": ["100"], "height_roof": ["30"], "last_edited_date": ["2022-05-01T00:00:00.000Z"]})
    pl = pd.DataFrame({"bbl": ["3000050001"], "bldgarea": [3000.0], "numfloors": [3.0], "bldgfront": ["20"], "bldgdepth": ["50"]})
    ex = pd.DataFrame({"parid": ["3000050001"], "year": [2024]})
    F = r2_features(X, pl, fp, ex)
    assert np.isnan(F.loc[0, "fp_area"]) and F.loc[1, "fp_area"] == pytest.approx(1076.39)
    assert list(F["exempt_421a"]) == [0.0, 1.0]  # 2020: no roll year in the exemption file; 2024 sale: FY2024 roll


def test_subjects_need_an_ordinary_deed():
    S = pd.DataFrame({"clean": [True, True, True, False], "acris_matched": [True, True, False, True], "doc_type": ["DEED", "DEEDO", None, "DEED"]})
    assert list(subjects(S)) == [True, False, False, False]


# ---- months, gates -------------------------------------------------------------------------------
def test_plan_months():
    rng, gate = plan_months(pd.Timestamp("2026-10-01"))
    assert [m.strftime("%Y-%m") for m in gate] == ["2026-07", "2026-08", "2026-09"]
    assert rng[0].strftime("%Y-%m") == "2025-07" and rng[-1].strftime("%Y-%m") == "2026-06" and len(rng) == 12


def test_gates():
    ok, checks = gate_checks(0.11, 0.14, 0.66, 1400)
    assert ok and all(c["pass"] for c in checks)
    for args, key in (((0.116, 0.14, 0.66, 1400), "typical_miss_all"), ((0.11, 0.146, 0.66, 1400), "typical_miss_top8_2to4"),
                      ((0.11, 0.14, 0.59, 1400), "range_coverage"), ((0.11, 0.14, 0.76, 1400), "range_coverage"),
                      ((0.11, 0.14, 0.66, 1299), "sellers_valued"), ((float("nan"), 0.14, 0.66, 1400), "typical_miss_all")):
        ok, checks = gate_checks(*args)
        assert not ok and [c["key"] for c in checks if not c["pass"]] == [key]
