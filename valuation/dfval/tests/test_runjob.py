"""End to end on the invented data folder: a dry run values sellers, builds a payload DealFlow
would accept, never posts, and publishing follows start -> rows -> publish."""
import json
import os

import pandas as pd
import pytest

from valuation.dfval import config, contract
from valuation.dfval import runjob
from valuation.dfval.api import Refused


class FakeDealFlow:
    def __init__(self, gates_ok=True, unknown=()):
        self.calls, self.gates_ok, self.unknown = [], gates_ok, set(unknown)

    def targets(self):
        raise AssertionError("targets are passed in")

    def post(self, payload):
        if payload["action"] == "rows":
            bad = [r["contactId"] for r in payload["rows"] if r["contactId"] in self.unknown]
            if bad:  # DealFlow refuses the whole batch and writes none of it
                raise Refused(422, {"error": "unknown_contacts", "unknown": bad})
        self.calls.append(payload)
        if payload["action"] == "start":
            return {"ok": True, "gatesPassed": self.gates_ok}
        return {"ok": True}


def _targets(world):
    L, _ = world
    fam = L[L["cls"].str.match(r"^(A|B|C0|C3)")].iloc[:30]
    sellers = [{"contactId": f"c{i:03d}", "address": f"{r.number} {r.street.title()}", "city": "Brooklyn" if r.boro == 3 else "Ridgewood",
                "state": "NY", "zip": r.zip, "unitCount": r.units, "buildingSqft": r.sqft, "cachedBbl": None} for i, r in enumerate(fam.itertuples())]
    sellers += [{"contactId": "c900", "address": "10 Spare St", "city": "Brooklyn", "state": "NY", "zip": "11216", "unitCount": 6, "buildingSqft": None, "cachedBbl": None},
                {"contactId": "c901", "address": "20 Spare St", "city": "Brooklyn", "state": "NY", "zip": "11216", "unitCount": 1, "buildingSqft": None, "cachedBbl": None},
                {"contactId": "c902", "address": "30 Spare St", "city": "Brooklyn", "state": "NY", "zip": "11216", "unitCount": None, "buildingSqft": None, "cachedBbl": None},
                {"contactId": "c903", "address": "1 Nowhere Lane", "city": "Brooklyn", "state": "NY", "zip": "11216", "unitCount": None, "buildingSqft": None, "cachedBbl": None}]
    return {"ok": True, "sellers": sellers, "previousPublished": None}


@pytest.fixture(scope="module")
def dry(tmp_path_factory, data_dir, world):
    out = str(tmp_path_factory.mktemp("out"))
    captured = {}
    orig = runjob.publish
    runjob.publish = lambda *a, **k: (_ for _ in ()).throw(AssertionError("a dry run must never publish"))
    try:
        summary = runjob.run(data_dir, out, dry_run=True, targets=_targets(world), log=lambda m: None, keep=captured)
    finally:
        runjob.publish = orig
    return summary, captured, out


def test_dry_run_values_sellers_and_writes_only_a_summary(dry):
    summary, captured, out = dry
    assert os.listdir(out) == ["summary.json"]
    s = json.load(open(os.path.join(out, "summary.json")))
    assert s["published"] is False and s["dryRun"] is True
    c = s["counts"]
    assert c["targets"] == 34 and c["valued"] == 30
    assert (c["five_plus_units"], c["condo_without_unit"], c["other_property_type"], c["not_found"]) == (1, 1, 1, 1)
    # Few sellers in the invented world, so this gate fails (and only a dry run happened).
    assert not s["gates"]["passed"] and [x["key"] for x in s["gates"]["checks"] if not x["pass"]] == ["sellers_valued"]
    # The summary carries counts and accuracy only: no contact ids, addresses or per-home values.
    text = json.dumps(s).upper()
    assert "C001" not in text and "EXAMPLE" not in text and "SPARE" not in text


def test_ranges_come_from_the_range_months_and_gates_from_the_gate_months(dry):
    from valuation.dfval.runjob import size_ranges
    _, captured, _ = dry
    k = captured["ranges"]
    ts = lambda xs: {pd.Timestamp(x) for x in xs}  # noqa: E731
    rng_m, gate_m = ts(k["rng_months"]), ts(k["gate_months"])
    assert not rng_m & gate_m and max(rng_m) < min(gate_m)
    assert ts(k["month"][k["in_rng"]]) <= rng_m and ts(k["month"][k["in_gate"]]) <= gate_m
    r = size_ranges(k["pred"], k["y"], k["top"], k["in_rng"], k["in_gate"])
    rng = captured["run"]["metrics"]["range"]
    assert rng["halfwidth_other"] == round(r["w_other"], 4) and rng["coverage_gate"] == round(r["cover"], 4)
    swapped = size_ranges(k["pred"], k["y"], k["top"], k["in_gate"], k["in_rng"])
    assert round(swapped["w_other"], 4) != rng["halfwidth_other"]  # the test can tell range months from gate months


