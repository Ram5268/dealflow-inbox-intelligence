"""Model inputs for every row: a past sale (training and scoring) or a CRM seller's home (as of
the run date). Each input uses only records dated before the row's date, so a sale is never
valued with information from after it (research: ml_features.py, cond_features.py, r2_features.py).

Production inputs (90): model e's 43 + condition-clue groups G1 (purchase price vs neighbors),
G2 (plumbing/electrical/mechanical permits), G5 (declared job cost and description keywords) and
G8 (violation severity) + N4 (building footprints) + N7 (421-a). The research's G6 (homeowners'
mortgage and loan records) is left out: Brief 44 revision 5, data minimization.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

from . import config
from .frame import roll_for, roll_releases
from .index import build_pairs, fit_index, qidx, qidx1

LAT0 = 40.68
Y3, Y7, Y10 = pd.Timedelta(days=1096), pd.Timedelta(days=2557), pd.Timedelta(days=3652)
ALT_JOB_TYPES = ["Alteration", "Alteration CO", "ALT-CO - New Building with Existing Elements to Remain"]
MAJOR_NOW_TYPES = ["Alteration CO", "ALT-CO - New Building with Existing Elements to Remain"]
MAJOR_WORK = ["General Construction", "Structural", "Foundation"]


def xy(lat, lon) -> np.ndarray:
    """Miles on a flat map centred on Brooklyn (accurate to well under 1% across BK+QN)."""
    return np.c_[(np.asarray(lon, float) + 73.95) * 69.17 * np.cos(np.radians(LAT0)), (np.asarray(lat, float) - LAT0) * 69.0]


def dt(s, fmt=None) -> pd.Series:
    return pd.to_datetime(s, format=fmt, errors="coerce")


class _NoIndex:
    """Stands in for a borough with no repeat-sale pairs yet (hand-made data): no time adjustment."""
    qlast = 0

    @staticmethod
    def level(nb, q):
        return np.zeros(np.shape(q)) if np.ndim(q) else 0.0


def _ix(IDX: dict, month, borough):
    return IDX[month].get(int(borough))


def month_indexes(S: pd.DataFrame, months) -> dict:
    """A leak-free price index for each month: fitted on sale pairs before that month."""
    P = build_pairs(S)
    return {pd.Timestamp(m): fit_index(P, pd.Timestamp(m)) for m in sorted({pd.Timestamp(m) for m in months})}


# ---------------------------------------------------------------------------------------------
# Model e's inputs (ml_features.py)
# ---------------------------------------------------------------------------------------------
def alteration_events(bis: pd.DataFrame, nj: pd.DataFrame, npm: pd.DataFrame) -> pd.DataFrame:
    """DOB alteration permits (BIS A1-A3 + DOB NOW alteration jobs), each with a 'major' flag."""
    b = bis.copy()
    b["d"] = dt(b["issuance_date"], "%m/%d/%Y")
    b["major"] = b["job_type"].isin(["A1", "A2"])
    j = nj.assign(base=nj["job_filing_number"].str.split("-").str[0])
    p = npm.assign(base=npm["job_filing_number"].str.split("-").str[0])
    p = p.merge(j.drop_duplicates("base")[["base", "job_type"]], on="base", how="left")
    p["d"] = dt(p["issued_date"])
    p = p[p["job_type"].isin(ALT_JOB_TYPES)]
    p["major"] = p["job_type"].isin(MAJOR_NOW_TYPES) | p["work_type"].isin(MAJOR_WORK)
    return pd.concat([b[["bbl", "d", "major"]], p[["bbl", "d", "major"]]]).dropna(subset=["d"])


def base_features(X: pd.DataFrame, S: pd.DataFrame, IDX: dict, roll: pd.DataFrame, pluto: pd.DataFrame,
                  stations: pd.DataFrame, alt: pd.DataFrame, comps_out: dict | None = None) -> pd.DataFrame:
    """Model e's inputs. With `comps_out`, the nearby sales behind each seller row's comps value are
    put there (row position -> the comps used, nearest first), for the CRM card."""
    X = X.copy()
    keep = X["is_seller"].to_numpy(bool) if (comps_out is not None and "is_seller" in X) else np.zeros(len(X), bool)
    # ---- repeat sales: the lot's last clean sale, moved by the neighborhood index
    C = S[S["clean"]].sort_values("date", kind="mergesort")[["bbl", "date", "price", "grp", "sqft"]]
    hist = {b: g for b, g in C.groupby("bbl")}
    rs = []
    for r in X.itertuples():
        g = hist.get(r.bbl)
        out = (np.nan, np.nan, pd.NaT)
        if g is not None:
            g = g[g["date"] < r.date]
            if len(g):
                last = g.iloc[-1]
                ix = _ix(IDX, r.month, r.borough)
                if ix is not None and last["grp"] == r.grp and (pd.isna(last["sqft"]) or pd.isna(r.sqft) or abs(last["sqft"] / r.sqft - 1) <= 0.10):
                    est = last["price"] * np.exp(ix.level(r.neighborhood, ix.qlast) - ix.level(r.neighborhood, qidx1(last["date"])))
                    out = (est, (r.date - last["date"]).days / 365.25, last["date"])
        rs.append(out)
    X["rs_est"] = [x[0] for x in rs]
    X["rs_years"] = [x[1] for x in rs]
    X["rs_t0"] = pd.to_datetime([x[2] for x in rs])
    # ---- the city's market value on the roll in effect before the date (class-1 homes only)
    R = roll[roll["mv"] > 0]
    rel = roll_releases(sorted(R["year"].unique()))
    mvmap = {(p, y, q): v for p, y, q, v in zip(R["parid"], R["year"], R["period"], R["mv"])}
    X["class1"] = X["tax_class_sale"].astype(str).str.startswith("1") & (X["grp"] != "4F")
    mv = []
    for b, d, c1 in zip(X["bbl"], X["date"], X["class1"]):
        rl = roll_for(d, rel) if c1 else None
        mv.append(mvmap.get((b, rl[0], rl[1]), np.nan) if rl else np.nan)
    X["dof_mv"] = mv
    # ---- comps (tuned rule: 0.5 mi, 548 days, >= 8 comps, 40 nearest, time-adjusted, size within x1.5;
    #      fallback >= 3 comps within 730 days)
    lo = X["date"].min() - pd.Timedelta(days=config.COMPS_POOL_DAYS)
    pool = S[S["clean"] & S["sqft"].notna() & S["lat"].notna() & (S["date"] >= lo)].copy()
    pool["ppsf"] = pool["price"] / pool["sqft"]
    pool = pool[(pool["ppsf"] > 30) & (pool["ppsf"] < 5000)]
    pool["q"] = qidx(pool["date"])
    feat = {k: np.full(len(X), np.nan) for k in ["comps_est", "comps_n", "comps_cod", "comps_ppsf", "comps_plain", "comps_n_1mi"]}
    for grp, pg in pool.groupby("grp"):
        pg = pg.reset_index(drop=True)
        pxy = xy(pg["lat"], pg["lon"])
        tree = cKDTree(pxy)
        sel = np.flatnonzero((X["grp"] == grp).to_numpy() & X["sqft"].notna().to_numpy() & X["lat"].notna().to_numpy())
        if not len(sel):
            continue
        sxy = xy(X["lat"].to_numpy()[sel], X["lon"].to_numpy()[sel])
        hits = tree.query_ball_point(sxy, 1.0)
        pdate = pg["date"].to_numpy()
        pbbl = pg["bbl"].to_numpy()
        pppsf = pg["ppsf"].to_numpy()
        psq = pg["sqft"].to_numpy()
        pq = pg["q"].to_numpy()
        for i, h, s_xy in zip(sel, hits, sxy):
            h = np.asarray(h, int)
            if not len(h):
                continue
            r_date, r_bbl, r_sqft = X["date"].iat[i], X["bbl"].iat[i], X["sqft"].iat[i]
            days = (np.datetime64(r_date) - pdate[h]).astype("timedelta64[D]").astype(int)
            ok = (days > 0) & (days <= 730) & (pbbl[h] != r_bbl)
            h, days = h[ok], days[ok]
            if not len(h):
                continue
            dist = np.hypot(*(pxy[h] - s_xy).T)
            o = np.argsort(dist, kind="stable")
            h, days, dist = h[o], days[o], dist[o]
            feat["comps_n_1mi"][i] = len(h)
            nb = X["neighborhood"].iat[i]
            ix = _ix(IDX, X["month"].iat[i], X["borough"].iat[i]) or _NoIndex
            lv = ix.level(nb, ix.qlast)
            size_ok = np.abs(np.log(psq[h] / r_sqft)) <= np.log(config.COMPS_SIZE_BAND)
            for w, mn in (config.COMPS_PRIMARY, config.COMPS_FALLBACK):
                m = np.flatnonzero((dist <= config.COMPS_RADIUS_MI) & (days <= w) & size_ok)
                if len(m) >= mn:
                    m = m[:config.COMPS_K]
                    v = pppsf[h[m]] * np.exp(lv - ix.level(nb, pq[h[m]]))
                    med = np.median(v)
                    feat["comps_est"][i] = med * r_sqft
                    feat["comps_n"][i] = len(m)
                    feat["comps_cod"][i] = np.mean(np.abs(v - med)) / med
                    feat["comps_ppsf"][i] = med
                    if keep[i]:
                        sub = pg.iloc[h[m]][["address", "date", "price", "sqft", "ppsf"]].copy()
                        sub["dist"] = dist[m]
                        comps_out[i] = sub
                    break
            m = np.flatnonzero((dist <= config.COMPS_RADIUS_MI) & (days <= 365))
            if len(m) >= 3:
                feat["comps_plain"][i] = np.median(pppsf[h[m[:config.COMPS_K]]]) * r_sqft
    for k, v in feat.items():
        X[k] = v
    # ---- PLUTO's lot and building measures, zoning and codes
    PX = pluto[["bbl", "lotfront", "lotdepth", "bldgfront", "bldgdepth", "builtfar", "residfar", "zonedist1", "histdist", "landmark",
                "proxcode", "irrlotcode", "bsmtcode", "ext"]].copy()
    for c in ["lotfront", "lotdepth", "bldgfront", "bldgdepth", "builtfar", "residfar"]:
        PX[c] = pd.to_numeric(PX[c], errors="coerce")
    X = X.merge(PX, on="bbl", how="left")
    X = X.merge(pluto[["bbl", "numfloors", "lotarea", "yearalter1", "yearalter2"]], on="bbl", how="left")
    # ---- nearest subway station (MTA list, data.ny.gov; Ryan approved it on 2026-10-17)
    stree = cKDTree(xy(stations["lat"], stations["lon"]))
    X["subway_mi"] = stree.query(xy(X["lat"], X["lon"]))[0]
    # ---- alteration permits
    Ab = {b: g for b, g in alt.groupby("bbl")}
    pf = []
    for r in X.itertuples():
        g = Ab.get(r.bbl)
        if g is None:
            pf.append((0, 0, 0, np.nan))
            continue
        g = g[g["d"] < r.date]
        w7 = g[g["d"] >= r.date - pd.Timedelta(days=2557)]
        since = g[g["d"] > r.rs_t0] if pd.notna(r.rs_t0) else g.iloc[0:0]
        last_major = g[g["major"]]["d"].max()
        pf.append((int(w7["major"].sum()), len(w7), int(since["major"].sum()),
                   (r.date - last_major).days / 365.25 if pd.notna(last_major) else np.nan))
    X["alt7_major_n"] = [p[0] for p in pf]
    X["alt7_n"] = [p[1] for p in pf]
    X["alt_since_prior_major"] = [p[2] for p in pf]
    X["yrs_since_major_alt"] = [p[3] for p in pf]
    X["alt7_major"] = X["alt7_major_n"] > 0
    return X


# ---------------------------------------------------------------------------------------------
# Condition clues (cond_features.py): G1, G2, G5, G8
# ---------------------------------------------------------------------------------------------
def events(df: pd.DataFrame, bcol: str, dcol: str) -> dict:
    df = df[[bcol, dcol]].dropna()
    return {b: np.sort(pd.to_datetime(g[dcol]).values.astype("int64")) for b, g in df.groupby(bcol)}


def count_window(X: pd.DataFrame, ev: dict, lo_off: pd.Timedelta | None = None, since: bool = False) -> np.ndarray:
    """Events strictly between the window start (or the prior sale) and the row's date."""
    t_ns = X["date"].values.astype("datetime64[ns]").astype("int64")
    ps_na = X["ps_date"].isna().to_numpy()
    ps_ns = X["ps_date"].values.astype("datetime64[ns]").astype("int64")
    out = np.zeros(len(X))
    off = lo_off.value if lo_off is not None else None
    for i, (b, t) in enumerate(zip(X["bbl"].to_numpy(), t_ns)):
        if since and ps_na[i]:
            out[i] = np.nan
            continue
        a = ev.get(b)
        if a is None:
            continue
        lo = (t - off) if off is not None else ps_ns[i]
        out[i] = max(np.searchsorted(a, t, "left") - np.searchsorted(a, lo, "right"), 0)
    return out


