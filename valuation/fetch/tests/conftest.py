"""Shared test helpers.

Engineering precaution: these tests never reach the internet. The socket
layer is blocked, and every answer comes from FakeServer: tiny recorded
responses in the shape NYC Open Data, data.ny.gov and www.nyc.gov return,
with made-up values.
"""
from __future__ import annotations

import datetime as dt
import json
import socket
from dataclasses import dataclass, replace
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest
import requests
from requests.structures import CaseInsensitiveDict

from valuation.fetch import allowlist, cli

OLE2 = bytes.fromhex("d0cf11e0a1b11ae1")  # how every .xls file starts
TODAY = dt.date(2026, 10, 17)  # newest roll year 2027, as in the brief's example


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def blocked(*args, **kwargs):
        raise RuntimeError("network access is blocked in the valuation.fetch tests")

    monkeypatch.setattr(socket.socket, "connect", blocked)
    monkeypatch.setattr(socket, "create_connection", blocked)


def response(status=200, body=b"", headers=None):
    resp = requests.Response()
    resp.status_code = status
    resp._content = body if isinstance(body, bytes) else json.dumps(body).encode()
    resp.headers = CaseInsensitiveDict(headers or {"Content-Type": "application/json;charset=utf-8"})
    resp.encoding = "utf-8"
    return resp


def tiny_rows(dataset_id, n):
    """n made-up rows; odd rows leave out the last column, as Socrata does for empty values."""
    columns = allowlist.DATASETS[dataset_id].columns
    rows = []
    for i in range(n):
        row = {c: f"{c}-{i}" for c in columns}
        if i % 2:
            del row[columns[-1]]
        rows.append(row)
    return rows


def excel_files():
    return {f.path: OLE2 + f"made-up sheet {f.name}".encode() for f in allowlist.DOF_FILES}


@dataclass
class Call:
    url: str
    params: dict
    auth: object
    timeout: object
    allow_redirects: bool
    headers: dict


class FakeSession:
    """Stands in for requests.Session and records every call."""

    def __init__(self, handler):
        self.handler = handler
        self.headers = CaseInsensitiveDict()
        self.calls: list[Call] = []

    def get(self, url, params=None, auth=None, timeout=None, allow_redirects=True):
        call = Call(url, dict(params or {}), auth, timeout, allow_redirects, dict(self.headers))
        self.calls.append(call)
        return self.handler(call)


class FakeServer:
    """Recorded tiny responses for the allow-listed addresses."""

    def __init__(self):
        self.rows: dict[str, list[dict]] = {}  # dataset id -> rows its /resource/ address serves
        self.files: dict[str, bytes] = {}  # DOF path -> file body
        self.updated_at: dict[str, list[int]] = {}  # dataset id -> rowsUpdatedAt for successive metadata reads
        self.columns: dict[str, list[dict]] = {}  # dataset id -> metadata columns, when not the default
        self.hooks = []  # functions(call) -> response or None, tried first

    def __call__(self, call):
        for hook in self.hooks:
            resp = hook(call)
            if resp is not None:
                return resp
        parts = urlsplit(call.url)
        if parts.hostname == allowlist.NYC_GOV:
            body = self.files.get(parts.path)
            if body is None:
                return response(404, b"<html>Not Found</html>", {"Content-Type": "text/html"})
            return response(200, body, {"Content-Type": "application/vnd.ms-excel"})
        ds = allowlist.DATASETS[parts.path.rsplit("/", 1)[1].removesuffix(".json")]
        if parts.path == ds.metadata_path:
            stamps = self.updated_at.get(ds.id)
            return response(200, {
                "id": ds.id,
                "name": ds.title,
                "rowsUpdatedAt": stamps.pop(0) if stamps else 1_790_000_000,
                "columns": self.columns.get(ds.id) or [{"fieldName": c, "dataTypeName": "text"} for c in ds.columns],
            })
        offset, limit = int(call.params["$offset"]), int(call.params["$limit"])
        return response(200, self.rows.get(ds.id, [])[offset:offset + limit])


@pytest.fixture
def server():
    return FakeServer()


@pytest.fixture
def session(server):
    return FakeSession(server)


@pytest.fixture
def helpers():
    return SimpleNamespace(response=response, tiny_rows=tiny_rows, excel_files=excel_files, OLE2=OLE2,
                           FakeSession=FakeSession, today=TODAY)


@pytest.fixture
def no_floors(monkeypatch):
    """The row-count floors are for the real datasets; tiny test data sits below them."""
    for ds in list(allowlist.DATASETS.values()):
        monkeypatch.setitem(allowlist.DATASETS, ds.id, replace(ds, min_rows=0))


@pytest.fixture
def run_cli(session):
    def run(out, *args, environ=None, today=TODAY):
        return cli.main(["--out", str(out), *args], session=session, environ=environ or {}, today=today)

    return run


@pytest.fixture
def log_lines():
    lines = []
    return lines


@pytest.fixture
def log(log_lines):
    return log_lines.append
