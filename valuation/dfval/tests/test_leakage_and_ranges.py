"""No-leakage, range-sizing and run-bookkeeping rules (Brief 44 PR 2 review). Invented data only."""
import numpy as np
import pandas as pd
import pytest

from valuation.dfval import config, contract
from valuation.dfval import model as MD
from valuation.dfval.build import Inputs
from valuation.dfval.features import cond_features
from valuation.dfval.raw import Raw
from valuation.dfval.runjob import match_targets, plan_months, recount, size_ranges
from valuation.dfval.targets import AddressIndex


def test_train_mask_is_earlier_priced_sales_within_48_months():
    X = pd.DataFrame({"date": pd.to_datetime(["2020-01-15", "2022-06-01", "2026-03-31", "2026-04-01", "2026-04-20", "2026-02-01"]),
                      "price": [1e6, 1e6, 1e6, 1e6, 1e6, np.nan]})
    m = pd.Timestamp("2026-04-01")
    assert list(MD.train_mask(X, m, 48)) == [False, True, True, False, False, False]
    assert list(MD.train_mask(X, m, None)) == [True, True, True, False, False, False]


def test_walk_forward_never_trains_on_the_scored_month(monkeypatch):
    seen = {}

    class Dummy:
        def predict(self, Z):
            return np.zeros(len(Z))

    def fake_fit(X, rows, y, feats, **kw):
        seen.setdefault("max_train", []).append(X.loc[rows, "date"].max())
        return Dummy()

    monkeypatch.setattr(MD, "fit", fake_fit)
    months = pd.date_range("2025-01-01", "2025-06-01", freq="MS")
    X = pd.DataFrame({"date": [m + pd.Timedelta(days=d) for m in months for d in (0, 10, 27)]})
    X["month"] = X["date"].dt.to_period("M").dt.to_timestamp()
    X["price"] = 1e6
    MD.walk_forward(X, months[1:], ["price"])
    assert all(t < m for t, m in zip(seen["max_train"], months[1:]))


def test_ranges_are_sized_on_the_range_months_and_checked_on_the_gate_months():
    rng = np.random.default_rng(9)
    n = 3000
    y = np.log(rng.uniform(6e5, 3e6, n))
    in_rng = np.zeros(n, bool)
    in_rng[:2000] = True
    in_gate = ~in_rng
    top = np.zeros(n, bool)
    top[::4] = True
    # range months: misses spread up to 20%; gate months: much wider misses, which must not size the range
    miss = np.where(in_rng, rng.uniform(-0.2, 0.2, n), rng.uniform(-0.6, 0.6, n))
    pred = y - np.log1p(miss)          # price / value - 1 = miss
    r = size_ranges(pred, y, top, in_rng, in_gate)
    assert abs(r["w_other"] - 0.2 * 2 / 3) < 0.01 and abs(r["w_top"] - 0.2 * 2 / 3) < 0.015
    assert r["cover"] < 0.4  # measured on the wider gate months
    # the shown range is value x (1 +/- w): "inside" is exactly |price / value - 1| <= w
    v = np.exp(pred)
    price = np.exp(y)
    assert np.array_equal(r["inside"], (price >= v * (1 - r["w"]) - 1e-6) & (price <= v * (1 + r["w"]) + 1e-6))


def test_a_half_recorded_newest_month_is_not_a_gate_month():
    counts = pd.Series({pd.Timestamp(f"2026-{m:02d}-01"): c for m, c in [(3, 1000), (4, 1000), (5, 1100), (6, 1050), (7, 1100), (8, 1100), (9, 500)]})
    rng, gate = plan_months(pd.Timestamp("2026-10-01"), counts)
    assert [g.strftime("%Y-%m") for g in gate] == ["2026-06", "2026-07", "2026-08"]
    assert rng[-1].strftime("%Y-%m") == "2026-05"
    counts[pd.Timestamp("2026-09-01")] = 1000  # a full month stays in
    assert plan_months(pd.Timestamp("2026-10-01"), counts)[1][-1].strftime("%Y-%m") == "2026-09"


def _cond_inputs(bbl):
    t = lambda *ds: list(pd.to_datetime(list(ds)).strftime("%Y-%m-%dT00:00:00.000"))  # noqa: E731
    empty = lambda cols: pd.DataFrame({c: pd.Series(dtype=object) for c in cols})  # noqa: E731
    bis = empty(["bbl", "job_type", "work_type", "issuance_date"])
    npm = empty(["bbl", "work_type", "issued_date"])
    el = empty(["bbl_key", "permit_issued_date", "filing_date"])
    bj = empty(["bbl", "fully_permitted", "approved", "pre__filing_date", "initial_cost", "proposed_dwelling_units", "existing_dwelling_units", "job_type", "job_description"])
    nj = pd.DataFrame({"bbl": [bbl, bbl], "first_permit_date": t("2024-05-01", "2024-07-01"), "approved_date": [None, None], "filing_date": [None, None],
                       "initial_cost": ["50000", "90000"], "proposed_dwelling_units": ["2", "2"], "existing_dwelling_units": ["2", "2"],
                       "job_type": ["Alteration", "Alteration"], "job_description": ["KITCHEN", "GUT RENOVATION"]})
    hv = pd.DataFrame({"bbl": [bbl, bbl], "class": ["B", "C"], "novissueddate": t("2024-01-01", "2024-07-01"), "inspectiondate": [None, None],
                       "currentstatusdate": [None, None], "violationstatus": ["Open", "Open"]})
    dv = empty(["bbl_key", "issue_date", "violation_category"])
    ecb = empty(["bbl_key", "issue_date", "severity"])
    return bis, npm, el, bj, nj, hv, dv, ecb


