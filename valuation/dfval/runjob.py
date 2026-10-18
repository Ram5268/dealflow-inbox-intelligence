"""The monthly run (Brief 44 §5): value every CRM seller, check the publish gates, and publish
through DealFlow's protected import address unless it's a dry run.

- As of: the first day after the newest sale in the files; values are "as of" that day.
- Gate months: the 3 most recent months of sales, each scored by a model trained only on earlier
  sales. Range months: the 12 months before those, where the range half-widths are chosen.
- The run never publishes, and DealFlow keeps the last published values, if a gate fails.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import secrets
import time

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from . import config, contract
from . import model as MD
from .api import DealFlow, Refused
from .build import Inputs
from .facts import FactSources, card_comps, facts_for, permits_7y
from .features import alteration_events, xy
from .raw import Raw
from .scoreboard import scoreboard, spread_quantiles
from .targets import AddressIndex, no_value_reason, parse_address

_BBL_OK = lambda b: isinstance(b, str) and len(b) == 10 and b.isdigit() and b[0] in "34"  # noqa: E731


def plan_months(asof: pd.Timestamp, month_counts: pd.Series | None = None) -> tuple[list[pd.Timestamp], list[pd.Timestamp]]:
    """The 3 most recent complete months (gates) and the 12 before them (range sizing).

    The newest month is only partly recorded when the files are downloaded (deeds and DOF's
    monthly file lag by weeks). It counts as complete only when it has at least 75% of the
    usual number of scored sales (the median of the 6 months before it); otherwise the gate
    months end a month earlier (engineering precaution: a half-recorded month over-represents
    quickly recorded deeds)."""
    last = (asof - pd.Timedelta(days=1)).to_period("M").to_timestamp()
    if month_counts is not None:
        before = [month_counts.get(last - pd.DateOffset(months=k), 0) for k in range(1, 7)]
        if month_counts.get(last, 0) < config.COMPLETE_MONTH_SHARE * float(np.median(before)):
            last = last - pd.DateOffset(months=1)
    gate = [last - pd.DateOffset(months=k) for k in range(config.GATE_MONTHS - 1, -1, -1)]
    rng = [gate[0] - pd.DateOffset(months=k) for k in range(config.RANGE_TUNE_MONTHS, 0, -1)]
    return rng, gate


def size_ranges(pred: np.ndarray, y: np.ndarray, top: np.ndarray, in_rng: np.ndarray, in_gate: np.ndarray) -> dict:
    """Half-widths per segment, chosen on the range months so the shown range (value x (1 +/- w))
    holds the sale price 2 times in 3; coverage is then measured on the gate months only."""
    miss = np.abs(np.exp(y - pred) - 1)  # |price / value - 1|: the price is inside value x (1 +/- w) when miss <= w
    ok = np.isfinite(miss)
    w_top = float(np.quantile(miss[in_rng & top & ok], config.RANGE_COVER))
    w_other = float(np.quantile(miss[in_rng & ~top & ok], config.RANGE_COVER))
    w = np.where(top, w_top, w_other)
    inside = ok & (miss <= w)
    g = in_gate & ok
    return {"w_top": w_top, "w_other": w_other, "w": w, "inside": inside,
            "cover": float(inside[g].mean()) if g.any() else float("nan"),
            "cover_top": float(inside[g & top].mean()) if (g & top).any() else None}


def match_targets(sellers: pd.DataFrame, pluto: pd.DataFrame, ix: AddressIndex) -> pd.DataFrame:
    """Each seller's tax lot (cached lot from a published run first) and its no-value reason."""
    P = pluto.set_index("bbl")
    out = []
    for r in sellers.itertuples():
        bbl, parsed, how = None, parse_address(r.address), "cached"  # parsed even for a cached lot: its unit number decides the reason
        if _BBL_OK(getattr(r, "cachedBbl", None)) and r.cachedBbl in P.index:
            bbl = r.cachedBbl
        lu = float(r.unitCount) if pd.notna(r.unitCount) else None
        ls = float(r.buildingSqft) if pd.notna(r.buildingSqft) else None
        if bbl is None:
            bbl, parsed, how = ix.match(r.address, r.city, r.zip, lu, ls)
        has_unit = bool(parsed and parsed.unit)
        row = None
        if bbl is not None and bbl in P.index:
            row = P.loc[bbl].copy()
            row["bbl"] = bbl
        reason = no_value_reason(row, has_unit)
        out.append({"contactId": r.contactId, "bbl": bbl if reason != "not_found" else None, "how": how, "reason": reason,
                    "lead_units": lu, "lead_sqft": ls})
    return pd.DataFrame(out)


