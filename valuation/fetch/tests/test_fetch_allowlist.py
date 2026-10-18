"""The allow-list refuses, before any request, anything not in Brief 44.1
section 2: another dataset, another column, another filter, another address.
It also sends the key pair only to NYC Open Data, and always the plain
User-Agent."""
import base64
import re
from urllib.parse import urlsplit

import pytest
import requests

from valuation.fetch import allowlist
from valuation.fetch.allowlist import DATASETS, NotAllowed
from valuation.fetch.client import USER_AGENT, Client
from valuation.fetch.socrata import download_dataset

PLUTO = DATASETS["64uk-42ks"]
ROLL = DATASETS["8y4t-faws"]


def _download(session, tmp_path, dataset_id, columns, where):
    return download_dataset(Client(session, 2027), dataset_id, columns, where, tmp_path, log=lambda _: None)


def test_refuses_a_dataset_not_in_section_2(session, tmp_path):
    with pytest.raises(NotAllowed, match="636b-3b5g"):  # ACRIS Real Property Parties
        _download(session, tmp_path, "636b-3b5g", ("document_id",), None)
    assert session.calls == []


def test_refuses_a_column_not_on_the_list(session, tmp_path):
    with pytest.raises(NotAllowed, match="ownername"):
        _download(session, tmp_path, PLUTO.id, PLUTO.columns + ("ownername",), PLUTO.where)
    assert session.calls == []


@pytest.mark.parametrize("columns", [PLUTO.columns[:-1], tuple(reversed(PLUTO.columns)), PLUTO.columns * 2])
def test_refuses_anything_but_the_exact_column_list(session, tmp_path, columns):
    with pytest.raises(NotAllowed, match=r"\$select"):
        _download(session, tmp_path, PLUTO.id, columns, PLUTO.where)
    assert session.calls == []


@pytest.mark.parametrize("where", [
    "borough in ('MN')",
    "borough in ('BK','QN') OR 1=1",
    "bbl = '3012340001'",  # one property: never
    None,
    "",
])
def test_refuses_any_other_filter(session, tmp_path, where):
    with pytest.raises(NotAllowed, match=r"\$where"):
        _download(session, tmp_path, PLUTO.id, PLUTO.columns, where)
    assert session.calls == []


def test_refuses_another_roll_year_window(session, tmp_path):
    other_years = allowlist.where_for(ROLL, 2023)
    with pytest.raises(NotAllowed, match=r"\$where"):
        _download(session, tmp_path, ROLL.id, ROLL.columns, other_years)
    assert session.calls == []


@pytest.mark.parametrize("url", [
    "https://example.com/resource/64uk-42ks.json",
    "http://data.cityofnewyork.us/resource/64uk-42ks.json",
    "https://data.cityofnewyork.us/resource/636b-3b5g.json",
    "https://data.cityofnewyork.us/resource/64uk-42ks.json?$select=ownername",
    "https://data.cityofnewyork.us/resource/64uk-42ks.csv",
    "https://data.ny.gov/resource/64uk-42ks.json",
    "https://www.nyc.gov/assets/finance/downloads/rolling_sales_brooklyn.xls",
    "https://www.nyc.gov/site/finance/index.page",
    "https://nyc.gov/assets/finance/downloads/sales_brooklyn_03.xls",
])
def test_client_refuses_addresses_off_the_list(session, url):
    with pytest.raises(NotAllowed):
        Client(session, 2027).get(url, "test")
    assert session.calls == []


def _page_params(ds, **changes):
    params = {"$select": ",".join(ds.columns), "$where": allowlist.where_for(ds, 2027),
              "$order": ":id", "$limit": "50000", "$offset": "0"}
    params.update(changes)
    return {k: v for k, v in params.items() if v is not None}


@pytest.mark.parametrize("changes", [
    {"$select": ",".join(PLUTO.columns + ("ownername",))},
    {"$where": "borough in ('MN')"},
    {"$where": None},
    {"$order": "bbl"},
    {"$limit": "50001"},
    {"$limit": "0"},
    {"$offset": "-1"},
    {"$q": "test"},
    {"$group": "borough"},
])
def test_client_refuses_parameters_off_the_list(session, changes):
    with pytest.raises(NotAllowed):
        Client(session, 2027).get(PLUTO.resource_url, "test", _page_params(PLUTO, **changes))
    assert session.calls == []


