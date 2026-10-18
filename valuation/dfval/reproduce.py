"""The two-part reproduction check (Brief 44 §5, revisions 3 and 6). Local only.

Both parts rebuild everything from a valuation/fetch data folder and score the research's test
year (Sep 2025-Aug 2026) with monthly walk-forward training, exactly as the research did.

- Part 1, a faithful port: the arm's-length screen uses the research's saved per-deed yes/no flags
  (passed with --flags; the file holds no names, stays on the research Mac, and is never committed,
  uploaded or put in a CI artifact). Must land within 1 point of the research's "DealFlow model today":
  all homes 48.9% within 10% / 10.28% typical miss; 2-4 family homes in the top-8 neighborhoods
  40.7% / 12.84%. The research's G6 (mortgage records) can't be rebuilt from the files (Brief 44.1
  never downloads them), so part 1 runs the 90 production inputs.
- Part 2, the name-free baseline: the production screen (no names) with its market-value cutoff
  chosen on the tuning year. The publish gates apply to this configuration from then on.

The report holds counts and accuracy numbers only.
"""
from __future__ import annotations

import json
import time

import numpy as np
import pandas as pd

from . import config
from . import model as MD
from .build import Inputs
from .frame import load_flags
from .raw import Raw
from .scoreboard import scoreboard

RESEARCH_TODAY = {"all": {"w10": 0.489, "mdape": 0.1028}, "top8_two_to_four": {"w10": 0.407, "mdape": 0.1284}}


def evaluate(inp: Inputs, feats: list[str], log, research_keys: pd.DataFrame | None = None) -> tuple[dict, pd.DataFrame]:
    X = inp.sale_rows(config.T_ORIGIN, config.RESEARCH_TEST[1])
    X = MD.transform(inp.features(X))
    months = sorted(X.loc[X["date"] >= config.RESEARCH_TUNE[0], "month"].unique())
    pred = MD.walk_forward(X, months, feats, log=log)
    price = X["price"].to_numpy(float)
    tune = ((X["date"] >= config.RESEARCH_TUNE[0]) & (X["date"] < config.RESEARCH_TUNE[1])).to_numpy()
    test = ((X["date"] >= config.RESEARCH_TEST[0]) & (X["date"] < config.RESEARCH_TEST[1])).to_numpy()
    seg = MD.segments(X)
    res = {"rows": int(len(X)), "features": len(feats),
           "test": {k: MD.metrics(pred, price, test & m) for k, m in seg.items()},
           "tune": {k: MD.metrics(pred, price, tune & m) for k, m in seg.items()},
           "scoreboard_test": {k: scoreboard(pred, np.log(price), test & seg[k]) for k in ("top8_two_to_four", "all")}}
    if research_keys is not None:
        keys = research_keys[["bbl", "date", "price"]].drop_duplicates().assign(_r=True)
        same = X[["bbl", "date", "price"]].merge(keys, on=["bbl", "date", "price"], how="left")["_r"].fillna(False).to_numpy(bool)
        res["test_research_sales_only"] = {k: MD.metrics(pred, price, test & same & m) for k, m in seg.items()}
        res["test_research_sales_found"] = int((test & same).sum())
    out = X[["bbl", "date", "price", "month", "nb_raw", "grp_raw"]].copy()
    out["pred"] = pred
    return res, out


def screen_table(inp: Inputs) -> list[dict]:
    """How a price-to-market-value cutoff screens the tuning year's deed-matched sales, measured
    against the saved flags (family / same-party / referee). Run on the flags frame."""
    S = inp.S
    from .frame import price_to_market_value
    base = (S["acris_matched"] & (S["doc_type"] == config.ORDINARY_DEED) & (S["price"] >= config.FLOOR_PRICE) & ~S["dof_multi"]
            & (S["pct"].fillna(100) >= 100) & (S["n_lots"].fillna(1) <= 1)
            & (S["date"] >= config.RESEARCH_TUNE[0]) & (S["date"] < config.RESEARCH_TUNE[1]))
    T = S[base].copy()
    T["ratio"] = price_to_market_value(T, inp.roll)
    T["flagged"] = T["shared_surname"] | T["same_party"] | T["referee"]
    rows = []
    for c in np.round(np.arange(0.10, 0.91, 0.05), 2):
        low = T["ratio"] < c
        rows.append({"cutoff": float(c), "flagged_total": int(T["flagged"].sum()), "ordinary_total": int((~T["flagged"]).sum()),
                     "flagged_caught": int((low & T["flagged"]).sum()), "ordinary_dropped": int((low & ~T["flagged"]).sum()),
                     "family_caught": int((low & T["shared_surname"]).sum()), "same_party_caught": int((low & T["same_party"]).sum()),
                     "referee_caught": int((low & T["referee"]).sum()), "no_market_value": int(T["ratio"].isna().sum())})
    return rows


def run(data_dir: str, flags_path: str, out_path: str, research_keys_path: str | None = None, log=print) -> dict:
    t0 = time.time()
    raw = Raw(data_dir)
    flags = load_flags(flags_path)
    rk = pd.read_parquet(research_keys_path, columns=["bbl", "date", "price"]) if research_keys_path else None
    report: dict = {"data": raw.sources(), "model_version": config.MODEL_VERSION}
    inp = Inputs(raw, screen="flags", flags=flags, log=log)
    report["sales"] = inp.sales_info
    log("== part 1 (saved flags)")
    report["part1"], p1 = evaluate(inp, MD.PRODUCTION_FEATURES, log, rk)
    table = screen_table(inp)
    best = max(table, key=lambda r: (r["flagged_caught"] - r["ordinary_dropped"], -r["cutoff"]))
    report["screen_tuning"] = {"rule": "largest (flagged caught - ordinary dropped) on the tuning year", "chosen": best["cutoff"], "table": table}
    log(f"== part 2 (name-free, cutoff {best['cutoff']})")
    inp.rescreen("name-free", min_ratio=best["cutoff"])
    report["part2"], p2 = evaluate(inp, MD.PRODUCTION_FEATURES, log, rk)
    # The same sales in both parts: the cost of reading no names, on equal footing.
    both = p1.merge(p2, on=["bbl", "date", "price"], suffixes=("_1", "_2"))
    tst = ((both["date"] >= config.RESEARCH_TEST[0]) & (both["date"] < config.RESEARCH_TEST[1])).to_numpy()
    segs = MD.segments(both.rename(columns={"nb_raw_1": "nb_raw", "grp_raw_1": "grp_raw"}))
    pr = both["price"].to_numpy(float)
    report["common_test_sales"] = {k: {"part1": MD.metrics(both["pred_1"].to_numpy(), pr, tst & m), "part2": MD.metrics(both["pred_2"].to_numpy(), pr, tst & m)}
                                   for k, m in segs.items()}
    t1 = report["part1"].get("test_research_sales_only", report["part1"]["test"])
    report["check"] = {k: {"w10_gap_pts": round(100 * (t1[k]["w10"] - v["w10"]), 2), "mdape_gap_pts": round(100 * (t1[k]["mdape"] - v["mdape"]), 2),
                           "within_1_point": abs(t1[k]["w10"] - v["w10"]) <= 0.01 and abs(t1[k]["mdape"] - v["mdape"]) <= 0.01}
                       for k, v in RESEARCH_TODAY.items()}
    report["seconds"] = round(time.time() - t0)
    with open(out_path, "w") as fh:
        json.dump(report, fh, indent=1, default=str)
    log(json.dumps(report["check"]))
    return report
