"""The matching scoreboard: how well our values put each home in front of the buyers who could
really afford it (Ryan, 2026-10-05: judge values by matching, not by "within 10%").

Adapted from the research's matching back-test (~/dev/nn-study/matching_sim.py, matching_export.py).
Homes are real recent sales (true price = sale price). Buyers are simulated: each buyer's top budget
U is a real sale price from the same group and months; a buyer fits a price P when P is inside the
budget stretched 15% each way, as DealFlow's matcher reads budgets. Each pair is scored the way the
live matcher scores an estimate-only seller: the chance the price fits, from lib/matching/sellerPrice.ts's
spread table, kept when the chance is at least 10%.

Three numbers per budget style:
- found:    real matches kept / all real matches;
- real:     real matches kept / all pairs kept;
- rank_auc: the chance a real match scores above a pair that isn't one ("the right buyer ranks first").
"""
from __future__ import annotations

import numpy as np

from . import config

STYLES = (("up_to", None), ("band25", 0.75), ("band10", 0.90))  # "up to $X", a 25%-wide band, a 10%-wide band


def spread_cdf(v: np.ndarray, p=config.SPREAD_P, q=config.SPREAD_Q) -> np.ndarray:
    """Share of sales with ln(price / estimate) at or below v (lib/matching/sellerPrice.ts spreadCdf)."""
    v = np.asarray(v, float)
    o = np.interp(v, q, p)
    return np.where(v < q[0], 0.0, np.where(v > q[-1], 1.0, o))


def rank_auc(score: np.ndarray, truth: np.ndarray) -> float:
    """Mann-Whitney AUC with ties counted half (equal to sklearn's roc_auc_score)."""
    s = score.ravel()
    t = truth.ravel().astype(bool)
    n1, n0 = int(t.sum()), int((~t).sum())
    if n1 == 0 or n0 == 0:
        return float("nan")
    order = np.argsort(s, kind="mergesort")
    ranks = np.empty(len(s))
    sorted_s = s[order]
    i = 0
    while i < len(s):  # average ranks over ties
        j = i
        while j + 1 < len(s) and sorted_s[j + 1] == sorted_s[i]:
            j += 1
        ranks[order[i:j + 1]] = (i + j) / 2 + 1
        i = j + 1
    return float((ranks[t].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def scoreboard(log_value: np.ndarray, log_price: np.ndarray, mask: np.ndarray, seed: int = config.SCOREBOARD_SEED,
               n_buyers: int = config.SCOREBOARD_BUYERS) -> dict:
    """The three numbers for each budget style, on the homes in `mask`."""
    m = mask & np.isfinite(log_value) & np.isfinite(log_price)
    E, P = log_value[m], log_price[m]
    out = {"homes": int(m.sum()), "buyers": n_buyers}
    if m.sum() < 30:
        return out
    rng = np.random.default_rng(seed)
    prices = np.exp(P)
    for name, band in STYLES:
        U = rng.choice(prices, n_buyers, replace=True)
        lo = np.full(n_buyers, -np.inf) if band is None else np.log(0.85 * band * U)
        hi = np.log(1.15 * U)
        truth = (P[:, None] >= lo[None]) & (P[:, None] <= hi[None])
        prob = spread_cdf(hi[None] - E[:, None]) - spread_cdf(lo[None] - E[:, None])
        kept = prob >= config.MIN_FIT_PROBABILITY
        tp = int((kept & truth).sum())
        out[name] = {"found": round(tp / max(int(truth.sum()), 1), 4), "real": round(tp / max(int(kept.sum()), 1), 4),
                     "rank_auc": round(rank_auc(prob, truth), 4)}
    return out


def spread_quantiles(log_value: np.ndarray, log_price: np.ndarray, mask: np.ndarray) -> list[float] | None:
    """This model's own 17-point spread table (ln(price / value) at sellerPrice.ts's probabilities),
    for PR 4's check that the live table still matches the published model."""
    m = mask & np.isfinite(log_value) & np.isfinite(log_price)
    if m.sum() < 100:
        return None
    return [round(float(x), 4) for x in np.quantile(log_price[m] - log_value[m], config.SPREAD_P)]