def test_jobs_and_violations_after_the_date_are_not_counted():
    bbl = "3000060001"
    X = pd.DataFrame({"bbl": [bbl], "date": [pd.Timestamp("2024-06-15")], "grp": ["2F"], "sqft": [2000.0], "lat": [40.68], "lon": [-73.95]})
    S = pd.DataFrame({"bbl": pd.Series(dtype=object), "date": pd.to_datetime([]), "price": pd.Series(dtype=float), "sqft": pd.Series(dtype=float),
                      "grp": pd.Series(dtype=object), "lat": pd.Series(dtype=float), "lon": pd.Series(dtype=float), "clean": pd.Series(dtype=bool)})
    F = cond_features(X, S, *_cond_inputs(bbl))
    assert F.loc[0, "cost_sum_7y"] == 50_000 and F.loc[0, "kw_kitchen_7y"] == 1.0 and F.loc[0, "kw_gut_7y"] == 0.0  # the July job is after the date
    assert F.loc[0, "hpd_BC_open_at_sale"] == 1  # the July violation didn't exist yet


def test_cached_lot_wins_over_the_address(data_dir, world):
    L, _ = world
    raw = Raw(data_dir)
    pluto = raw.pluto()
    ix = AddressIndex(pluto, pd.DataFrame({"bbl": [], "address": []}))
    a, b = L.iloc[0], L.iloc[1]
    sellers = pd.DataFrame([{"contactId": "c1", "address": f"{a.number} {a.street.title()}", "city": "Brooklyn", "zip": a.zip,
                             "unitCount": None, "buildingSqft": None, "cachedBbl": b.bbl}])
    M = match_targets(sellers, pluto, ix)
    assert (M.loc[0, "bbl"], M.loc[0, "how"]) == (b.bbl, "cached")


def test_seller_rows_use_pluto_the_roll_in_effect_and_the_lots_own_neighborhood(data_dir, world):
    L, Sx = world
    inp = Inputs(Raw(data_dir), log=lambda m: None)
    lot = L.iloc[5]
    asof = pd.Timestamp("2026-10-01")
    R = inp.seller_rows(pd.DataFrame({"contactId": ["c1"], "bbl": [lot.bbl]}), asof).iloc[0]
    assert R["date"] == asof and R["is_seller"] and np.isnan(R["price"])
    assert R["neighborhood"] == Sx[Sx["bbl"] == lot.bbl].sort_values("date")["nb"].iloc[-1]
    assert R["sqft"] == round(lot.sqft) and R["grp"] == {"A1": "1F", "B1": "2F", "B2": "2F", "C0": "3F", "C3": "4F"}[lot.cls]
    assert R["tax_class_sale"] == ("2" if lot.cls == "C3" else "1")  # FY2027 final roll, in effect on Oct 1, 2026


def test_recount_after_dropping_refused_sellers():
    rows = [{"contactId": f"c{i}", "value": 1e6 if i < 1301 else None, "reason": None if i < 1301 else "not_found"} for i in range(1310)]
    run = {"counts": {"targets": 1310, "valued": 1301, "five_plus_units": 0, "condo_without_unit": 0, "not_found": 9, "other_property_type": 0,
                      "trainingSales": 5, "gateSales": 5},
           "gates": {"passed": True, "checks": [{"key": "sellers_valued", "value": 1301.0, "pass": True}, {"key": "range_coverage", "value": 0.66, "pass": True}]},
           "expectedRows": 1310}
    r2 = recount(run, [r for r in rows if r["contactId"] not in {"c0", "c1"}])
    assert r2["counts"]["targets"] == 1308 and r2["counts"]["valued"] == 1299 and r2["expectedRows"] == 1308
    assert not r2["gates"]["passed"] and r2["gates"]["checks"][0] == {"key": "sellers_valued", "value": 1299.0, "pass": False}


def test_contract_check_is_as_strict_as_dealflows():
    for bad in ({"a\n": 1}, {"k": {str(i): 1 for i in range(65)}}, {"lots": {"3000000001": 1}}):
        with pytest.raises(contract.Invalid):
            contract.number_tree(bad)
    contract.number_tree({"by_month": {"202609": 0.1}, "by_zip": {"11216": 1}})
    with pytest.raises(contract.Invalid):
        contract._day("2026-02-30", "x")
