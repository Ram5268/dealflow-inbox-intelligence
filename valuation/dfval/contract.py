"""The job's side of DealFlow's import contract (lib/valuations/contract.ts; ~/dev/brief44-valuation/CONTRACT.md).

DealFlow validates every request strictly. The job checks its payload the same way before sending
anything, so a mistake stops the run here instead of half-way through an upload. The run's metric
blobs may hold numbers, booleans and null only, never text (engineering precaution: they must
never be able to carry a person).
"""
from __future__ import annotations

import datetime as dt
import json
import math
import re

GATE_KEYS = ("typical_miss_all", "typical_miss_top8_2to4", "range_coverage", "sellers_valued")
COUNT_KEYS = ("targets", "valued", "five_plus_units", "condo_without_unit", "not_found", "other_property_type", "trainingSales", "gateSales")
REASONS = ("five_plus_units", "condo_without_unit", "not_found", "other_property_type")
FACT_KEYS = ("units", "buildingSqft", "lotSqft", "yearBuilt", "floors", "zoning", "buildingClass", "historicDistrict", "lastSale",
             "dofMarketValue", "permits7y", "openViolations", "subwayMiles", "leadVsCity")
COMP_KEYS = ("address", "date", "price", "pricePerSqft", "distanceMiles")
ROW_KEYS = ("contactId", "bbl", "value", "low", "high", "reason", "facts", "comps")
RUN_KEYS = ("runId", "runAt", "asOf", "dataThrough", "modelVersion", "gates", "metrics", "scoreboard", "sources", "counts", "expectedRows")

RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{7,63}$")
MODEL_VERSION = re.compile(r"^[a-z0-9][a-z0-9._-]{0,39}$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
TREE_KEY = re.compile(r"^[a-z0-9][a-z0-9_]{0,47}$")
DATASET_ID = re.compile(r"^[a-z0-9]{4}-[a-z0-9]{4}$|^dof_annual$")
CONTACT = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
BBL = re.compile(r"^[1-5]\d{9}$")
COMP_ADDRESS = re.compile(r"^[0-9]+(-[0-9]+)?[A-Z]? [A-Za-z0-9 #&'().,/-]{2,72}$")
PLUTO_VERSION = re.compile(r"^[0-9]{2}v[0-9](\.[0-9])?$")
ZONING = re.compile(r"^[A-Z0-9/.-]{1,16}$")
BLDG_CLASS = re.compile(r"^[A-Z][0-9A-Z]$")


class Invalid(ValueError):
    pass


def _need(ok: bool, msg: str):
    if not ok:
        raise Invalid(msg)


def _money(v, what):
    _need(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and 0 < v <= 1e9, f"{what}: dollars")


LONG_NUMBER_KEY = re.compile(r"[0-9]{7,}")  # a tax lot or a phone number as a key would make a per-home list
TREE_MAX_KEYS = 64
TREE_MAX_BYTES = 64_000


def number_tree(v, path="", depth=0):
    """Numbers, booleans, null, arrays of these, or nested objects with code-like keys. No strings.
    At most 64 keys per object, no key that is a long number, at most 64,000 bytes in all."""
    if depth == 0:
        _need(len(json.dumps(v, separators=(",", ":"))) <= TREE_MAX_BYTES, f"{path}: larger than {TREE_MAX_BYTES} bytes")
    _need(depth <= 6, f"{path}: nested deeper than 6")
    if v is None or isinstance(v, bool):
        return
    if isinstance(v, (int, float)):
        _need(math.isfinite(v), f"{path}: not a finite number")
        return
    if isinstance(v, list):  # lists hold numbers, booleans or null only (lib/valuations/contract.ts)
        _need(len(v) <= 64, f"{path}: more than 64 items")
        _need(depth + 1 <= 6, f"{path}: nested deeper than 6")
        for i, x in enumerate(v):
            _need(x is None or isinstance(x, (bool, int, float)), f"{path}[{i}]: lists hold numbers, booleans or null only")
            number_tree(x, f"{path}[{i}]", depth + 1)
        return
    if isinstance(v, dict):
        _need(len(v) <= TREE_MAX_KEYS, f"{path}: more than {TREE_MAX_KEYS} keys")
        for k, x in v.items():
            _need(isinstance(k, str) and bool(TREE_KEY.fullmatch(k)), f"{path}: key {k!r} is not code-like")
            _need(not LONG_NUMBER_KEY.fullmatch(k), f"{path}: a key is a long number")
            number_tree(x, f"{path}.{k}", depth + 1)
        return
    raise Invalid(f"{path}: {type(v).__name__} is not allowed (numbers, booleans and null only)")


def _day(v, what) -> dt.date:
    _need(isinstance(v, str) and bool(DATE.fullmatch(v)), f"{what}: a date")
    try:
        return dt.date.fromisoformat(v)
    except ValueError:
        raise Invalid(f"{what}: not a calendar date") from None


def validate_run(run: dict, now: dt.datetime | None = None) -> None:
    now = now or dt.datetime.now(dt.timezone.utc)
    _need(set(run) == set(RUN_KEYS), f"run keys {sorted(set(run) ^ set(RUN_KEYS))}")
    _need(bool(RUN_ID.fullmatch(run["runId"])), "runId")
    _need(bool(MODEL_VERSION.fullmatch(run["modelVersion"])), "modelVersion")
    try:
        run_at = dt.datetime.fromisoformat(run["runAt"])
    except (TypeError, ValueError):
        raise Invalid("runAt: an ISO date-time") from None
    _need(run_at.tzinfo is not None, "runAt: needs a UTC offset")
    _need(now - dt.timedelta(days=7) <= run_at <= now + dt.timedelta(minutes=10), "runAt: within the last 7 days")
    as_of, through = _day(run["asOf"], "asOf"), _day(run["dataThrough"], "dataThrough")
    _need(dt.date(2026, 1, 1) <= as_of <= (now + dt.timedelta(days=1)).date(), "asOf: 2026-01-01 to tomorrow")
    _need(through <= as_of and (as_of - through).days <= 62, "dataThrough: on or before asOf, at most 62 days before")
    g = run["gates"]
    _need(set(g) == {"passed", "checks"} and isinstance(g["passed"], bool), "gates")
    _need(sorted(c["key"] for c in g["checks"]) == sorted(GATE_KEYS), "gate keys")
    for c in g["checks"]:
        _need(set(c) == {"key", "value", "pass"} and isinstance(c["pass"], bool) and isinstance(c["value"], (int, float))
              and not isinstance(c["value"], bool) and math.isfinite(c["value"]), "gate check")
    number_tree(run["metrics"], "metrics")
    if run["scoreboard"] is not None:
        number_tree(run["scoreboard"], "scoreboard")
    s = run["sources"]
    if s is not None:
        _need(set(s) == {"downloadedOn", "salesThrough", "plutoVersion", "rollFiscalYear", "datasets"}, "sources keys")
        _day(s["downloadedOn"], "sources.downloadedOn"), _day(s["salesThrough"], "sources.salesThrough")
        _need(s["plutoVersion"] is None or bool(PLUTO_VERSION.fullmatch(s["plutoVersion"])), "plutoVersion")
        _need(s["rollFiscalYear"] is None or (isinstance(s["rollFiscalYear"], int) and 2020 <= s["rollFiscalYear"] <= 2100), "rollFiscalYear")
        _need(len(s["datasets"]) <= 30, "too many datasets")
        for k, d in s["datasets"].items():
            _need(bool(DATASET_ID.fullmatch(k)) and set(d) == {"updatedOn", "rows"}, f"dataset {k}")
            d["updatedOn"] is None or _day(d["updatedOn"], f"dataset {k} date")
            _need(isinstance(d["rows"], int) and d["rows"] >= 0, f"dataset {k} rows")
    _need(set(run["counts"]) == set(COUNT_KEYS) and all(isinstance(run["counts"][k], int) and run["counts"][k] >= 0 for k in COUNT_KEYS), "counts")
    _need(isinstance(run["expectedRows"], int) and 1 <= run["expectedRows"] <= 20_000, "expectedRows")


def _isnum(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _int0(v, what):
    _need(isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 1_000_000, f"{what}: whole number")


def _area(v, what):
    _need(_isnum(v) and 0 < v <= 10_000_000, f"{what}: area")


def validate_facts(f: dict) -> None:
    """lib/valuations/contract.ts FactsSchema, field by field."""
    _need(set(f) == set(FACT_KEYS), f"fact keys {sorted(set(f) ^ set(FACT_KEYS))}")
    f["units"] is None or _int0(f["units"], "units")
    f["buildingSqft"] is None or _area(f["buildingSqft"], "buildingSqft")
    f["lotSqft"] is None or _area(f["lotSqft"], "lotSqft")
    _need(f["yearBuilt"] is None or (isinstance(f["yearBuilt"], int) and not isinstance(f["yearBuilt"], bool) and 1700 <= f["yearBuilt"] <= 2100), "yearBuilt")
    _need(f["floors"] is None or (_isnum(f["floors"]) and 0 <= f["floors"] <= 200), "floors")
    _need(f["zoning"] is None or (isinstance(f["zoning"], str) and bool(ZONING.fullmatch(f["zoning"]))), "zoning")
    _need(f["buildingClass"] is None or (isinstance(f["buildingClass"], str) and bool(BLDG_CLASS.fullmatch(f["buildingClass"]))), "buildingClass")
    _need(f["historicDistrict"] is None or isinstance(f["historicDistrict"], bool), "historicDistrict")
    if f["lastSale"] is not None:
        _need(set(f["lastSale"]) == {"date", "price"}, "lastSale")
        _day(f["lastSale"]["date"], "lastSale.date")
        _money(f["lastSale"]["price"], "lastSale.price")
    if f["dofMarketValue"] is not None:
        d = f["dofMarketValue"]
        _need(set(d) == {"value", "fiscalYear"} and isinstance(d["fiscalYear"], int) and 2000 <= d["fiscalYear"] <= 2100, "dofMarketValue")
        _money(d["value"], "dofMarketValue.value")
    _need(set(f["permits7y"]) == {"count", "major"} and isinstance(f["permits7y"]["major"], bool), "permits7y")
    _int0(f["permits7y"]["count"], "permits7y.count")
    _need(set(f["openViolations"]) == {"dob", "ecb", "hpd"}, "openViolations")
    for k in ("dob", "ecb", "hpd"):
        _int0(f["openViolations"][k], f"openViolations.{k}")
    _need(f["subwayMiles"] is None or (_isnum(f["subwayMiles"]) and 0 <= f["subwayMiles"] <= 25), "subwayMiles")
    lv = f["leadVsCity"]
    _need(set(lv) == {"units", "buildingSqft"}, "leadVsCity")
    if lv["units"] is not None:
        _need(set(lv["units"]) == {"lead", "city"}, "leadVsCity.units")
        _int0(lv["units"]["lead"], "leadVsCity.units.lead"), _int0(lv["units"]["city"], "leadVsCity.units.city")
    if lv["buildingSqft"] is not None:
        _need(set(lv["buildingSqft"]) == {"lead", "city"}, "leadVsCity.buildingSqft")
        _area(lv["buildingSqft"]["lead"], "leadVsCity.buildingSqft.lead"), _area(lv["buildingSqft"]["city"], "leadVsCity.buildingSqft.city")


def validate_row(r: dict, as_of: str) -> None:
    _need(set(r) == set(ROW_KEYS), f"row keys {sorted(set(r) ^ set(ROW_KEYS))}")
    _need(bool(CONTACT.fullmatch(r["contactId"])), "contactId")
    _need(r["bbl"] is None or bool(BBL.fullmatch(r["bbl"])), "bbl")
    if r["value"] is not None:
        for k in ("value", "low", "high"):
            _money(r[k], k)
        _need(r["low"] <= r["value"] <= r["high"] and r["low"] >= 0.5 * r["value"] and r["high"] <= 2 * r["value"], "range")
        _need(r["reason"] is None and r["bbl"] is not None and r["facts"] is not None, "a valued home has a tax lot and facts, no reason")
    else:
        _need(r["low"] is None and r["high"] is None and r["reason"] in REASONS and not r["comps"], "no value: a reason, no range or comps")
        _need((r["reason"] == "not_found") == (r["bbl"] is None), "only not_found has no tax lot")
        _need(r["reason"] != "not_found" or r["facts"] is None, "not_found has no facts")
    if r["facts"] is not None:
        f = r["facts"]
        validate_facts(f)
        if f["lastSale"] is not None:
            _need(set(f["lastSale"]) == {"date", "price"} and f["lastSale"]["date"] < as_of, "lastSale before asOf")
            _money(f["lastSale"]["price"], "lastSale.price")
        _need(set(f["permits7y"]) == {"count", "major"} and set(f["openViolations"]) == {"dob", "ecb", "hpd"}, "permits/violations")
        _need(set(f["leadVsCity"]) == {"units", "buildingSqft"}, "leadVsCity")
    _need(isinstance(r["comps"], list) and len(r["comps"]) <= 8, "comps")
    for c in r["comps"]:
        _need(set(c) == set(COMP_KEYS) and isinstance(c["address"], str) and bool(COMP_ADDRESS.fullmatch(c["address"])), "comp")
        _need(_day(c["date"], "comp.date") < _day(as_of, "asOf"), "comp dated before asOf")
        _money(c["price"], "comp price")
        _need(0 < c["pricePerSqft"] <= 50_000 and 0 <= c["distanceMiles"] <= 1.5, "comp numbers")
