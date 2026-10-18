"""Repeat-sales price index per borough, with smoothed neighborhood deviations (research: bt_index.py).

Quarterly periods from 2003Q1. Fit only on pairs whose second sale is before the cutoff, so a
month's index never sees that month's sales (no leakage).
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.sparse import coo_matrix
from scipy.sparse.linalg import lsqr

Q0 = 2003


def qidx(d) -> pd.Series:
    d = pd.to_datetime(d)
    return (d.dt.year - Q0) * 4 + (d.dt.month - 1) // 3


def qidx1(d) -> int:
    d = pd.Timestamp(d)
    return (d.year - Q0) * 4 + (d.month - 1) // 3


def build_pairs(S: pd.DataFrame) -> pd.DataFrame:
    """Consecutive clean sales of the same lot: same unit-count group, 180+ days apart, size within 10%."""
    s = S[S["clean"]].sort_values(["bbl", "date"], kind="mergesort")[["bbl", "borough", "neighborhood", "grp", "date", "price", "sqft"]].copy()
    prev = s.groupby("bbl").shift(1)
    ok = prev["date"].notna() & (prev["grp"] == s["grp"]) & ((s["date"] - prev["date"]).dt.days >= 180)
    sq = (s["sqft"] / prev["sqft"]).abs()
    ok &= sq.isna() | ((sq > 0.9) & (sq < 1.1))
    P = pd.DataFrame({"bbl": s["bbl"], "borough": s["borough"], "nb": s["neighborhood"], "grp": s["grp"],
                      "t1": prev["date"], "t2": s["date"], "p1": prev["price"], "p2": s["price"]})[ok].copy()
    P["y"] = np.log(P["p2"] / P["p1"])
    P["q1"] = qidx(P["t1"])
    P["q2"] = qidx(P["t2"])
    P = P[(P["y"].abs() < np.log(6)) & (P["q2"] > P["q1"])]
    return P.reset_index(drop=True)


class Index:
    def __init__(self, beta, delta, nbs, qlast):
        self.beta, self.delta, self.nb_ix, self.qlast = beta, delta, {n: i for i, n in enumerate(nbs)}, qlast

    def level(self, nb, q):
        q = np.minimum(np.asarray(q), self.qlast)
        b = self.beta[q]
        i = self.nb_ix.get(nb)
        return b + (self.delta[i, q] if i is not None else 0.0)


def fit_borough(P, nq, lam_s=4.0, lam_d=2.0, lam_ds=40.0, trim=3.0):
    nbs = sorted(P["nb"].unique())
    nix = {n: i for i, n in enumerate(nbs)}
    nn = len(nbs)
    nb_i = P["nb"].map(nix).to_numpy()
    q1 = P["q1"].to_numpy()
    q2 = P["q2"].to_numpy()
    y = P["y"].to_numpy()
    keep = np.ones(len(P), bool)
    for it in range(2):
        k = np.flatnonzero(keep)
        m = len(k)
        # unknowns: beta[0..nq-1] (beta0 pinned by a heavy penalty), delta[n,q] at nq + n*nq + q
        r = np.repeat(np.arange(m), 4)
        c = np.stack([q2[k], q1[k], nq + nb_i[k] * nq + q2[k], nq + nb_i[k] * nq + q1[k]], 1).ravel()
        v = np.tile([1.0, -1.0, 1.0, -1.0], m)
        rows, cols, vals, rhs = [r], [c], [v], [y[k]]
        base = m
        rows.append(np.array([base]))
        cols.append(np.array([0]))
        vals.append(np.array([100.0]))
        rhs.append(np.zeros(1))
        base += 1
        qq = np.arange(1, nq - 1)  # second differences of beta
        rows += [np.repeat(base + np.arange(len(qq)), 3)]
        cols += [np.stack([qq - 1, qq, qq + 1], 1).ravel()]
        vals += [np.tile(np.sqrt(lam_s) * np.array([1.0, -2.0, 1.0]), len(qq))]
        rhs.append(np.zeros(len(qq)))
        base += len(qq)
        dcols = nq + np.arange(nn * nq)  # ridge on delta
        rows.append(base + np.arange(nn * nq))
        cols.append(dcols)
        vals.append(np.full(nn * nq, np.sqrt(lam_d)))
        rhs.append(np.zeros(nn * nq))
        base += nn * nq
        a = (nq + np.arange(nn)[:, None] * nq + np.arange(nq - 1)[None, :]).ravel()  # first differences of delta
        rows.append(np.repeat(base + np.arange(len(a)), 2))
        cols.append(np.stack([a, a + 1], 1).ravel())
        vals.append(np.tile(np.sqrt(lam_ds) * np.array([-1.0, 1.0]), len(a)))
        rhs.append(np.zeros(len(a)))
        base += len(a)
        A = coo_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(base, nq + nn * nq)).tocsr()
        x = lsqr(A, np.concatenate(rhs), atol=1e-8, btol=1e-8, iter_lim=20000)[0]
        beta, delta = x[:nq], x[nq:].reshape(nn, nq)
        if it == 0 and trim:
            pred = (beta[q2] - beta[q1]) + (delta[nb_i, q2] - delta[nb_i, q1])
            res = y - pred
            sig = 1.4826 * np.median(np.abs(res - np.median(res)))
            if sig > 0:  # identical residuals (hand-made data only) would otherwise trim every pair
                keep = np.abs(res) <= trim * sig
    return beta, delta, nbs


def fit_index(P: pd.DataFrame, cutoff: pd.Timestamp, **kw) -> dict[int, Index]:
    """Index per borough from pairs with the second sale strictly before `cutoff`."""
    Pc = P[P["t2"] < cutoff]
    qlast = qidx1(cutoff - pd.Timedelta(days=1))
    nq = qlast + 1
    out = {}
    for b, g in Pc.groupby("borough"):
        beta, delta, nbs = fit_borough(g, nq, **kw)
        out[int(b)] = Index(beta, delta, nbs, qlast)
    return out
