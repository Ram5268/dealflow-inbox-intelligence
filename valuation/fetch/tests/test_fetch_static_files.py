"""#1: the 26 DOF Excel files are downloaded only if missing or if their
SHA-256 differs from the manifest."""
import hashlib
import json
from urllib.parse import urlsplit

from valuation.fetch import allowlist


def _dof_calls(session):
    return [urlsplit(c.url).path for c in session.calls if urlsplit(c.url).hostname == allowlist.NYC_GOV]


def _run(server, helpers, run_cli, tmp_path):
    server.files = helpers.excel_files()
    return run_cli(tmp_path, "--only", "dof")


def test_first_run_downloads_all_26_with_their_fingerprints(server, session, helpers, run_cli, tmp_path):
    assert _run(server, helpers, run_cli, tmp_path) == 0
    assert _dof_calls(session) == [f.path for f in allowlist.DOF_FILES]
    files = json.loads((tmp_path / "manifest.json").read_text())["files"]
    for f in allowlist.DOF_FILES:
        saved = tmp_path / "raw" / "dof_annual" / f.name
        assert saved.read_bytes() == server.files[f.path]
        entry = files[f"raw/dof_annual/{f.name}"]
        assert entry["sha256"] == hashlib.sha256(saved.read_bytes()).hexdigest()
        assert entry["source"] == f.url
        assert entry["bytes"] == saved.stat().st_size


def test_second_run_skips_all_26(server, session, helpers, run_cli, tmp_path):
    _run(server, helpers, run_cli, tmp_path)
    first = json.loads((tmp_path / "manifest.json").read_text())["files"]
    session.calls.clear()
    assert run_cli(tmp_path, "--only", "dof") == 0
    assert _dof_calls(session) == []
    assert json.loads((tmp_path / "manifest.json").read_text())["files"] == first


def test_a_missing_or_changed_file_is_downloaded_again(server, session, helpers, run_cli, tmp_path):
    _run(server, helpers, run_cli, tmp_path)
    missing, changed = allowlist.DOF_FILES[3], allowlist.DOF_FILES[20]
    (tmp_path / "raw" / "dof_annual" / missing.name).unlink()
    (tmp_path / "raw" / "dof_annual" / changed.name).write_bytes(b"changed on disk")
    session.calls.clear()
    assert run_cli(tmp_path, "--only", "dof") == 0
    assert _dof_calls(session) == [missing.path, changed.path]
    assert (tmp_path / "raw" / "dof_annual" / changed.name).read_bytes() == server.files[changed.path]


def test_a_fingerprint_that_differs_from_the_manifest_is_downloaded_again(server, session, helpers, run_cli,
                                                                          tmp_path):
    _run(server, helpers, run_cli, tmp_path)
    manifest_path = tmp_path / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    target = allowlist.DOF_FILES[0]
    manifest["files"][target.out_path]["sha256"] = "0" * 64
    manifest_path.write_text(json.dumps(manifest))
    session.calls.clear()
    assert run_cli(tmp_path, "--only", "dof") == 0
    assert _dof_calls(session) == [target.path]


def test_no_manifest_means_downloading_again(server, session, helpers, run_cli, tmp_path):
    _run(server, helpers, run_cli, tmp_path)
    (tmp_path / "manifest.json").unlink()
    session.calls.clear()
    assert run_cli(tmp_path, "--only", "dof") == 0
    assert len(_dof_calls(session)) == 26


def test_a_missing_file_on_the_server_stops_the_run(server, session, helpers, run_cli, tmp_path, capsys):
    server.files = helpers.excel_files()
    gone = allowlist.DOF_FILES[5]
    del server.files[gone.path]
    assert run_cli(tmp_path, "--only", "dof") == 1
    assert _dof_calls(session)[-1] == gone.path  # stopped there
    run = json.loads((tmp_path / "manifest.json").read_text())["run"]
    assert run["status"] == "failed"
    assert gone.name in run["error"] and "HTTP 404" in run["error"]
    assert "HTTP 404" in capsys.readouterr().err


def test_an_answer_that_is_not_excel_stops_the_run(server, session, helpers, run_cli, tmp_path):
    server.files = helpers.excel_files()
    server.files[allowlist.DOF_FILES[0].path] = b"<html>Please try again later</html>"
    assert run_cli(tmp_path, "--only", "dof") == 1
    assert len(_dof_calls(session)) == 1
    assert not (tmp_path / "raw" / "dof_annual" / allowlist.DOF_FILES[0].name).exists()
