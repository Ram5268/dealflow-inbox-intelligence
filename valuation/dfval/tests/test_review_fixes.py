"""Reviewer's regression tests for PR 2 (invented data only; no such streets exist)."""
import numpy as np
import pandas as pd
import pytest

from valuation.dfval import contract
from valuation.dfval.facts import facts_for
from valuation.dfval.frame import price_to_market_value, roll_for, roll_releases, roll_releases_of
from valuation.dfval.runjob import match_targets
from valuation.dfval.targets import AddressIndex


def _pluto():
    return pd.DataFrame({
        "bbl": ["3090000001", "3090010001", "3090020001", "3090030001", "3090040001", "3090040002", "4090050001", "4090060001", "3090070001"],
        "address": ["500 EAST 801 STREET", "500 EAST 803 STREET", "50 NORTH 905 STREET", "50 SOUTH 905 STREET",
                    "123A EXAMPLE STREET", "123B EXAMPLE STREET", "12-36 901 STREET", "12-34 902 STREET", "20 SPARE STREET"],
        "zipcode": ["11299", "11299", "11298", "11298", "11297", "11297", "11396", "11396", "11295"],
        "unitsres": [2, 2, 2, 2, 2, 2, 2, 2, 8], "bldgarea": [2000] * 8 + [9000],
        "bldgclass": ["B1"] * 8 + ["R4"], "condono": [None] * 8 + ["1"], "latitude": 40.68, "longitude": -73.95,
    })


@pytest.mark.parametrize("addr,zip_", [
    ("500 E 802nd St", "11299"),   # not in PLUTO; East 801st and 803rd are other streets one digit away
    ("50 905th St", "11298"),      # no direction given; North and South both have a #50 in this ZIP
    ("123 Example St", "11297"),   # no letter given; 123A and 123B are different houses
    ("12-34 901st St", "11396"),   # Queens: 12-34 902nd St is another street one digit away
])
def test_matcher_never_guesses_between_addresses(addr, zip_):
    ix = AddressIndex(_pluto(), pd.DataFrame({"bbl": [], "address": []}))
    assert ix.match(addr, "Brooklyn", zip_)[0] is None


def test_matcher_still_takes_unambiguous_variants():
    ix = AddressIndex(_pluto(), pd.DataFrame({"bbl": [], "address": []}))
    assert ix.match("123C Example St", "Brooklyn", "11297")[0] is None              # two lettered houses: still ambiguous
    one = AddressIndex(_pluto().iloc[[4, 2]], pd.DataFrame({"bbl": [], "address": []}))
    assert one.match("123 Example St", "Brooklyn", "11297")[0] == "3090040001"       # only 123A exists
    assert one.match("50 905th St", "Brooklyn", "11298")[0] == "3090020001"          # only North exists


def test_cached_lot_keeps_the_addresss_unit_number():
    pl = _pluto()
    ix = AddressIndex(pl, pd.DataFrame({"bbl": [], "address": []}))
    S = pd.DataFrame([{"contactId": "c1", "address": "20 Spare St Apt 4", "city": "Brooklyn", "zip": "11295", "unitCount": 1, "buildingSqft": None, "cachedBbl": None},
                      {"contactId": "c2", "address": "20 Spare St Apt 4", "city": "Brooklyn", "zip": "11295", "unitCount": 1, "buildingSqft": None, "cachedBbl": "3090070001"}])
    assert list(match_targets(S, pl, ix)["reason"]) == ["other_property_type", "other_property_type"]


def test_a_final_roll_not_yet_posted_falls_back_to_the_tentative_roll():
    # FY2027: only the tentative roll (period 1, out ~Jan 15, 2026) is in the file.
    R = pd.DataFrame({"parid": ["3000010001"] * 3, "year": [2026, 2026, 2027], "period": [1, 3, 1], "mv": [900_000.0, 950_000.0, 1_000_000.0]})
    assert roll_for(pd.Timestamp("2026-07-01"), roll_releases_of(R)) == (2027, 1)
    assert roll_for(pd.Timestamp("2026-07-01"), roll_releases([2026, 2027])) == (2027, 3)   # years only: a roll that isn't there
    S = pd.DataFrame({"bbl": ["3000010001"], "date": [pd.Timestamp("2026-07-01")], "price": [500_000.0], "acris_matched": [True]})
    assert price_to_market_value(S, R).iloc[0] == pytest.approx(0.5)


def _facts_src(lotarea, bldgarea, mv):
    class Src:
        pass
    s = Src()
    s.pluto = pd.DataFrame({"bbl": ["3000010001"], "unitsres": [2], "bldgarea": [bldgarea], "zonedist1": ["R6B"], "bldgclass": ["B1"], "yearbuilt": [1910],
                            "lotarea": [lotarea], "numfloors": [3.0], "histdist": [None]}).set_index("bbl")
    s.last_sale = pd.DataFrame(columns=["date", "price"])
    s.mv, s.roll_year = pd.Series({"3000010001": mv}), 2027
    s.open_dob = s.open_ecb = s.open_hpd = pd.Series(dtype=int)
    return s


def test_facts_stay_inside_dealflows_limits():
    f = facts_for(_facts_src(2.0e7, 1.2e7, 2.0e9), "3000010001", {"count": 0, "major": False}, 0.4, 2, 2.5e7)
    assert f["lotSqft"] is None and f["buildingSqft"] is None and f["dofMarketValue"] is None and f["leadVsCity"]["buildingSqft"] is None
    contract.validate_facts(f)
    ok = facts_for(_facts_src(2000, 2000, 1.0e6), "3000010001", {"count": 0, "major": False}, 0.4, 2, 2400)
    contract.validate_facts(ok)
    for k, bad in (("lotSqft", 2.0e7), ("buildingSqft", 0), ("dofMarketValue", {"value": 2.0e9, "fiscalYear": 2027}), ("units", 2.5), ("floors", 300)):
        with pytest.raises(contract.Invalid):
            contract.validate_facts(dict(ok, **{k: bad}))
    with pytest.raises(contract.Invalid):
        contract.validate_facts(dict(ok, leadVsCity={"units": None, "buildingSqft": {"lead": 2.5e7, "city": 2000}}))
