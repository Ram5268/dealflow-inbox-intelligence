"""The monthly workflow's decisions and summary (Brief 49 PR 2). No network; invented numbers only."""
import datetime as dt
import json

import pytest
import requests

from valuation.dfval import cli, config, monthly

D = dt.date


def status(as_of: str | None, published: bool = True) -> dict:
    lp = None if as_of is None else {"asOf": as_of, "published": published, "publishedAt": f"{as_of}T12:00:00.000Z"}
    return {"ok": True, "latestRun": lp, "latestPublished": lp}


# ---- publish or dry run --------------------------------------------------------------------
def test_the_schedule_publishes_a_hand_started_run_only_when_asked():
    assert monthly.should_publish("schedule", "") is True
    assert monthly.should_publish("schedule", None) is True
    assert monthly.should_publish("workflow_dispatch", "true") is True
    assert monthly.should_publish("workflow_dispatch", "TRUE ") is True
    for v in ("false", "", None, "yes", "1"):
        assert monthly.should_publish("workflow_dispatch", v) is False
    for ev in ("push", "pull_request", "repository_dispatch", ""):
        assert monthly.should_publish(ev, "true") is False  # anything else never publishes


def test_only_the_scheduled_run_on_the_23rd_is_the_backup_run():
    assert monthly.is_backup_run("schedule", D(2026, 11, 23)) is True
    assert monthly.is_backup_run("schedule", D(2026, 11, 20)) is False
    assert monthly.is_backup_run("workflow_dispatch", D(2026, 11, 23)) is False


# ---- the 23rd's skip check -------------------------------------------------------------------
def test_this_month_counts_as_published_when_the_newest_published_run_is_as_of_the_1st_or_later():
    today = D(2026, 11, 23)
    assert monthly.month_already_published(status("2026-11-01"), today) is True
    assert monthly.month_already_published(status("2026-11-04"), today) is True
    assert monthly.month_already_published(status("2026-10-01"), today) is False  # the 20th failed or had last month's sales
    assert monthly.month_already_published(status(None), today) is False           # nothing published yet
    assert monthly.month_already_published(status("2026-11-01", published=False), today) is False
    assert monthly.month_already_published({"ok": True, "latestPublished": {"asOf": "not a date", "published": True}}, today) is False
    assert monthly.month_already_published({}, today) is False
    assert monthly.month_already_published([], today) is False


def test_plan_on_the_20th_publishes_and_never_reads_the_status_page():
    def no_read():
        raise AssertionError("the 20th must not depend on the status page")
    assert monthly.plan("schedule", "", D(2026, 11, 20), status_reader=no_read, log=lambda m: None) == {"publish": "true", "skip": "false"}


def test_plan_on_the_23rd_does_nothing_when_this_month_is_already_published():
    out = monthly.plan("schedule", "", D(2026, 11, 23), status_reader=lambda: status("2026-11-01"), log=lambda m: None)
    assert out == {"publish": "true", "skip": "true"}


def test_plan_on_the_23rd_tries_again_when_this_month_is_not_published():
    out = monthly.plan("schedule", "", D(2026, 11, 23), status_reader=lambda: status("2026-10-01"), log=lambda m: None)
    assert out == {"publish": "true", "skip": "false"}


def test_plan_on_the_23rd_stops_when_the_status_page_cant_be_read():
    def broken():
        raise requests.ConnectionError("down")
    with pytest.raises(requests.ConnectionError):
        monthly.plan("schedule", "", D(2026, 11, 23), status_reader=broken, log=lambda m: None)


def test_a_hand_started_run_on_the_23rd_is_not_a_backup_run():
    def no_read():
        raise AssertionError("a hand-started run doesn't read the status page")
    assert monthly.plan("workflow_dispatch", "false", D(2026, 11, 23), status_reader=no_read, log=lambda m: None) == {"publish": "false", "skip": "false"}


