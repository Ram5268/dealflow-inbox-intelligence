"""DealFlow's own protected addresses for the valuation job (lib/valuations, Brief 44 PR 1).

- GET  /api/valuations/targets : the CRM sellers to value (property address fields only).
- POST /api/valuations/import  : start / rows / publish, in that order.

The key comes from the VALUATION_IMPORT_SECRET environment variable and is sent only as a bearer
token to DealFlow's own address. It is never printed or logged. No retries: a failed request stops
the run, and DealFlow keeps the last published values (engineering precaution, Brief 44 §5).
"""
from __future__ import annotations

import os

import requests

from . import config


class Refused(RuntimeError):
    """DealFlow refused a step; carries the HTTP status and DealFlow's error code (never the payload)."""

    def __init__(self, status: int, body: dict):
        self.status, self.body = status, body
        super().__init__(f"DealFlow answered {status}: {body.get('error')}")


class DealFlow:
    def __init__(self, base_url: str = config.DEALFLOW_URL, key: str | None = None, session: requests.Session | None = None):
        key = key if key is not None else os.environ.get(config.SECRET_ENV)
        if not key:
            raise RuntimeError(f"{config.SECRET_ENV} is not set")
        self.base = base_url.rstrip("/")
        self.http = session or requests.Session()
        self._headers = {"Authorization": f"Bearer {key}", "User-Agent": config.USER_AGENT, "Content-Type": "application/json"}

    def _check(self, r: requests.Response) -> dict:
        try:
            body = r.json()
        except ValueError:
            body = {"error": "not_json"}
        if r.status_code != 200 or not body.get("ok"):
            raise Refused(r.status_code, {k: body.get(k) for k in ("error", "unknown", "issues", "rows", "expectedRows", "valued", "minimum") if k in body})
        return body

    def targets(self) -> dict:
        return self._check(self.http.get(f"{self.base}/api/valuations/targets", headers=self._headers, timeout=config.REQUEST_TIMEOUT_S))

    def post(self, payload: dict) -> dict:
        return self._check(self.http.post(f"{self.base}/api/valuations/import", json=payload, headers=self._headers, timeout=config.REQUEST_TIMEOUT_S))
