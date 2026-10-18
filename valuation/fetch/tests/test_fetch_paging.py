"""Paging, and stop-on-error: one request at a time, ordered by :id, each page
after the last :id of the one before (keyset paging, Revision 1), until a
short page; any failure stops the run and leaves no file behind."""
import re

import pyarrow as pa
import pyarrow.parquet as pq
import pytest
import requests

from valuation.fetch import allowlist
from valuation.fetch.client import Client, FetchError
from valuation.fetch.socrata import download_dataset

SALES = "usep-8jbt"  # #3, a plain whole-borough filter
MTA = "39hk-dx4f"  # #18, no filter at all


def _download(session, tmp_path, dataset_id=SALES, page_size=2, log=lambda _: None):
    ds = allowlist.DATASETS[dataset_id]
    return download_dataset(Client(session, 2027), ds.id, ds.columns, allowlist.where_for(ds, 2027), tmp_path,
                            log=log, page_size=page_size)


def _data_calls(session):
    return [c for c in session.calls if "/resource/" in c.url]


def _later_page(call):
    return ":id > '" in call.params.get("$where", "")


def _no_files_left(tmp_path):
    raw = tmp_path / "raw"
    return not raw.exists() or not any(raw.iterdir())


def test_pages_by_id_until_a_short_page(server, session, helpers, tmp_path, no_floors):
    ds = allowlist.DATASETS[SALES]
    server.rows[SALES] = helpers.tiny_rows(SALES, 5)
    entry = _download(session, tmp_path)

    calls = _data_calls(session)
    assert [c.params["$where"] for c in calls] == [
        ds.where,
        f"({ds.where}) AND :id > '{helpers.fake_id(1)}'",
        f"({ds.where}) AND :id > '{helpers.fake_id(3)}'",
    ]
    for c in calls:
        assert set(c.params) == {"$select", "$where", "$order", "$limit"}  # no $offset
        assert c.params["$select"] == ":id," + ",".join(ds.columns)
        assert c.params["$order"] == ":id" and c.params["$limit"] == "2"
    assert [c.url for c in session.calls] == [ds.metadata_url] + [ds.resource_url] * 3 + [ds.metadata_url]

    table = pq.read_table(tmp_path / "raw" / f"{SALES}.parquet")
    assert table.column_names == list(ds.columns)  # :id is never saved
    assert all(t == pa.string() for t in table.schema.types)
    assert table.column("borough").to_pylist() == [f"borough-{i}" for i in range(5)]
    assert table.column("sale_date").to_pylist() == ["sale_date-0", None, "sale_date-2", None, "sale_date-4"]
    assert entry["rows"] == table.num_rows == 5
    assert entry["pages"] == 3


def test_a_full_last_page_is_followed_by_an_empty_one(server, session, helpers, tmp_path, no_floors):
    server.rows[SALES] = helpers.tiny_rows(SALES, 4)
    entry = _download(session, tmp_path)
    assert len(_data_calls(session)) == 3
    assert entry["rows"] == 4 and entry["pages"] == 3


def test_a_dataset_without_a_filter_pages_by_id_alone(server, session, helpers, tmp_path, no_floors):
    server.rows[MTA] = helpers.tiny_rows(MTA, 3)
    entry = _download(session, tmp_path, dataset_id=MTA)
    calls = _data_calls(session)
    assert "$where" not in calls[0].params
    assert calls[1].params["$where"] == f":id > '{helpers.fake_id(1)}'"
    assert entry["rows"] == 3


def test_real_page_size_is_50000():
    assert allowlist.PAGE_SIZE == 50_000


def test_an_http_error_stops_the_run(server, session, helpers, tmp_path, no_floors):
    server.rows[SALES] = helpers.tiny_rows(SALES, 5)
    server.hooks.append(lambda call: helpers.response(500, {"message": "Internal error"})
                        if _later_page(call) else None)
    with pytest.raises(FetchError) as caught:
        _download(session, tmp_path)
    message = str(caught.value)
    assert SALES in message and "HTTP 500" in message
    assert len(_data_calls(session)) == 2  # nothing after the failure
    assert _no_files_left(tmp_path)


def test_a_rate_limit_answer_also_stops_the_run(server, session, helpers, tmp_path, no_floors):
    server.rows[SALES] = helpers.tiny_rows(SALES, 5)
    server.hooks.append(lambda call: helpers.response(429, {"message": "Too many requests"})
                        if "/resource/" in call.url else None)
    with pytest.raises(FetchError, match="HTTP 429"):
        _download(session, tmp_path)
    assert len(_data_calls(session)) == 1  # no retry
    assert _no_files_left(tmp_path)


@pytest.mark.parametrize("error", [
    requests.ConnectionError("connection reset"),
    requests.exceptions.ChunkedEncodingError("Connection broken: IncompleteRead"),
])
def test_a_dropped_connection_stops_the_run(server, session, helpers, tmp_path, no_floors, error):
    server.rows[SALES] = helpers.tiny_rows(SALES, 5)

    def drop(call):
        if _later_page(call):
            raise error
        return None

    server.hooks.append(drop)
    with pytest.raises(FetchError, match=f"{SALES}.*no HTTP status.*{type(error).__name__}: {re.escape(str(error))}"):
        _download(session, tmp_path)
    assert len(_data_calls(session)) == 2
    assert _no_files_left(tmp_path)


