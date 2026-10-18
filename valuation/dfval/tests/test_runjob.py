"""End to end on the invented data folder: a dry run values sellers, builds a payload DealFlow
would accept, never posts, and publishing follows start -> rows -> publish."""
import json
import os

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


def _payload(n=450):
    run = {"runId": "run-test-0001", "expectedRows": n, "gates": {"passed": True, "checks": []}}
    rows = [{"contactId": f"c{i}"} for i in range(n)]
    return run, rows


def test_publish_sends_start_rows_publish():
    fake = FakeDealFlow()
    run, rows = _payload()
    assert runjob.publish(fake, run, rows, True, log=lambda m: None)
    kinds = [c["action"] for c in fake.calls]
    assert kinds == ["start", "rows", "rows", "rows", "publish"]
    assert [len(c["rows"]) for c in fake.calls if c["action"] == "rows"] == [config.BATCH_SIZE, config.BATCH_SIZE, 50]


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
    assert [s["run"]["expectedRows"] for s in starts] == [450, 449, 448]  # c5 and c250 sit in different batches
    sent = [r["contactId"] for c in fake.calls if c["action"] == "rows" for r in c["rows"]]
    assert "c5" not in sent and "c250" not in sent and len(sent) == 448
    assert fake.calls[-1]["action"] == "publish"


def test_other_refusals_stop_the_run():
    class Broken(FakeDealFlow):
        def post(self, payload):
            if payload["action"] == "rows":
                raise Refused(400, {"error": "invalid_payload"})
            return super().post(payload)
    fake = Broken()
    run, rows = _payload(10)
    with pytest.raises(Refused):
        runjob.publish(fake, run, rows, True, log=lambda m: None)
    assert "publish" not in [c["action"] for c in fake.calls]
