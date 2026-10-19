"""#1: the 26 DOF annualized-sales Excel files (2003-2015), saved whole.

Where each rule comes from (engineering precautions):
- These files are history and never change, so each one is downloaded only
  if it's missing or its SHA-256 differs from the manifest.
- A 200 answer that isn't an Excel file (an error page, say) stops the run
  instead of being saved.
"""
from __future__ import annotations

import hashlib
import os
import time
from pathlib import Path
from typing import Iterator

from .allowlist import DOF_FILES
from .client import Client, FetchError
from .manifest import sha256_file, utc_now

_EXCEL_SIGNATURES = (bytes.fromhex("d0cf11e0a1b11ae1"), b"PK\x03\x04")  # .xls (OLE2), .xlsx (zip)


def download_static_files(client: Client, out: Path, previous: dict, *, log) -> Iterator[tuple[str, dict, bool]]:
    """Yield (path, manifest entry, downloaded?) for each of the 26 files, in order."""
    downloaded = 0
    for f in DOF_FILES:
        path = out / f.out_path
        prev = previous.get(f.out_path)
        if isinstance(prev, dict) and path.is_file() and prev.get("sha256") == sha256_file(path):
            yield f.out_path, prev, False
            continue
        downloaded_at, started = utc_now(), time.monotonic()
        body = client.get(f.url, f.label).content
        if not body.startswith(_EXCEL_SIGNATURES):
            raise FetchError(f"{f.label}: the answer was not an Excel file")
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_name(path.name + ".partial")
        partial.write_bytes(body)
        os.replace(partial, path)
        downloaded += 1
        log(f"{f.label}: {len(body) / 1e6:.1f} MB in {time.monotonic() - started:.1f}s")
        yield f.out_path, {
            "dataset": "#1",
            "title": "DOF annualized sales (Excel)",
            "source": f.url,
            "filter": "whole file",
            "columns": None,  # saved whole; the later step reads the sheet
            "rows": None,
            "downloaded_at": downloaded_at,
            "seconds": round(time.monotonic() - started, 1),
            "bytes": len(body),
            "sha256": hashlib.sha256(body).hexdigest(),
        }, True
    log(f"#1 DOF annualized sales: {downloaded} downloaded, {len(DOF_FILES) - downloaded} unchanged and skipped")
