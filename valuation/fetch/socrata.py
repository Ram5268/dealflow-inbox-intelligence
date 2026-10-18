"""Download one allow-listed Open Data dataset, page by page, into Parquet.

Each value is saved as the text the city's API returned (missing values stay
empty), so nothing is lost or reinterpreted here. The later step that builds
the model's tables does the typing; the manifest records each column's type
from the city's metadata to help it.

Where each rule comes from (all engineering precautions):
- Keyset paging (Brief 44.1 Revision 1, 2026-10-18): pages of 50,000 rows
  ordered by :id, one request at a time. After the first page, each request
  adds `:id > '<last :id>'` to the dataset's own filter, so every page is
  equally quick for the city's server at any depth. It stops at a short page.
  :id is requested for paging only and never saved.
- A page that doesn't move past the previous cursor, or a row id that
  doesn't look like a Socrata row id, stops the run.
- The file is written to <id>.parquet.partial and renamed only when every
  check has passed, so a failed run never leaves a file that looks complete.
- The city's metadata is read before and after the pages. If the dataset was
  updated in between (a full reload would give its rows new ids), the run
  stops.
- A row with any column outside the allow-list stops the run.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import time
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from .allowlist import CURSOR, ID, ORDER, PAGE_SIZE, Dataset, check_query, page_where
from .client import Client, FetchError
from .manifest import sha256_file, utc_now


def download_dataset(client: Client, dataset_id: str, columns, where: str | None, out: Path, *,
                     log, page_size: int = PAGE_SIZE) -> dict:
    """Save one dataset to <out>/raw/<id>.parquet and return its manifest entry."""
    ds = check_query(dataset_id, columns, where, client.newest_roll_year)  # refuses before any request
    downloaded_at, started = utc_now(), time.monotonic()
    before = _metadata(client, ds)
    if before.get("name") != ds.title:
        log(f"{ds.label}: note: the city now titles it {before.get('name')!r}")
    column_types = _column_types(ds, before)

    final = out / ds.out_path
    final.parent.mkdir(parents=True, exist_ok=True)
    partial = final.with_name(final.name + ".partial")
    schema = pa.schema([(c, pa.string()) for c in ds.columns])
    params = {"$select": ",".join((ID,) + ds.columns), "$order": ORDER, "$limit": str(page_size)}
    cursor = None
    rows = pages = 0
    try:
        with pq.ParquetWriter(partial, schema, compression="zstd") as writer:
            while True:
                page_started = time.monotonic()
                this_where = page_where(where, cursor)
                resp = client.get(ds.resource_url, ds.label,
                                  params if this_where is None else {**params, "$where": this_where})
                page = _rows(ds, resp, page_size)
                if page:
                    writer.write_table(_table(ds, page, schema))
                pages += 1
                rows += len(page)
                log(f"{ds.label}: page {pages}: {len(page):,} rows in "
                    f"{time.monotonic() - page_started:.1f}s ({rows:,} so far)")
                if len(page) < page_size:
                    break
                if cursor is not None and cursor in (page[0][ID], page[-1][ID]):
                    raise FetchError(f"{ds.label}: page {pages} didn't move past the last :id, so paging stopped")
                cursor = page[-1][ID]
        after = _metadata(client, ds)
        if after.get("rowsUpdatedAt") != before.get("rowsUpdatedAt"):
            raise FetchError(f"{ds.label}: the city updated this dataset during the download, "
                             "so its pages may not line up; run again later")
        if rows < ds.min_rows:
            raise FetchError(f"{ds.label}: only {rows:,} rows, fewer than the {ds.min_rows:,} expected; "
                             "the filter may no longer match the city's data")
        os.replace(partial, final)
    except BaseException:
        partial.unlink(missing_ok=True)
        raise
    return {
        "dataset": f"#{ds.number}",
        "title": before.get("name"),
        "source": ds.resource_url,
        "filter": where,
        "columns": list(ds.columns),
        "column_types": column_types,
        "rows": rows,
        "pages": pages,
        "downloaded_at": downloaded_at,
        "seconds": round(time.monotonic() - started, 1),
        "source_updated_at": _iso(before.get("rowsUpdatedAt")),
        "bytes": final.stat().st_size,
        "sha256": sha256_file(final),
    }


def _metadata(client: Client, ds: Dataset) -> dict:
    resp = client.get(ds.metadata_url, f"{ds.label} metadata")
    try:
        meta = resp.json()
    except ValueError:
        raise FetchError(f"{ds.label}: its metadata was not JSON") from None
    if not isinstance(meta, dict):
        raise FetchError(f"{ds.label}: its metadata was not a JSON object")
    return meta


def _column_types(ds: Dataset, meta: dict) -> dict[str, str]:
    published = {c.get("fieldName"): c.get("dataTypeName") for c in meta.get("columns") or [] if isinstance(c, dict)}
    missing = [c for c in ds.columns if c not in published]
    if missing:
        raise FetchError(f"{ds.label}: the city's metadata no longer lists column(s) {', '.join(missing)}")
    return {c: published[c] for c in ds.columns}


def _rows(ds: Dataset, resp, page_size: int) -> list[dict]:
    try:
        data = resp.json()
    except ValueError:
        raise FetchError(f"{ds.label}: a page was not JSON") from None
    if not isinstance(data, list) or not all(isinstance(r, dict) for r in data):
        raise FetchError(f"{ds.label}: a page was not a list of rows")
    if len(data) > page_size:
        raise FetchError(f"{ds.label}: a page had {len(data):,} rows, more than the {page_size:,} asked for")
    allowed = set(ds.columns) | {ID}  # :id is for paging only; _table leaves it out
    for row in data:
        if not allowed.issuperset(row):
            extra = ", ".join(sorted(set(row) - allowed))
            raise FetchError(f"{ds.label}: a page had column(s) outside the allow-list: {extra}")
        row_id = row.get(ID)
        if not isinstance(row_id, str) or not CURSOR.fullmatch(row_id):
            raise FetchError(f"{ds.label}: a row came back without a normal :id, so paging can't continue")
    return data


def _table(ds: Dataset, page: list[dict], schema: pa.Schema) -> pa.Table:
    return pa.Table.from_pydict({c: [_text(ds, c, row.get(c)) for row in page] for c in ds.columns}, schema=schema)


def _text(ds: Dataset, column: str, value):
    if value is None or isinstance(value, str):
        return value
    if isinstance(value, bool):  # Socrata sends checkbox columns as JSON true/false
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return json.dumps(value)
    raise FetchError(f"{ds.label}: column {column} held a structured value; only plain values are saved")


def _iso(epoch) -> str | None:
    if not isinstance(epoch, (int, float)):
        return None
    return dt.datetime.fromtimestamp(epoch, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
