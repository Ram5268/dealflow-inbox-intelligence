"""The DealFlow client opens a new connection for every request. On 2026-10-18 the first publish
request, sent on a connection kept open from the targets request about 335-345 seconds earlier, got
no answer, and with no retries the run stopped: DealFlow's side closes an idle connection after
about 340 seconds (open at 337 s, closed by 345 s), and the request raced that close."""
import pytest
import requests

from valuation.dfval import api, config
from valuation.dfval.api import Refused

KEY = "k" * 40


def test_every_request_has_its_own_connection(monkeypatch):
    # Transport level (the reviewer's test, 2026-10-18): one HTTPAdapter is one connection pool.
    used, closed, sent = [], [], []

    def send(self, request, **kw):  # stands in for the network
        used.append(self)
        sent.append((request.method, request.url, request.headers.get("Authorization"), kw.get("timeout"), request.body))
        r = requests.Response()
        r.status_code, r._content, r.request = 200, b'{"ok": true}', request
        return r

    monkeypatch.setattr(requests.adapters.HTTPAdapter, "send", send)
    monkeypatch.setattr(requests.adapters.HTTPAdapter, "close", lambda self: closed.append(self))
    c = api.DealFlow(base_url="https://dealflow.invalid/", key=KEY)
    c.targets()
    c.post({"action": "start"})
    c.post({"action": "publish"})
    assert len(used) == 3 and len({id(a) for a in used}) == 3  # `used` keeps them alive, so ids can't repeat
    assert all(any(a is x for x in closed) for a in used)      # each pool was closed after its request
    assert [(m, u) for m, u, *_ in sent] == [
        ("GET", "https://dealflow.invalid/api/valuations/targets"),
        ("POST", "https://dealflow.invalid/api/valuations/import"),
        ("POST", "https://dealflow.invalid/api/valuations/import"),
    ]
    assert all(a == f"Bearer {KEY}" and t == config.REQUEST_TIMEOUT_S for _, _, a, t, _ in sent)
    assert [b for *_, b in sent][1:] == [b'{"action": "start"}', b'{"action": "publish"}']  # sent as JSON


def test_a_passed_session_is_used():
    fake = object()
    assert api.DealFlow(key=KEY, session=fake).http is fake


def test_no_key_refuses(monkeypatch):
    monkeypatch.delenv(config.SECRET_ENV, raising=False)
    with pytest.raises(RuntimeError):
        api.DealFlow()


def test_publish_logs_each_request_and_where_it_stopped():
    from valuation.dfval import runjob

    sent = []

    class DropsThirdRequest:
        def post(self, payload):
            sent.append(payload["action"])
            if len(sent) == 3:
                raise requests.ConnectionError("Remote end closed connection without response")
            return {"ok": True, "gatesPassed": True}

    logs = []
    rows = [{"contactId": f"c{i}"} for i in range(450)]
    with pytest.raises(requests.ConnectionError):
        runjob.publish(DropsThirdRequest(), {"runId": "r1"}, rows, True, logs.append)
    assert sent == ["start", "rows", "rows"]  # no retry after the failure
    assert [line.split(":")[0].strip() for line in logs[:3]] == ["send start", "send rows 1-200", "send rows 201-400"]
    assert len(logs) == 4 and logs[3].strip().startswith("rows 201-400 failed after ") and logs[3].endswith("s: ConnectionError")
    assert all("c1" not in line for line in logs)  # sizes and steps only, never the rows


def test_publish_log_explains_a_recovered_refusal():
    from valuation.dfval import runjob

    first = [True]

    class RefusesOneSellerOnce:
        def post(self, payload):
            if payload["action"] == "rows" and first[0]:
                first[0] = False
                raise Refused(422, {"error": "unknown_contacts", "unknown": ["c1"]})
            return {"ok": True, "gatesPassed": True}

    rows = [{"contactId": f"c{i}", "value": 1.0, "reason": None} for i in range(1400)]
    run = {"runId": "r1", "counts": {}, "gates": {"passed": True, "checks": [{"key": "sellers_valued", "value": 1400.0, "pass": True}]}}
    logs = []
    assert runjob.publish(RefusesOneSellerOnce(), run, rows, True, logs.append)
    i = next(n for n, line in enumerate(logs) if "failed after" in line)
    assert logs[i].strip().startswith("rows 1-200 failed after ") and logs[i].endswith("s: Refused 422")
    assert logs[i + 1].startswith("DealFlow no longer lists 1 seller(s)")
    assert logs[i + 2].strip().startswith("send start again: ")
    assert logs[-1] == "published run r1: 1,399 rows"
