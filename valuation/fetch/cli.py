"""python -m valuation.fetch --out <folder>

Downloads every source in the allow-list, one request at a time, in run order:
Brief 44.1 section 2 order, except HPD (#15) last (Revision 1, 2026-10-18). The manifest is rewritten after each file, so it always
describes what is on disk. A failure stops the run (exit code 1) and is
recorded in the manifest; a refusal (exit code 2) happens before any request.
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import sys
import time
from pathlib import Path

import requests

from . import manifest
from .allowlist import (
    DATASETS, DOF_FILES, DOF_ONLY, NotAllowed, check_newest_roll_year, default_newest_roll_year, where_for,
)
from .client import Client, FetchError
from .socrata import download_dataset
from .static_files import download_static_files

# Every file the manifest may describe, in run order.
_ORDER = [f.out_path for f in DOF_FILES] + [d.out_path for d in DATASETS.values()]


def log(message: str) -> None:
    print(f"[valuation.fetch] {message}", file=sys.stderr, flush=True)


def parse_args(argv):
    parser = argparse.ArgumentParser(
        prog="python -m valuation.fetch",
        description="Download NYC's public sales and property data for Brooklyn and Queens (Brief 44.1).",
    )
    parser.add_argument("--out", required=True, help="folder to write raw/ and manifest.json into")
    parser.add_argument("--newest-roll-year", type=int,
                        help="newest assessment roll year for #7; it takes this year and the three before it "
                             "(default: next calendar year)")
    parser.add_argument("--only", nargs="+", metavar="ID",
                        help=f"download only these dataset ids, or '{DOF_ONLY}' for the 26 DOF files")
    return parser.parse_args(argv)


def main(argv=None, *, session=None, environ=None, today: dt.date | None = None) -> int:
    args = parse_args(argv)
    environ = os.environ if environ is None else environ
    today = today or dt.datetime.now(dt.timezone.utc).date()
    newest = args.newest_roll_year if args.newest_roll_year is not None else default_newest_roll_year(today)
    try:
        check_newest_roll_year(newest, today)
        want_dof, datasets = _selection(args.only)
    except NotAllowed as exc:
        log(f"refused before any request: {exc}")
        return 2

    key_id = environ.get("NYC_SOCRATA_KEY_ID") or None
    key_secret = environ.get("NYC_SOCRATA_KEY_SECRET") or None
    if bool(key_id) != bool(key_secret):
        log("only one of NYC_SOCRATA_KEY_ID and NYC_SOCRATA_KEY_SECRET is set; requesting anonymously")
    client = Client(session if session is not None else requests.Session(), newest, key_id, key_secret)

    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    previous = manifest.load(out)
    if not previous and (out / manifest.MANIFEST_NAME).exists():
        log("the old manifest.json couldn't be read; the DOF files will be downloaded again")
    previous_files = previous.get("files") if isinstance(previous.get("files"), dict) else {}
    files = {path: entry for path, entry in previous_files.items() if path in _ORDER}
    run = {
        "started_at": manifest.utc_now(),
        "finished_at": None,
        "status": "running",
        "error": None,
        "only": args.only,
        "newest_roll_year": newest,
        "authenticated": client.authenticated,
    }
    state = {"tool": "valuation.fetch", "format": manifest.FORMAT, "run": run, "files": files}

    def save():
        state["files"] = {path: files[path] for path in _ORDER if path in files}
        manifest.save(out, state)

    log(f"{len(DOF_FILES) if want_dof else 0} DOF files and {len(datasets)} datasets into {out}; "
        f"#7 roll years {newest - 3}-{newest}; NYC Open Data requests "
        + ("use the key pair" if client.authenticated else "are anonymous"))
    save()
    started = time.monotonic()
    try:
        if want_dof:
            for path, entry, downloaded in download_static_files(client, out, previous_files, log=log):
                files[path] = entry
                if downloaded:
                    save()
            save()
        for ds in datasets:
            files[ds.out_path] = download_dataset(client, ds.id, ds.columns, where_for(ds, newest), out, log=log)
            save()
    except (FetchError, NotAllowed) as exc:
        _finish(run, "failed", str(exc), client, started)
        save()
        log(f"stopped: {exc}")
        return 1
    except BaseException as exc:
        _finish(run, "failed", f"unexpected {type(exc).__name__}", client, started)
        save()
        raise
    _finish(run, "complete", None, client, started)
    save()
    _summary(state, run)
    return 0


def _selection(only):
    if not only:
        return True, list(DATASETS.values())
    unknown = [x for x in only if x != DOF_ONLY and x not in DATASETS]
    if unknown:
        raise NotAllowed(f"not on the allow-list (Brief 44.1 section 2): {', '.join(unknown)}")
    return DOF_ONLY in only, [d for d in DATASETS.values() if d.id in only]


def _finish(run: dict, status: str, error: str | None, client: Client, started: float) -> None:
    run.update(
        finished_at=manifest.utc_now(),
        status=status,
        error=error,
        seconds=round(time.monotonic() - started, 1),
        requests=client.requests_sent,
        megabytes_received=round(client.bytes_received / 1e6, 1),
    )


def _summary(state: dict, run: dict) -> None:
    files = state["files"]
    rows = sum(e.get("rows") or 0 for e in files.values())
    size = sum(e.get("bytes") or 0 for e in files.values())
    log(f"done: {len(files)} files, {rows:,} rows, {size / 1e6:,.1f} MB on disk; "
        f"{run['requests']} requests, {run['megabytes_received']:,} MB received, {run['seconds']:,}s")