def gate_checks(m_all: float, m_top: float, cover: float, valued: int) -> tuple[bool, list[dict]]:
    vals = {"typical_miss_all": m_all, "typical_miss_top8_2to4": m_top, "range_coverage": cover, "sellers_valued": valued}
    checks = []
    for k, lim in config.GATES.items():
        v = vals[k]
        ok = v is not None and np.isfinite(v) and ("min" not in lim or v >= lim["min"]) and ("max" not in lim or v <= lim["max"])
        checks.append({"key": k, "value": float(v) if v is not None and np.isfinite(v) else -1.0, "pass": bool(ok)})
    return all(c["pass"] for c in checks), checks


def run(data_dir: str, out_dir: str, dry_run: bool = True, targets: dict | None = None, client: DealFlow | None = None, log=print,
        keep: dict | None = None) -> dict:
    """One monthly run. `keep` (tests only) receives the payload; nothing per-seller is written to disk."""
    t0 = time.time()
    os.makedirs(out_dir, exist_ok=True)
    raw = Raw(data_dir)
    if targets is None:
        client = client or DealFlow()
        targets = client.targets()
    sellers = pd.DataFrame(targets["sellers"])
    for c in ["contactId", "address", "city", "state", "zip", "unitCount", "buildingSqft", "cachedBbl"]:
        if c not in sellers:
            sellers[c] = None
    log(f"targets: {len(sellers):,} CRM sellers")
    inp = Inputs(raw, screen="name-free", log=log)
    asof = inp.end
    data_through = asof - pd.Timedelta(days=1)
    rng_months, gate_months = None, None  # chosen below, once the scored sales' months are known

    # ---- sellers -> tax lots -> reasons
    ix = AddressIndex(inp.pluto, inp.sales)
    M = match_targets(sellers, inp.pluto, ix)
    counts = {k: int((M["reason"] == k).sum()) for k in config.NO_VALUE_REASONS}
    log(f"matched: {int(M['bbl'].notna().sum()):,} lots; 1-4 family {int(M['reason'].isna().sum()):,}; " + ", ".join(f"{k} {v}" for k, v in counts.items()))

    # ---- rows and inputs
    Xs = inp.sale_rows(config.T_ORIGIN, asof)
    rng_months, gate_months = plan_months(asof, Xs.groupby("month").size())
    log(f"as of {asof.date()}; range months {rng_months[0].date()}..{rng_months[-1].date()}; gate months {gate_months[0].date()}..{gate_months[-1].date()}")
    Xv = inp.seller_rows(M[M["reason"].isna()][["contactId", "bbl"]], asof)
    X = pd.concat([Xs, Xv], ignore_index=True)
    comps_out: dict = {}
    X = MD.transform(inp.features(X, comps_out))
    feats = MD.PRODUCTION_FEATURES
    y = np.log(X["price"].to_numpy(float))

    # ---- out-of-sample accuracy on the range and gate months
    pred = MD.walk_forward(X, rng_months + gate_months, feats, log=log)
    seg = MD.segments(X)
    top = seg["top8_two_to_four"]
    price = X["price"].to_numpy(float)
    scored = np.isfinite(pred) & np.isfinite(y)
    in_rng = X["month"].isin(rng_months).to_numpy() & scored
    in_gate = X["month"].isin(gate_months).to_numpy() & scored
    rs = size_ranges(pred, y, top, in_rng, in_gate)
    if keep is not None:  # tests only: what the ranges and gates were computed from
        keep["ranges"] = {"pred": pred, "y": y, "top": top, "in_rng": in_rng, "in_gate": in_gate, "month": X["month"].to_numpy(),
                          "rng_months": rng_months, "gate_months": gate_months}
    w_top, w_other, inside, cover = rs["w_top"], rs["w_other"], rs["inside"], rs["cover"]
    gm = {k: MD.metrics(pred, price, in_gate & m) for k, m in seg.items()}

    # ---- the final model: every priced sale before the as-of date (at most 48 months back)
    tr = MD.train_mask(X, asof)
    mdl = MD.fit(X, tr, y, feats)
    sel = X["is_seller"].to_numpy(bool)
    sv = np.exp(mdl.predict(X.loc[sel, feats]))
    sw = np.where(top[sel], w_top, w_other)
    S_rows = X.loc[sel, ["contactId", "bbl"]].copy()
    S_rows["value"], S_rows["low"], S_rows["high"] = sv, sv * (1 - sw), sv * (1 + sw)
    S_rows["pos"] = np.flatnonzero(sel)
    valued = int(np.isfinite(sv).sum())
    passed, checks = gate_checks(gm["all"].get("mdape"), gm["top8_two_to_four"].get("mdape"), cover, valued)
    log(f"gates {'PASS' if passed else 'FAIL'}: " + "; ".join(f"{c['key']} {c['value']:.4f} {'ok' if c['pass'] else 'FAIL'}" for c in checks))

    # ---- facts and nearby sales for the card
    lots = set(M["bbl"].dropna())
    src = FactSources(inp, lots, asof)
    perm = permits_7y(alteration_events(raw.dob_permits().pipe(lambda d: d[d["bbl"].isin(lots)]), raw.dobnow_jobs(),
                                        raw.dobnow_permits().pipe(lambda d: d[d["bbl"].isin(lots)])), lots, asof)
    P = inp.pluto.set_index("bbl")
    tree = cKDTree(xy(inp.stations["lat"], inp.stations["lon"]))
    by_cid = S_rows.set_index("contactId")
    rows = []
    for r in M.itertuples():
        row = {"contactId": r.contactId, "bbl": r.bbl, "value": None, "low": None, "high": None, "reason": r.reason, "facts": None, "comps": []}
        if r.bbl is not None:
            p = P.loc[r.bbl]
            sub = float(tree.query(xy([p["latitude"]], [p["longitude"]]))[0][0]) if pd.notna(p["latitude"]) else None
            row["facts"] = facts_for(src, r.bbl, perm.get(r.bbl, {"count": 0, "major": False}), sub, r.lead_units, r.lead_sqft)
        if r.reason is None:
            s = by_cid.loc[r.contactId]
            if np.isfinite(s["value"]):
                row.update(value=float(round(s["value"], -3)), low=float(round(s["low"], -3)), high=float(round(s["high"], -3)))
                row["comps"] = card_comps(comps_out.get(int(s["pos"])), asof)
            else:
                row["reason"] = "other_property_type"
        rows.append(row)

    # ---- the matching scoreboard and the report
    prev = (targets.get("previousPublished") or {})
    sb = {k: scoreboard(pred, y, in_gate & seg[k]) for k in ("top8_two_to_four", "all")}
    vals = np.array([r["value"] for r in rows if r["value"] is not None], float)
    mv = np.array([(r["value"], r["facts"]["dofMarketValue"]["value"]) for r in rows
                   if r["value"] is not None and r["facts"] and r["facts"].get("dofMarketValue")], float).reshape(-1, 2)
    ratio = mv[:, 0] / mv[:, 1] if len(mv) else np.array([])
    metrics = {
        "gate": gm,
        "range": {"halfwidth_top8_two_to_four": round(w_top, 4), "halfwidth_other": round(w_other, 4), "coverage_gate": round(cover, 4),
                  "coverage_gate_top8_two_to_four": round(rs["cover_top"], 4) if rs["cover_top"] is not None else None,
                  "range_months": len(rng_months)},
        "spread_q_top8_two_to_four": (own_q := spread_quantiles(pred, y, in_rng & top)),
        # The same scoreboard with this model's own spread table, to show whether the live table still fits (PR 4).
        "scoreboard_own_spread_top8_two_to_four": scoreboard(pred, y, in_gate & top, spread_q=own_q) if own_q else None,
        "training_sales": int(tr.sum()),
        "screen_min_price_to_market_value": config.MIN_PRICE_TO_MARKET_VALUE,
        "sales_gap_months": inp.sales_info.get("gap_months"),
        "value_vs_city": {"sellers_with_city_value": int(len(ratio)), "over_3x": int((ratio > 3).sum()), "under_one_third": int((ratio < 1 / 3).sum()),
                          "median_ratio": round(float(np.median(ratio)), 3) if len(ratio) else None},
        "seconds": round(time.time() - t0),
    }
    counts_all = {"targets": int(len(M)), "valued": int(sum(r["value"] is not None for r in rows)), **{k: int(sum(r["reason"] == k for r in rows)) for k in config.NO_VALUE_REASONS},
                  "trainingSales": int(tr.sum()), "gateSales": int(in_gate.sum())}
    sources = raw.sources()
    sources.update(salesThrough=data_through.date().isoformat(), plutoVersion=str(inp.pluto["version"].dropna().iloc[0]) if inp.pluto["version"].notna().any() else None,
                   rollFiscalYear=int(src.roll_year) if src.roll_year else None)
    run_id = f"run-{dt.datetime.now(dt.timezone.utc):%Y%m%dT%H%M%SZ}-{secrets.token_hex(3)}"
    run_payload = {"runId": run_id, "runAt": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "asOf": asof.date().isoformat(),
                   "dataThrough": data_through.date().isoformat(), "modelVersion": config.MODEL_VERSION,
                   "gates": {"passed": passed, "checks": checks}, "metrics": json.loads(json.dumps(metrics, default=float)),
                   "scoreboard": sb, "sources": sources, "counts": counts_all, "expectedRows": len(rows)}
    summary = {"runId": run_id, "dryRun": dry_run, "asOf": run_payload["asOf"], "dataThrough": run_payload["dataThrough"], "gates": run_payload["gates"],
               "counts": counts_all, "metrics": metrics, "scoreboard": sb, "previousScoreboard": prev.get("scoreboard"),
               "medianValueRounded10k": float(round(float(np.median(vals)), -4)) if len(vals) else None, "published": False}

    # The payload must pass DealFlow's contract before anything is sent (contract.py).
    contract.validate_run(run_payload)
    for r in rows:
        contract.validate_row(r, run_payload["asOf"])
    if keep is not None:
        keep.update(run=run_payload, rows=rows)

    # ---- publish (never in a dry run; never when a gate fails)
    if not dry_run:
        final: dict = {}
        summary["published"] = publish(client or DealFlow(), run_payload, rows, passed, log, final)
        if final:  # sellers DealFlow no longer lists were dropped: report what DealFlow actually got
            summary.update(counts=final["counts"], gates=final["gates"])
    with open(os.path.join(out_dir, "summary.json"), "w") as fh:
        json.dump(summary, fh, indent=1, default=float)
    log(f"done in {time.time() - t0:.0f}s: valued {counts_all['valued']:,} of {counts_all['targets']:,}; published {summary['published']}")
    return summary