def test_client_refuses_parameters_on_metadata_and_dof_addresses(session):
    client = Client(session, 2027)
    with pytest.raises(NotAllowed):
        client.get(PLUTO.metadata_url, "test", {"$select": "ownername"})
    with pytest.raises(NotAllowed):
        client.get(allowlist.DOF_FILES[0].url, "test", {"x": "1"})
    assert session.calls == []


def test_cli_refuses_an_unknown_dataset_before_any_request(session, run_cli, tmp_path):
    assert run_cli(tmp_path, "--only", "dof", "636b-3b5g") == 2
    assert session.calls == []
    assert not (tmp_path / "manifest.json").exists()


def test_cli_refuses_a_roll_year_out_of_range(session, run_cli, tmp_path):
    assert run_cli(tmp_path, "--newest-roll-year", "2020") == 2
    assert session.calls == []


NEVER_DOWNLOADED = {
    "636b-3b5g",  # ACRIS Real Property Parties
    "pwkr-dpni",  # ACRIS References
    "9rz4-mjek",  # Tax Lien Sale Lists
    "erm2-nwe9",  # 311
    "76ig-c548",  # 311
    "tesw-yqqr",  # Multiple Dwelling Registrations
}


def test_never_downloaded_datasets_are_not_on_the_list():
    assert not NEVER_DOWNLOADED & set(DATASETS)


def test_no_person_or_money_owed_columns():
    words = ("owner", "name", "phone", "email", "respondent", "balance", "penal", "amount_paid")
    for ds in DATASETS.values():
        for column in ds.columns:
            if (ds.id, column) == ("39hk-dx4f", "stop_name"):  # a subway station's name
                continue
            assert not any(w in column for w in words), (ds.id, column)


def test_acris_master_keeps_deeds_only():
    where = DATASETS["bnx9-e6tj"].where
    doc_types = re.findall(r"'([^']*)'", where.split("doc_type in", 1)[1])
    assert doc_types == ["DEED", "DEEDO", "DEEDP", "DEED, LE", "DEED, RC", "DEED, TS", "IDED", "REIT"]
    for mortgage_or_lien in ("MTGE", "SAT", "AGMT", "ASST", "SMTG", "M&CON", "ALIS", "TL&R"):
        assert mortgage_or_lien not in doc_types


def _small_run(server, helpers, run_cli, tmp_path, environ):
    server.files = helpers.excel_files()
    server.rows["usep-8jbt"] = helpers.tiny_rows("usep-8jbt", 3)
    server.rows["39hk-dx4f"] = helpers.tiny_rows("39hk-dx4f", 2)
    return run_cli(tmp_path, "--only", "dof", "usep-8jbt", "39hk-dx4f", environ=environ)


def test_key_pair_goes_to_nyc_open_data_only(server, session, helpers, run_cli, tmp_path, no_floors, capsys):
    environ = {"NYC_SOCRATA_KEY_ID": "test-key-id", "NYC_SOCRATA_KEY_SECRET": "test-key-secret"}
    assert _small_run(server, helpers, run_cli, tmp_path, environ) == 0
    hosts = {urlsplit(c.url).hostname for c in session.calls}
    assert hosts == {allowlist.NYC_OPEN_DATA, allowlist.NY_STATE_OPEN_DATA, allowlist.NYC_GOV}
    basic = "Basic " + base64.b64encode(b"test-key-id:test-key-secret").decode()
    for call in session.calls:
        assert call.headers["User-Agent"] == USER_AGENT
        assert call.allow_redirects is False
        if urlsplit(call.url).hostname == allowlist.NYC_OPEN_DATA:
            sent = requests.Request("GET", call.url, auth=call.auth).prepare().headers["Authorization"]
            assert sent == basic
        else:
            assert call.auth is None
    written = (tmp_path / "manifest.json").read_text() + "".join(capsys.readouterr())
    assert "test-key-id" not in written and "test-key-secret" not in written


def test_without_the_key_pair_requests_are_anonymous(server, session, helpers, run_cli, tmp_path, no_floors):
    assert _small_run(server, helpers, run_cli, tmp_path, {}) == 0
    assert session.trust_env is False  # no proxies or ~/.netrc credentials from the environment
    assert session.calls and all(c.auth is None for c in session.calls)
    assert all(c.headers["User-Agent"] == USER_AGENT for c in session.calls)


def test_half_a_key_pair_is_not_used(server, session, helpers, run_cli, tmp_path, no_floors):
    assert _small_run(server, helpers, run_cli, tmp_path, {"NYC_SOCRATA_KEY_ID": "test-key-id"}) == 0
    assert all(c.auth is None for c in session.calls)
