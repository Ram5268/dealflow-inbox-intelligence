"""Command line: `python -m valuation.dfval <command>` (see README.md)."""
from __future__ import annotations

import argparse
import sys
import time


def _log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m valuation.dfval")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("reproduce", help="local only: the two-part reproduction check on the research years")
    r.add_argument("--data", required=True, help="folder written by valuation/fetch")
    r.add_argument("--flags", required=True, help="the research's saved per-deed flags (never committed or uploaded)")
    r.add_argument("--research-keys", help="the research's back-test rows (bbl, date, price), to score its exact test sales too")
    r.add_argument("--out", required=True, help="where to write the report (counts and accuracy only)")
    j = sub.add_parser("run", help="value every CRM seller; a dry run unless --publish")
    j.add_argument("--data", required=True, help="folder written by valuation/fetch")
    j.add_argument("--out", required=True, help="where to write summary.json (counts and accuracy only)")
    mode = j.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="the default: write the summary locally and never POST")
    mode.add_argument("--publish", action="store_true", help="publish through DealFlow's import address when every gate passes")
    a = ap.parse_args(argv)
    if a.cmd == "reproduce":
        from .reproduce import run
        run(a.data, a.flags, a.out, a.research_keys, log=_log)
    elif a.cmd == "run":
        from .runjob import run as job
        summary = job(a.data, a.out, dry_run=not a.publish, log=_log)
        if a.publish and not summary["published"]:
            return 3  # ran, but a gate failed: nothing published
    return 0


if __name__ == "__main__":
    sys.exit(main())