def recount(run_payload: dict, rows: list[dict]) -> dict:
    """The run's counts and its sellers-valued gate, recomputed for the rows that remain."""
    valued = sum(r["value"] is not None for r in rows)
    counts = dict(run_payload["counts"], targets=len(rows), valued=valued, **{k: sum(r["reason"] == k for r in rows) for k in config.NO_VALUE_REASONS})
    checks = [dict(c, value=float(valued), **{"pass": valued >= config.GATES["sellers_valued"]["min"]}) if c["key"] == "sellers_valued" else c
              for c in run_payload["gates"]["checks"]]
    return dict(run_payload, counts=counts, expectedRows=len(rows), gates={"passed": all(c["pass"] for c in checks), "checks": checks})


def publish(client: DealFlow, run_payload: dict, rows: list[dict], passed: bool, log, final: dict | None = None) -> bool:
    """start -> rows (200 at a time) -> publish. A seller DealFlow no longer counts as a CRM seller
    is dropped and the run restarted with the smaller row count (CONTRACT.md §3)."""
    def send(step: str, payload: dict) -> dict:
        # One line per request (its step and size; on a failure, how long it took and the error
        # type), so a stopped publish says where it stopped. Counts only. Still no retries.
        t = time.time()
        log(f"  send {step}: {len(json.dumps(payload, allow_nan=False)):,} bytes")
        try:
            return client.post(payload)
        except Exception as e:
            log(f"  {step} failed after {time.time() - t:.1f}s: {type(e).__name__}")
            raise

    r = send("start", {"action": "start", "run": run_payload})
    if not (passed and r.get("gatesPassed")):
        log("gates failed: the run is recorded, nothing published; DealFlow keeps the last published values")
        return False
    rows = list(rows)
    i = 0
    while i < len(rows):
        batch = rows[i:i + config.BATCH_SIZE]
        try:
            send(f"rows {i + 1:,}-{i + len(batch):,}", {"action": "rows", "runId": run_payload["runId"], "rows": batch})
            i += len(batch)
        except Refused as e:
            unknown = set(e.body.get("unknown") or [])
            if e.status != 422 or not unknown:
                raise
            log(f"DealFlow no longer lists {len(unknown)} seller(s); dropping them and restarting the run's row count")
            rows = [x for x in rows if x["contactId"] not in unknown]
            run_payload = recount(run_payload, rows)
            if final is not None:
                final.update(counts=run_payload["counts"], gates=run_payload["gates"])
            r = send("start again", {"action": "start", "run": run_payload})
            if not (run_payload["gates"]["passed"] and r.get("gatesPassed")):
                log("after dropping them a gate fails: nothing published; DealFlow keeps the last published values")
                return False
    send("publish", {"action": "publish", "runId": run_payload["runId"]})
    log(f"published run {run_payload['runId']}: {len(rows):,} rows")
    return True
