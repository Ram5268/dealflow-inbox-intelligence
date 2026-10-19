"""manifest.json: where each saved file came from, and its fingerprint."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
from pathlib import Path

MANIFEST_NAME = "manifest.json"
FORMAT = 1


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load(out: Path) -> dict:
    """The previous run's manifest, or {} if there is none or it can't be read."""
    try:
        data = json.loads((out / MANIFEST_NAME).read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save(out: Path, manifest: dict) -> None:
    # Engineering precaution: written to a side file and renamed, so a crash
    # never leaves half a manifest.
    path = out / MANIFEST_NAME
    partial = path.with_name(path.name + ".partial")
    partial.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    os.replace(partial, path)