def test_a_redirect_is_reported_not_followed(server, session, helpers, tmp_path, no_floors):
    server.hooks.append(lambda call: helpers.response(301, b"", {"Location": "https://example.com/elsewhere"})
                        if "/resource/" in call.url else None)
    with pytest.raises(FetchError, match="HTTP 301.*not followed"):
        _download(session, tmp_path)
    assert all(c.allow_redirects is False for c in session.calls)


def test_a_row_id_that_is_not_a_socrata_id_stops_the_run(server, session, helpers, tmp_path, no_floors):
    rows = [{":id": helpers.fake_id(0)} | r for r in helpers.tiny_rows(SALES, 2)]
    rows[1][":id"] = "x' OR '1'='1"
    server.hooks.append(lambda call: helpers.response(200, rows) if "/resource/" in call.url else None)
    with pytest.raises(FetchError, match="without a normal :id"):
        _download(session, tmp_path)
    assert len(_data_calls(session)) == 1  # it never reached a filter
    assert _no_files_left(tmp_path)


def test_a_page_that_does_not_move_on_stops_the_run(server, session, helpers, tmp_path, no_floors):
    server.rows[SALES] = helpers.tiny_rows(SALES, 6)
    first_page = [{":id": helpers.fake_id(i)} | r for i, r in enumerate(helpers.tiny_rows(SALES, 2))]
    # A server that ignored the :id bound would send the first page again.
    server.hooks.append(lambda call: helpers.response(200, first_page) if _later_page(call) else None)
    with pytest.raises(FetchError, match="didn't move past the last :id"):
        _download(session, tmp_path)
    assert len(_data_calls(session)) == 2
    assert _no_files_left(tmp_path)


def test_stops_if_the_city_updates_the_dataset_mid_download(server, session, helpers, tmp_path, no_floors):
    server.rows[SALES] = helpers.tiny_rows(SALES, 5)
    server.updated_at[SALES] = [1_790_000_000, 1_790_086_400]
    with pytest.raises(FetchError, match="updated this dataset during the download"):
        _download(session, tmp_path)
    assert _no_files_left(tmp_path)


def test_stops_below_the_row_floor(server, session, helpers, tmp_path):
    ds = allowlist.DATASETS[SALES]
    server.rows[SALES] = helpers.tiny_rows(SALES, 3)
    with pytest.raises(FetchError, match=f"only 3 rows, fewer than the {ds.min_rows:,} expected"):
        _download(session, tmp_path)
    assert _no_files_left(tmp_path)


def test_stops_on_a_column_outside_the_allow_list(server, session, helpers, tmp_path, no_floors):
    rows = helpers.tiny_rows(SALES, 3)
    rows[1]["unexpected_column"] = "x"
    server.rows[SALES] = rows
    with pytest.raises(FetchError, match="outside the allow-list: unexpected_column"):
        _download(session, tmp_path)
    assert _no_files_left(tmp_path)


def test_stops_before_paging_if_a_column_is_gone(server, session, tmp_path, no_floors):
    ds = allowlist.DATASETS[SALES]
    server.columns[SALES] = [{"fieldName": c, "dataTypeName": "text"} for c in ds.columns if c != "sale_price"]
    with pytest.raises(FetchError, match="no longer lists column.*sale_price"):
        _download(session, tmp_path)
    assert _data_calls(session) == []


def test_stops_on_a_page_that_is_not_json(server, session, helpers, tmp_path, no_floors):
    server.hooks.append(lambda call: helpers.response(200, b"<html>maintenance</html>", {"Content-Type": "text/html"})
                        if "/resource/" in call.url else None)
    with pytest.raises(FetchError, match="not JSON"):
        _download(session, tmp_path)
    assert _no_files_left(tmp_path)


def test_values_are_saved_as_the_text_the_api_sent(server, session, tmp_path, no_floors):
    pluto = allowlist.DATASETS["64uk-42ks"]
    row = {c: f"{c}-0" for c in pluto.columns}
    row.update(bbl="3000010001", irrlotcode=True, numfloors=2.5, unitsres=3)
    del row["histdist"]
    server.rows[pluto.id] = [row]
    _download(session, tmp_path, dataset_id=pluto.id)
    saved = pq.read_table(tmp_path / "raw" / f"{pluto.id}.parquet").to_pylist()[0]
    assert saved["bbl"] == "3000010001"
    assert saved["irrlotcode"] == "true"
    assert saved["numfloors"] == "2.5" and saved["unitsres"] == "3"
    assert saved["histdist"] is None
    assert ":id" not in saved


def test_progress_is_logged_per_page(server, session, helpers, tmp_path, no_floors):
    server.rows[SALES] = helpers.tiny_rows(SALES, 3)
    lines = []
    _download(session, tmp_path, log=lines.append)
    assert len(lines) == 2 and "page 2: 1 rows" in lines[1]
