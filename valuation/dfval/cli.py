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
    p = sub.add_parser("plan", help="the monthly workflow: publish or dry run, and the 23rd's skip check (prints name=value lines)")
    p.add_argument("--event", required=True, help="the workflow's trigger (github.event_name)")
    p.add_argument("--publish-input", default="", help="the hand-started run's publish box ('true' or 'false')")
    p.add_argument("--today", help="UTC date, YYYY-MM-DD (tests only; default today)")
    s = sub.add_parser("summary", help="the monthly workflow: print counts and gate results; non-zero unless the gates passed")
    s.add_argument("--out", required=True, help="the run's --out folder (summary.json)")
    s.add_argument("--data", help="the downloaded data folder, to report the download and its size on disk")
    s.add_argument("--timing", help="GNU time -v output of the valuation step, to report its time and peak memory")
    s.add_argument("--publish", default="false", help="'true' on a publish run: then it must also have published")
    a = ap.parse_args(argv)
    if a.cmd == "reproduce":
        from .reproduce import run
        run(a.data, a.flags, a.out, a.research_keys, log=_log)
    elif a.cmd == "run":
        from .runjob import run as job
        summary = job(a.data, a.out, dry_run=not a.publish, log=_log)
        if a.publish and not summary["published"]:
            return 3  # ran, but a gate failed: nothing published
    elif a.cmd == "plan":
        import datetime as dt

        from .monthly import plan
        today = dt.date.fromisoformat(a.today) if a.today else dt.datetime.now(dt.timezone.utc).date()
        for k, v in plan(a.event, a.publish_input, today, log=lambda m: print(m, file=sys.stderr, flush=True)).items():
            print(f"{k}={v}")
    elif a.cmd == "summary":
        from .monthly import disk_notes, summarize, timing_notes
        return summarize(a.out, a.publish.strip().lower() == "true", {**disk_notes(a.data), **timing_notes(a.timing)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