def test_the_status_page_is_read_without_a_key_on_a_fresh_connection():
    calls = []

    class Http:
        @staticmethod
        def get(url, headers, timeout):
            calls.append((url, headers, timeout))
            r = requests.Response()
            r.status_code, r._content = 200, json.dumps(status("2026-11-01")).encode()
            return r

    assert monthly.fetch_status("https://dealflow.invalid/", http=Http)["latestPublished"]["asOf"] == "2026-11-01"
    (url, headers, timeout), = calls
    assert url == "https://dealflow.invalid/api/valuations/status"
    assert "Authorization" not in headers and headers["User-Agent"] == config.USER_AGENT
    assert timeout == config.REQUEST_TIMEOUT_S


@pytest.mark.parametrize("code,body", [(500, {"ok": False, "error": "unavailable"}), (200, {"ok": False}), (200, ["not", "a", "dict"])])
def test_a_status_page_that_isnt_ok_stops_the_run(code, body):
    class Http:
        @staticmethod
        def get(url, headers, timeout):
            r = requests.Response()
            r.status_code, r._content = code, json.dumps(body).encode()
            return r

    with pytest.raises((requests.HTTPError, RuntimeError)):
        monthly.fetch_status("https://dealflow.invalid", http=Http)


def test_the_plan_command_prints_name_value_lines_for_github(capsys, monkeypatch):
    monkeypatch.setattr(monthly, "fetch_status", lambda: (_ for _ in ()).throw(AssertionError("no read on the 20th")))
    assert cli.main(["plan", "--event", "schedule", "--today", "2026-11-20"]) == 0
    assert capsys.readouterr().out.splitlines() == ["publish=true", "skip=false"]
    assert cli.main(["plan", "--event", "workflow_dispatch", "--publish-input", "false", "--today", "2026-11-23"]) == 0
    assert capsys.readouterr().out.splitlines() == ["publish=false", "skip=false"]


# ---- the summary: counts and gate results only ---------------------------------------------------
SUMMARY = {
    "runId": "run-20261120T100000Z-abc123", "dryRun": True, "asOf": "2026-11-01", "dataThrough": "2026-10-31",
    "gates": {"passed": True, "checks": [{"key": "typical_miss_all", "value": 0.105, "pass": True},
                                         {"key": "typical_miss_top8_2to4", "value": 0.133, "pass": True},
                                         {"key": "range_coverage", "value": 0.68, "pass": True},
                                         {"key": "sellers_valued", "value": 1400.0, "pass": True}]},
    "counts": {"targets": 1500, "valued": 1400, "five_plus_units": 60, "condo_without_unit": 30, "not_found": 10,
               "other_property_type": 0, "trainingSales": 30000, "gateSales": 3000},
    "metrics": {"seconds": 900}, "scoreboard": {"all": {"found": 0.98}}, "medianValueRounded10k": 1_230_000.0, "published": False,
}


def write(tmp_path, s):
    (tmp_path / "summary.json").write_text(json.dumps(s))
    return str(tmp_path)


def test_the_summary_shows_counts_and_gates_but_no_money_amount(tmp_path):
    lines = []
    assert monthly.summarize(write(tmp_path, SUMMARY), publish=False, log=lines.append) == 0
    text = "\n".join(lines)
    assert "Gates: PASS" in text and "1,400 valued" in text and "1,500 to value" in text and "900 seconds" in text
    assert "1230000" not in text.replace(",", "") and "$" not in text  # the median stays in summary.json only


def test_the_summary_step_is_red_when_a_gate_failed_even_on_a_dry_run(tmp_path):
    s = json.loads(json.dumps(SUMMARY))
    s["gates"]["passed"] = False
    s["gates"]["checks"][0].update(value=0.13, **{"pass": False})
    lines = []
    assert monthly.summarize(write(tmp_path, s), publish=False, log=lines.append) == 1
    assert "Gates: FAIL" in lines and any("typical_miss_all" in x and x.endswith("FAIL") for x in lines)