def test_payload_follows_the_contract(dry):
    _, captured, _ = dry
    run, rows = captured["run"], captured["rows"]
    contract.validate_run(run)
    for r in rows:
        contract.validate_row(r, run["asOf"])
    assert run["expectedRows"] == len(rows) == 34
    valued = [r for r in rows if r["value"] is not None]
    assert all(r["comps"] and r["facts"]["buildingSqft"] for r in valued)
    assert all(c["date"] < run["asOf"] for r in valued for c in r["comps"])
    assert {r["reason"] for r in rows} == {None, "five_plus_units", "condo_without_unit", "other_property_type", "not_found"}
    w = [(r["high"] / r["value"] - 1) for r in valued]
    assert all(0.0 < x < 0.5 for x in w)


def test_contract_refuses_text_in_metric_blobs():
    with pytest.raises(contract.Invalid):
        contract.number_tree({"worst": [{"addr": "123 Example St"}]})
    with pytest.raises(contract.Invalid):
        contract.number_tree({"Owner": 1})
    deep = 1
    for _ in range(8):
        deep = {"a": deep}
    with pytest.raises(contract.Invalid):
        contract.number_tree(deep)
    with pytest.raises(contract.Invalid):
        contract.number_tree({"months": [{"n": 1}]})  # a list of objects
    contract.number_tree({"gate": {"all": {"n": 10, "w10": 0.5}}, "q": [0.1, None, True]})


def _payload(n=1450):
    counts = {"targets": n, "valued": n, "five_plus_units": 0, "condo_without_unit": 0, "not_found": 0, "other_property_type": 0,
              "trainingSales": 10, "gateSales": 10}
    checks = [{"key": "sellers_valued", "value": float(n), "pass": True}]
    run = {"runId": "run-test-0001", "expectedRows": n, "counts": counts, "gates": {"passed": True, "checks": checks}}
    rows = [{"contactId": f"c{i}", "value": 1e6, "reason": None} for i in range(n)]
    return run, rows


def test_publish_sends_start_rows_publish():
    fake = FakeDealFlow()
    run, rows = _payload()
    assert runjob.publish(fake, run, rows, True, log=lambda m: None)
    kinds = [c["action"] for c in fake.calls]
    assert kinds == ["start"] + ["rows"] * 8 + ["publish"]
    assert [len(c["rows"]) for c in fake.calls if c["action"] == "rows"] == [config.BATCH_SIZE] * 7 + [50]


def test_failed_gates_record_the_run_and_publish_nothing():
    for job_ok, server_ok in ((False, True), (True, False)):
        fake = FakeDealFlow(gates_ok=server_ok)
        run, rows = _payload()
        assert not runjob.publish(fake, run, rows, job_ok, log=lambda m: None)
        assert [c["action"] for c in fake.calls] == ["start"]


def test_sellers_dealflow_no_longer_lists_are_dropped_and_the_run_restarted():
    fake = FakeDealFlow(unknown={"c5", "c250"})
    run, rows = _payload()
    assert runjob.publish(fake, run, rows, True, log=lambda m: None)
    starts = [c for c in fake.calls if c["action"] == "start"]
    assert [s["run"]["expectedRows"] for s in starts] == [1450, 1449, 1448]  # c5 and c250 sit in different batches
    assert [s["run"]["counts"]["valued"] for s in starts] == [1450, 1449, 1448]
    sent = [r["contactId"] for c in fake.calls if c["action"] == "rows" for r in c["rows"]]
    assert "c5" not in sent and "c250" not in sent and len(sent) == 1448
    assert fake.calls[-1]["action"] == "publish"
    final = {}
    fake2 = FakeDealFlow(unknown={"c5"})
    run2, rows2 = _payload()
    runjob.publish(fake2, run2, rows2, True, log=lambda m: None, final=final)
    assert final["counts"]["valued"] == 1449  # what the run's summary.json then reports


def test_dropping_refused_sellers_below_the_minimum_publishes_nothing():
    fake = FakeDealFlow(unknown={f"c{i}" for i in range(0, 1450, 9)})  # 162 sellers gone: 1,288 left, under 1,300
    run, rows = _payload()
    assert not runjob.publish(fake, run, rows, True, log=lambda m: None)
    assert "publish" not in [c["action"] for c in fake.calls]


def test_other_refusals_stop_the_run():
    class Broken(FakeDealFlow):
        def post(self, payload):
            if payload["action"] == "rows":
                raise Refused(400, {"error": "invalid_payload"})
            return super().post(payload)
    fake = Broken()
    run, rows = _payload()
    with pytest.raises(Refused):
        runjob.publish(fake, run, rows, True, log=lambda m: None)
    assert "publish" not in [c["action"] for c in fake.calls]
