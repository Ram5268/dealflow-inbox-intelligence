"""The manifest: each file's source, filter, column list, row count, download
time and SHA-256, for a full run over all 18 sources (tiny recorded data)."""
import hashlib
import json

import pandas as pd
import pyarrow.parquet as pq

from valuation.fetch import allowlist

ENTRY_KEYS = {"source", "filter", "columns", "rows", "downloaded_at", "sha256"}


def _fill(server, helpers):
    server.files = helpers.excel_files()
    for i, ds in enumerate(allowlist.DATASETS.values()):
        server.rows[ds.id] = helpers.tiny_rows(ds.id, 2 + i % 3)


def test_full_run_writes_a_complete_manifest(server, session, helpers, run_cli, tmp_path, no_floors):
    _fill(server, helpers)
    assert run_cli(tmp_path) == 0
    manifest = json.loads((tmp_path / "manifest.json").read_text())

    assert manifest["run"]["status"] == "complete"
    assert manifest["run"]["error"] is None
    assert manifest["run"]["newest_roll_year"] == 2027
    assert manifest["run"]["requests"] == len(session.calls)
    expected_paths = [f.out_path for f in allowlist.DOF_FILES] + [d.out_path for d in allowlist.DATASETS.values()]
    assert list(manifest["files"]) == expected_paths  # section 2 order

    for path, entry in manifest["files"].items():
        assert ENTRY_KEYS <= set(entry), path
        assert entry["sha256"] == hashlib.sha256((tmp_path / path).read_bytes()).hexdigest()

    for ds in allowlist.DATASETS.values():
        entry = manifest["files"][ds.out_path]
        assert entry["source"] == ds.resource_url
        assert entry["filter"] == allowlist.where_for(ds, 2027)
        assert entry["columns"] == list(ds.columns)
        assert entry["rows"] == len(server.rows[ds.id]) == pq.read_metadata(tmp_path / ds.out_path).num_rows
        assert entry["dataset"] == f"#{ds.number}"


def test_the_files_open_in_pandas_as_text(server, helpers, run_cli, tmp_path, no_floors):
    _fill(server, helpers)
    run_cli(tmp_path)
    for ds in allowlist.DATASETS.values():
        frame = pd.read_parquet(tmp_path / ds.out_path)
        assert list(frame.columns) == list(ds.columns)
        assert all(pd.api.types.is_string_dtype(t) for t in frame.dtypes)


def test_a_failed_run_is_recorded_and_keeps_what_finished(server, session, helpers, run_cli, tmp_path, no_floors):
    _fill(server, helpers)
    failing = allowlist.DATASETS["ipu4-2q9a"]  # #8
    server.hooks.append(lambda call: helpers.response(503, b"Service Unavailable", {"Content-Type": "text/plain"})
                        if call.url == failing.resource_url else None)
    assert run_cli(tmp_path) == 1
    manifest = json.loads((tmp_path / "manifest.json").read_text())
    assert manifest["run"]["status"] == "failed"
    assert failing.id in manifest["run"]["error"] and "HTTP 503" in manifest["run"]["error"]
    done = [d for d in allowlist.DATASETS.values() if d.number < failing.number]
    assert set(manifest["files"]) == {f.out_path for f in allowlist.DOF_FILES} | {d.out_path for d in done}
    assert not (tmp_path / failing.out_path).exists()
    assert not list((tmp_path / "raw").glob("*.partial"))
    # Nothing after the failure was requested.
    later = {d.resource_url for d in allowlist.DATASETS.values() if d.number > failing.number}
    assert not later & {c.url for c in session.calls}


def test_only_keeps_the_other_entries(server, session, helpers, run_cli, tmp_path, no_floors):
    _fill(server, helpers)
    run_cli(tmp_path)
    before = json.loads((tmp_path / "manifest.json").read_text())["files"]
    server.rows["39hk-dx4f"] = helpers.tiny_rows("39hk-dx4f", 7)
    assert run_cli(tmp_path, "--only", "39hk-dx4f") == 0
    after = json.loads((tmp_path / "manifest.json").read_text())
    assert after["run"]["only"] == ["39hk-dx4f"]
    assert list(after["files"]) == list(before)
    changed = [p for p in before if before[p] != after["files"][p]]
    assert changed == ["raw/39hk-dx4f.parquet"]