def test_a_publish_run_is_red_unless_it_published(tmp_path):
    out = write(tmp_path, dict(SUMMARY, dryRun=False, published=False))
    assert monthly.summarize(out, publish=True, log=lambda m: None) == 1
    out = write(tmp_path, dict(SUMMARY, dryRun=False, published=True))
    assert monthly.summarize(out, publish=True, log=lambda m: None) == 0


def test_no_summary_means_the_run_stopped_early(tmp_path):
    lines = []
    assert monthly.summarize(str(tmp_path), publish=False, log=lines.append) == 1
    assert "nothing was published" in lines[0]


def test_disk_notes_report_the_download_the_folder_and_free_space(tmp_path):
    (tmp_path / "raw").mkdir()
    (tmp_path / "raw" / "x.parquet").write_bytes(b"0" * 2_000_000)
    notes = monthly.disk_notes(str(tmp_path))
    assert notes["Downloaded files"] == "2 MB" and notes["Disk space left"].endswith("GB") and "Download" not in notes
    (tmp_path / "manifest.json").write_text(json.dumps({"run": {"status": "complete", "seconds": 3708.4, "requests": 489, "authenticated": True}}))
    assert monthly.disk_notes(str(tmp_path))["Download"] == "62 minutes, 489 requests, with the NYC Open Data key pair, status complete"
    assert monthly.disk_notes(None) == {} and monthly.disk_notes(str(tmp_path / "missing")) == {}


def test_timing_notes_read_gnu_time(tmp_path):
    t = tmp_path / "time.txt"
    t.write_text("\tCommand being timed: \"python -m valuation.dfval run\"\n\tElapsed (wall clock) time (h:mm:ss or m:ss): 21:07.33\n"
                 "\tMaximum resident set size (kbytes): 6123456\n")
    assert monthly.timing_notes(str(t)) == {"Valuation step, wall clock": "21:07.33", "Valuation step, peak memory": "6.1 GB"}
    assert monthly.timing_notes(None) == {} and monthly.timing_notes(str(tmp_path / "none.txt")) == {}


def test_the_summary_command(tmp_path, capsys):
    out = write(tmp_path, SUMMARY)
    assert cli.main(["summary", "--out", out, "--publish", "false"]) == 0
    assert "Gates: PASS" in capsys.readouterr().out
    assert cli.main(["summary", "--out", out, "--publish", "true"]) == 1  # a publish run that didn't publish


# ---- review fixes ------------------------------------------------------------------------------------
def test_a_hand_started_publish_run_only_from_main():
    assert monthly.should_publish("workflow_dispatch", "true", "refs/heads/main") is True
    assert monthly.should_publish("workflow_dispatch", "false", "refs/heads/feature") is False  # a dry run from any branch
    with pytest.raises(RuntimeError, match="only be started from main"):
        monthly.should_publish("workflow_dispatch", "true", "refs/heads/feature")
    with pytest.raises(RuntimeError):
        monthly.should_publish("workflow_dispatch", "true", "")  # no branch given: refuse, don't guess


def test_the_plan_command_refuses_a_publish_run_off_main(capsys):
    with pytest.raises(RuntimeError):
        cli.main(["plan", "--event", "workflow_dispatch", "--publish-input", "true", "--ref", "refs/heads/x", "--today", "2026-11-05"])
    assert capsys.readouterr().out == ""  # nothing reaches $GITHUB_OUTPUT
    assert cli.main(["plan", "--event", "workflow_dispatch", "--publish-input", "true", "--ref", "refs/heads/main", "--today", "2026-11-05"]) == 0
    assert capsys.readouterr().out.splitlines() == ["publish=true", "skip=false"]


def test_a_run_that_stopped_early_still_reports_its_download_disk_and_memory(tmp_path):
    lines = []
    assert monthly.summarize(str(tmp_path), publish=True, extra={"Valuation step, peak memory": "7.9 GB"}, log=lines.append) == 1
    assert "nothing was published" in lines[0] and "Valuation step, peak memory: 7.9 GB" in lines