KW = {"gut": r"\bGUT\b|FULL (?:INTERIOR )?RENOVATION|COMPLETE RENOVATION|TOTAL RENOVATION|RENOVATION OF (?:THE )?(?:ENTIRE|ALL)|INTERIOR RENOVATION|RENOVATE",
      "kitchen": r"KITCHEN", "bath": r"BATH", "extension": r"EXTENSION|ENLARGE|ADDITION|VERTICAL|HORIZONTAL|NEW STORY|NEW FLOOR",
      "convert": r"CONVER|COMBIN|CHANGE OF (?:USE|OCCUPANCY)|LEGALIZ", "facade": r"FACADE|WINDOW|BRICK|POINTING|STOOP|CORNICE|MASONRY",
      "struct": r"UNDERPIN|STRUCTURAL|BEAM|JOIST|FOUNDATION", "damage": r"FIRE|DAMAGE|COLLAPSE|VACATE|UNSAFE", "mech": r"BOILER|HVAC|HEAT PUMP|SOLAR|SPRINKLER|GAS"}


def cond_features(X: pd.DataFrame, S: pd.DataFrame, bis: pd.DataFrame, npm: pd.DataFrame, el: pd.DataFrame,
                  bj: pd.DataFrame, nj: pd.DataFrame, hv: pd.DataFrame, dv: pd.DataFrame, ecb: pd.DataFrame) -> pd.DataFrame:
    """Returns the clue columns; also adds ps_date/ps_price/ps_sqft/ps_grp to X (the prior sale)."""
    feat = pd.DataFrame(index=X.index)
    # ---- G1: the prior purchase's $/sq ft vs neighbours at the time (+ building changed since)
    Sc = S[S["clean"]].sort_values("date", kind="mergesort")
    hist = {b: g for b, g in Sc.groupby("bbl")}
    ps = []
    for r in X.itertuples():
        g = hist.get(r.bbl)
        if g is None:
            ps.append((pd.NaT, np.nan, np.nan, None))
            continue
        g = g[g["date"] < r.date]
        if not len(g):
            ps.append((pd.NaT, np.nan, np.nan, None))
            continue
        last = g.iloc[-1]
        ps.append((last["date"], last["price"], last["sqft"], last["grp"]))
    X["ps_date"] = pd.to_datetime([p[0] for p in ps])
    X["ps_price"] = [p[1] for p in ps]
    X["ps_sqft"] = [p[2] for p in ps]
    X["ps_grp"] = [p[3] for p in ps]
    feat["ps_years"] = (X["date"] - X["ps_date"]).dt.days / 365.25
    feat["ps_changed"] = np.where(X["ps_date"].isna(), np.nan,
                                  ((X["ps_grp"] != X["grp"]) | ((X["ps_sqft"] / X["sqft"] - 1).abs() > 0.10)).astype(float))
    pool = Sc[Sc["sqft"].notna() & Sc["lat"].notna()].copy()
    pool["lppsf"] = np.log(pool["price"] / pool["sqft"])
    z0 = np.full(len(X), np.nan)
    need = X[X["ps_date"].notna() & X["ps_sqft"].notna()]
    for grp, pg in pool.groupby("grp"):
        pg = pg.reset_index(drop=True)
        tree = cKDTree(xy(pg["lat"], pg["lon"]))
        q = need[need["ps_grp"] == grp]
        if not len(q):
            continue
        hits = tree.query_ball_point(xy(q["lat"], q["lon"]), 0.5)
        pd_ = pg["date"].to_numpy()
        pl = pg["lppsf"].to_numpy()
        pb = pg["bbl"].to_numpy()
        for (i, r), h in zip(q.iterrows(), hits):
            h = np.asarray(h, int)
            if not len(h):
                continue
            ok = (pd_[h] < np.datetime64(r["ps_date"])) & (pd_[h] >= np.datetime64(r["ps_date"] - pd.Timedelta(days=365))) & (pb[h] != r["bbl"])
            if ok.sum() >= 5:
                z0[X.index.get_loc(i)] = np.log(r["ps_price"] / r["ps_sqft"]) - np.median(pl[h[ok]])
    feat["ps_rel_ppsf"] = z0
    # ---- G2: plumbing / electrical / mechanical / general-construction permits
    b = bis.assign(d=dt(bis["issuance_date"], "%m/%d/%Y"))
    p = npm.assign(d=dt(npm["issued_date"]))
    e = el.assign(d=dt(el["permit_issued_date"]).fillna(dt(el["filing_date"])), bbl=el["bbl_key"])
    EV = {"pl": events(pd.concat([b[b["work_type"] == "PL"][["bbl", "d"]], p[p["work_type"] == "Plumbing"][["bbl", "d"]]]), "bbl", "d"),
          "el": events(e, "bbl", "d"),
          "mech": events(p[p["work_type"].isin(["Mechanical Systems", "Boiler Equipment"])][["bbl", "d"]], "bbl", "d"),
          "gc": events(pd.concat([b[b["work_type"].isin(["OT", "EQ"]) & b["job_type"].isin(["A1", "A2"])][["bbl", "d"]],
                                  p[p["work_type"].isin(MAJOR_WORK)][["bbl", "d"]]]), "bbl", "d")}
    for k, ev in EV.items():
        feat[f"{k}_3y"] = count_window(X, ev, Y3)
        feat[f"{k}_7y"] = count_window(X, ev, Y7)
        feat[f"{k}_since_ps"] = count_window(X, ev, since=True)
    # ---- G5: declared job cost + description keywords (jobs permitted before the date)
    j1 = bj.copy()
    j1["d"] = dt(j1["fully_permitted"], "%m/%d/%Y").fillna(dt(j1["approved"], "%m/%d/%Y")).fillna(dt(j1["pre__filing_date"], "%m/%d/%Y"))
    j1["cost"] = pd.to_numeric(j1["initial_cost"].astype(str).str.replace(r"[$,]", "", regex=True), errors="coerce")
    j1["units_chg"] = (pd.to_numeric(j1["proposed_dwelling_units"], errors="coerce") - pd.to_numeric(j1["existing_dwelling_units"], errors="coerce")).abs()
    j1["kind"] = j1["job_type"].map({"A1": "major", "A2": "major", "A3": "minor", "NB": "nb", "DM": "demo"})
    j2 = nj.copy()
    j2["d"] = dt(j2["first_permit_date"]).fillna(dt(j2["approved_date"])).fillna(dt(j2["filing_date"]))
    j2["cost"] = pd.to_numeric(j2["initial_cost"], errors="coerce")
    j2["units_chg"] = (pd.to_numeric(j2["proposed_dwelling_units"], errors="coerce") - pd.to_numeric(j2["existing_dwelling_units"], errors="coerce")).abs()
    j2["kind"] = j2["job_type"].map({"Alteration": "major", "Alteration CO": "major", "ALT-CO - New Building with Existing Elements to Remain": "major",
                                     "New Building": "nb", "Full Demolition": "demo", "No Work": None})
    J = pd.concat([j1[["bbl", "d", "cost", "units_chg", "kind", "job_description"]], j2[["bbl", "d", "cost", "units_chg", "kind", "job_description"]]], ignore_index=True)
    J = J[J["d"].notna() & J["kind"].notna()]
    J["desc"] = J["job_description"].fillna("").astype(str).str.upper().str.replace("&AMP;", "&", regex=False)
    for k, pat in KW.items():
        J[f"kw_{k}"] = J["desc"].str.contains(pat, regex=True)
    Jb = {k: g.sort_values("d", kind="mergesort") for k, g in J.groupby("bbl")}
    cols = ["cost_max_7y", "cost_sum_7y", "cost_sum_since_ps", "n_major_7y", "n_minor_7y", "nb_10y", "demo_10y", "units_chg_7y"] + [f"kw_{k}_7y" for k in KW]
    vals = {c: np.full(len(X), np.nan) for c in cols}
    for i, (bb, t, s) in enumerate(zip(X["bbl"], X["date"], X["ps_date"])):
        g = Jb.get(bb)
        if g is None:
            for c in cols:
                vals[c][i] = 0.0
            continue
        w = g[(g["d"] < t) & (g["d"] >= t - Y7)]
        w10 = g[(g["d"] < t) & (g["d"] >= t - Y10)]
        vals["cost_max_7y"][i] = w["cost"].max() if len(w) else 0.0
        vals["cost_sum_7y"][i] = w["cost"].sum() if len(w) else 0.0
        vals["cost_sum_since_ps"][i] = g[(g["d"] < t) & (g["d"] > s)]["cost"].sum() if not pd.isna(s) else np.nan
        vals["n_major_7y"][i] = (w["kind"] == "major").sum()
        vals["n_minor_7y"][i] = (w["kind"] == "minor").sum()
        vals["nb_10y"][i] = (w10["kind"] == "nb").sum()
        vals["demo_10y"][i] = (w10["kind"] == "demo").sum()
        vals["units_chg_7y"][i] = w["units_chg"].max() if len(w) and w["units_chg"].notna().any() else 0.0
        for k in KW:
            vals[f"kw_{k}_7y"][i] = float(w[f"kw_{k}"].any()) if len(w) else 0.0
    for c in cols:
        feat[c] = vals[c]
    feat["cost_psf_7y"] = feat["cost_sum_7y"] / X["sqft"]
    # ---- G8: violation severity (HPD classes, DOB hazardous, ECB class)
    h = hv.copy()
    h["d"] = dt(h["novissueddate"]).fillna(dt(h["inspectiondate"]))
    h["cd"] = dt(h["currentstatusdate"])
    h["closed_d"] = h["cd"].where(h["violationstatus"] == "Close")
    for cl in ["A", "B", "C"]:
        feat[f"hpd_{cl}_3y"] = count_window(X, events(h[h["class"] == cl], "bbl", "d"), Y3)
    hvo = h[h["class"].isin(["B", "C"])][["bbl", "d", "closed_d"]].dropna(subset=["d"])
    hvb = {k: (g["d"].to_numpy(), g["closed_d"].to_numpy()) for k, g in hvo.groupby("bbl")}
    op = np.zeros(len(X))
    for i, (bb, t) in enumerate(zip(X["bbl"], X["date"].to_numpy())):
        v = hvb.get(bb)
        if v is None:
            continue
        d0, d1 = v
        op[i] = int(((d0 < t) & (pd.isna(d1) | (d1 > t))).sum())
    feat["hpd_BC_open_at_sale"] = op
    d = dv.assign(bbl=dv["bbl_key"], d=dt(dv["issue_date"], "%Y%m%d"))
    d["haz"] = d["violation_category"].fillna("").str.contains(r"^VH|^VWH|HAZARDOUS", regex=True)
    feat["dob_viol_3y"] = count_window(X, events(d, "bbl", "d"), Y3)
    feat["dob_haz_7y"] = count_window(X, events(d[d["haz"]], "bbl", "d"), Y7)
    ec = ecb.assign(bbl=ecb["bbl_key"], d=dt(ecb["issue_date"], "%Y%m%d"))
    sev = ec["severity"].fillna("")
    feat["ecb_3y"] = count_window(X, events(ec, "bbl", "d"), Y3)
    feat["ecb_class1_7y"] = count_window(X, events(ec[sev.str.contains("1|HAZARD", regex=True) & ~sev.str.contains("NON", regex=False)], "bbl", "d"), Y7)
    return feat


