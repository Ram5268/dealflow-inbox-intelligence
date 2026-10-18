"""The DealFlow client opens a new connection for every request. On 2026-10-18 a connection kept
open from the targets request had gone stale by the time the run published (about 6 minutes
later), and with no retries the first publish request stopped the run."""
import pytest
import requests

from valuation.dfval import api, config

KEY = "k" * 40


class _Ok:
    status_code = 200

    def json(self):
        return {"ok": True}


def test_every_request_has_its_own_connection(monkeypatch):
    calls = []
    monkeypatch.setattr(requests, "get", lambda url, **kw: calls.append(("get", url, kw)) or _Ok())
    monkeypatch.setattr(requests, "post", lambda url, **kw: calls.append(("post", url, kw)) or _Ok())

    def kept_open(*a, **k):
        raise AssertionError("a kept-open session was used")

    monkeypatch.setattr(requests.Session, "request", kept_open)
    c = api.DealFlow(base_url="https://dealflow.invalid/", key=KEY)
    c.targets()
    c.post({"action": "start"})
    c.post({"action": "publish"})
    assert [(m, u) for m, u, _ in calls] == [
        ("get", "https://dealflow.invalid/api/valuations/targets"),
        ("post", "https://dealflow.invalid/api/valuations/import"),
        ("post", "https://dealflow.invalid/api/valuations/import"),
    ]
    for _, _, kw in calls:
        assert kw["headers"]["Authorization"] == f"Bearer {KEY}"
        assert kw["timeout"] == config.REQUEST_TIMEOUT_S


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
