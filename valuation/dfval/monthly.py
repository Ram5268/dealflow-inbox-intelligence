"""The monthly workflow's decisions and its summary (Brief 49 PR 2, .github/workflows/valuation-monthly.yml).

- **Publish or dry run.** The schedule publishes; a run started by hand is a dry run unless its
  `publish` box is ticked; anything else never publishes (engineering precaution).
- **The backup run on the 23rd** does nothing when this month's values are already published:
  DealFlow's public status page shows a published run "as of" the 1st of this month or later
  (Brief 44 revision 4; Brief 49 §3). So a 23rd run only re-runs a month whose 20th failed, or
  whose 20th still had last month's sales (the city posted them late).
- **The summary** printed at the end holds counts and gate results only (Brief 49 §3). The
  run's summary.json, which the workflow keeps for 90 days, also holds accuracy numbers and one
  median rounded to $10,000 (Brief 44 revision 2): no value of any one home.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import shutil

import requests

from . import config

BACKUP_DAY = 23  # the cron runs on the 20th and the 23rd at 10:00 UTC
MAIN_REF = "refs/heads/main"  # a hand-started publish run uses main's reviewed code only (engineering precaution)
STATUS_PATH = "/api/valuations/status"  # public: counts, dates and gate results only


def should_publish(event: str, publish_input: str | None, ref: str = MAIN_REF) -> bool:
    """The schedule publishes (when every gate passes); a hand-started run only when asked, and
    only from main. Asking to publish from another branch stops the run (red) instead of
    quietly turning it into a dry run."""
    if event == "schedule":
        return True
    if event == "workflow_dispatch":
        asked = (publish_input or "").strip().lower() == "true"
        if asked and ref != MAIN_REF:
            raise RuntimeError("a publish run can only be started from main; nothing was downloaded or published")
        return asked
    return False


def is_backup_run(event: str, today: dt.date) -> bool:
    return event == "schedule" and today.day == BACKUP_DAY


def month_already_published(status: dict, today: dt.date) -> bool:
    """True when the newest published run is "as of" the 1st of this month or later."""
    lp = status.get("latestPublished") if isinstance(status, dict) else None
    if not isinstance(lp, dict) or lp.get("published") is not True or not isinstance(lp.get("asOf"), str):
        return False
    try:
        as_of = dt.date.fromisoformat(lp["asOf"][:10])
    except ValueError:
        return False
    return as_of >= today.replace(day=1)


def fetch_status(base_url: str = config.DEALFLOW_URL, http=requests) -> dict:
    """DealFlow's public status page (no key). A fresh connection, like api.py. A failure raises,
    so the workflow stops red instead of guessing (engineering precaution)."""
    r = http.get(f"{base_url.rstrip('/')}{STATUS_PATH}", headers={"User-Agent": config.USER_AGENT}, timeout=config.REQUEST_TIMEOUT_S)
    r.raise_for_status()
    body = r.json()
    if not isinstance(body, dict) or body.get("ok") is not True:
        raise RuntimeError("DealFlow's status page didn't answer ok")
    return body


def plan(event: str, publish_input: str | None, today: dt.date, status_reader=None, log=print, ref: str = MAIN_REF) -> dict[str, str]:
    """The workflow's outputs: publish=true|false and skip=true|false. Only the backup run reads the status page."""
    publish = should_publish(event, publish_input, ref)
    skip = False
    if is_backup_run(event, today):
        if month_already_published((status_reader or fetch_status)(), today):
            skip = True
            log(f"backup run: values as of {today.replace(day=1).isoformat()} or later are already published, so this run does nothing")
        else:
            log("backup run: this month's values aren't published yet, so this run tries again")
    log("plan: " + ("nothing to do" if skip else ("publish run (publishes only if every gate passes)" if publish else "dry run (nothing is sent to DealFlow)")))
    return {"publish": "true" if publish else "false", "skip": "true" if skip else "false"}


