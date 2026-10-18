"""The only place this package sends a request.

Every request is checked against the allow-list first, sent once, and any
answer other than HTTP 200 stops the run.

Where each rule comes from (all engineering precautions):
- One request at a time, in order: there are no threads and no parallel
  requests anywhere in this package.
- No custom retry or back-off code. requests' default adapter doesn't retry
  either, so a failed request raises FetchError naming the dataset and the
  HTTP status. The monthly schedule has a backup run three days later.
- Redirects aren't followed: a moved file is reported, not chased.
- Identify honestly: a plain User-Agent naming the project, and, when
  NYC_SOCRATA_KEY_ID and NYC_SOCRATA_KEY_SECRET are set, that key pair as
  HTTP Basic auth on NYC Open Data only, the way DealFlow's
  lib/enrichment/nyc/socrataClient.ts does. No browser impersonation, proxies
  or rotating addresses.
- The key pair is never printed, logged or written to the manifest.
- The session ignores proxy settings and ~/.netrc from the environment, so
  nothing but the key pair above is ever sent as credentials.
- Every request has a timeout, so a stalled connection fails instead of
  hanging the run.
"""
from __future__ import annotations

from urllib.parse import urlsplit

import requests

from .allowlist import NYC_OPEN_DATA, check_request

USER_AGENT = "dealflow-valuation-fetch (monthly, read-only)"
TIMEOUT = (30, 300)  # seconds to connect, seconds to wait for each read


class FetchError(RuntimeError):
    """A request failed or returned something unexpected; the run stops."""


class Client:
    def __init__(self, session, newest_roll_year: int, key_id: str | None = None, key_secret: str | None = None):
        self._session = session
        self._session.trust_env = False
        self._session.headers["User-Agent"] = USER_AGENT
        self._auth = (key_id, key_secret) if key_id and key_secret else None
        self.newest_roll_year = newest_roll_year
        self.requests_sent = 0
        self.bytes_received = 0

    @property
    def authenticated(self) -> bool:
        return self._auth is not None

    def get(self, url: str, label: str, params: dict[str, str] | None = None) -> requests.Response:
        check_request(url, params, self.newest_roll_year)  # raises NotAllowed before sending
        auth = self._auth if urlsplit(url).hostname == NYC_OPEN_DATA else None
        self.requests_sent += 1
        try:
            resp = self._session.get(url, params=params, auth=auth, timeout=TIMEOUT, allow_redirects=False)
        except requests.RequestException as exc:
            # The reason (e.g. "Remote end closed connection", "Read timed out") helps tell a
            # network drop from a server problem. It never carries the key pair.
            raise FetchError(f"{label}: request failed with no HTTP status "
                             f"({type(exc).__name__}: {str(exc)[:300]})") from exc
        if resp.status_code != 200:
            raise FetchError(f"{label}: HTTP {resp.status_code}{_detail(resp)}")
        self.bytes_received += len(resp.content)
        return resp


def _detail(resp: requests.Response) -> str:
    if 300 <= resp.status_code < 400:
        return f" (moved to {resp.headers.get('Location', 'an unstated address')}; not followed)"
    try:
        message = resp.json().get("message")
    except (ValueError, AttributeError):
        message = None
    return f": {str(message)[:200]}" if message else ""