# ---------------------------------------------------------------------------------------------
# N4 building footprints and N7 421-a (r2_features.py)
# ---------------------------------------------------------------------------------------------
def r2_features(X: pd.DataFrame, pluto: pd.DataFrame, fp: pd.DataFrame, ex421: pd.DataFrame) -> pd.DataFrame:
    F = pd.DataFrame(index=X.index)
    FP = fp.copy()
    FP["area_sqft"] = pd.to_numeric(FP["shape_area"], errors="coerce") * 10.7639
    FP["h"] = pd.to_numeric(FP["height_roof"], errors="coerce")
    FP["edited"] = pd.to_datetime(FP["last_edited_date"], errors="coerce", utc=True).dt.tz_convert(None)
    fpb = {b: g for b, g in FP.groupby("base_bbl")}
    PB = pluto.set_index("bbl")[["bldgarea", "numfloors", "bldgfront", "bldgdepth"]].copy()
    for c in ["bldgfront", "bldgdepth"]:
        PB[c] = pd.to_numeric(PB[c], errors="coerce")
    cols = {c: np.full(len(X), np.nan) for c in ["fp_area", "fp_gross_ratio", "fp_dims_ratio", "fp_height", "fp_n_bldgs"]}
    for i, (b, d) in enumerate(zip(X["bbl"], X["date"])):
        g = fpb.get(b)
        if g is None or b not in PB.index:
            continue
        if (g["edited"] > d).any() or not g["area_sqft"].notna().any():  # edited after the date: could know later work
            continue
        p = PB.loc[b]
        main = g.loc[g["area_sqft"].idxmax()]
        cols["fp_area"][i] = g["area_sqft"].sum()
        cols["fp_n_bldgs"][i] = len(g)
        cols["fp_height"][i] = main["h"]
        if p["bldgarea"] and p["bldgarea"] > 0 and p["numfloors"] and p["numfloors"] > 0:
            cols["fp_gross_ratio"][i] = main["area_sqft"] * p["numfloors"] / p["bldgarea"]
        if p["bldgfront"] and p["bldgdepth"] and p["bldgfront"] > 0 and p["bldgdepth"] > 0:
            cols["fp_dims_ratio"][i] = main["area_sqft"] / (p["bldgfront"] * p["bldgdepth"])
    for c, v in cols.items():
        F[c] = v
    # 421-a exemption on the roll in effect (exemption codes only, never a personal exemption).
    exb = set(zip(ex421["parid"], ex421["year"].astype(int)))
    rel = roll_releases(sorted(ex421["year"].astype(int).unique()))
    F["exempt_421a"] = [float((b, rl[0]) in exb) if (rl := roll_for(t, rel)) else 0.0 for b, t in zip(X["bbl"], X["date"])]
    return F