def summary_lines(s: dict, extra: dict | None = None) -> list[str]:
    """Counts and gate results only: never a value, an address, a tax lot or a contact."""
    c = s.get("counts") or {}
    n = lambda k: f"{int(c.get(k) or 0):,}"  # noqa: E731
    g = s.get("gates") or {}
    lines = [
        f"Valuation run {s.get('runId', '?')}: {'dry run, nothing sent' if s.get('dryRun') else 'publish run'}; "
        f"values as of {s.get('asOf')}, sales through {s.get('dataThrough')}",
        f"Gates: {'PASS' if g.get('passed') else 'FAIL'}",
    ]
    for ch in g.get("checks") or []:
        lim = config.GATES.get(ch.get("key"), {})
        bounds = ", ".join(f"{k} {v}" for k, v in lim.items())
        lines.append(f"  {ch.get('key')}: {ch.get('value')} ({bounds}) {'pass' if ch.get('pass') else 'FAIL'}")
    lines += [
        f"Sellers: {n('targets')} to value; {n('valued')} valued; {n('five_plus_units')} 5+ unit buildings; "
        f"{n('condo_without_unit')} condos without a unit number; {n('not_found')} not found; {n('other_property_type')} other property types",
        f"Sales: {n('trainingSales')} used for training; {n('gateSales')} in the 3 gate months",
        f"Published: {'yes' if s.get('published') else 'no'}",
    ]
    secs = (s.get("metrics") or {}).get("seconds")
    if secs is not None:
        lines.append(f"Valuation step: {int(secs):,} seconds")
    for k, v in (extra or {}).items():
        lines.append(f"{k}: {v}")
    return lines


def disk_notes(data_dir: str | None) -> dict:
    """The download's time and requests, the downloaded folder's size and the disk space left,
    for the run's record (Brief 49 §3)."""
    if not data_dir or not os.path.isdir(data_dir):
        return {}
    notes = {}
    try:
        with open(os.path.join(data_dir, "manifest.json")) as fh:
            run = json.load(fh).get("run") or {}
        if run.get("seconds") is not None:
            notes["Download"] = (f"{float(run['seconds']) / 60:,.0f} minutes, {int(run.get('requests') or 0):,} requests, "
                                 f"{'with' if run.get('authenticated') else 'without'} the NYC Open Data key pair, status {run.get('status')}")
    except (OSError, ValueError, TypeError):
        pass
    size = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(data_dir) for f in fs)
    notes["Downloaded files"] = f"{size / 1e6:,.0f} MB"
    notes["Disk space left"] = f"{shutil.disk_usage(data_dir).free / 1e9:,.1f} GB"
    return notes


def timing_notes(path: str | None) -> dict:
    """The valuation step's elapsed time and peak memory, from GNU time's -v report (when the runner has it)."""
    if not path or not os.path.exists(path):
        return {}
    notes = {}
    with open(path) as fh:
        for line in fh:
            k, _, v = line.strip().partition(": ")
            if k.startswith("Elapsed (wall clock) time"):
                notes["Valuation step, wall clock"] = v
            elif k == "Maximum resident set size (kbytes)" and v.isdigit():
                notes["Valuation step, peak memory"] = f"{int(v) / 1e6:,.1f} GB"
    return notes


def summarize(out_dir: str, publish: bool, extra: dict | None = None, log=print) -> int:
    """Print the summary; exit code 0 only when the gates passed (and, on a publish run, the run published)."""
    path = os.path.join(out_dir, "summary.json")
    if not os.path.exists(path):
        log("no summary.json: the run stopped before the valuation step finished, so nothing was published")
        for k, v in (extra or {}).items():  # the download, disk and GNU time numbers matter most on a failed run
            log(f"{k}: {v}")
        return 1
    with open(path) as fh:
        s = json.load(fh)
    for line in summary_lines(s, extra):
        log(line)
    ok = bool((s.get("gates") or {}).get("passed")) and (bool(s.get("published")) or not publish)
    return 0 if ok else 1
