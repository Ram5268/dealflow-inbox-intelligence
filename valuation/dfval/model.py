"""The model: gradient-boosted trees on log price, retrained each month on earlier sales only
(research: cond_model.py / r2_model.py, "DealFlow model today").
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

from . import config

CATS = ["neighborhood", "grp", "bldg_class_sale", "zonedist1", "proxcode", "bsmtcode", "ext", "irrlotcode"]
BASE = ["borough", "neighborhood", "grp", "bldg_class_sale", "lat", "lon", "log_sqft", "log_land", "year_built", "res_units", "com_units",
        "lotfront", "lotdepth", "bldgfront", "bldgdepth", "numfloors", "builtfar", "residfar", "far_gap", "zonedist1", "proxcode", "bsmtcode", "ext", "irrlotcode",
        "hist", "lmk", "subway_mi", "log_mv", "mv_psf", "log_comps", "log_comps_ppsf", "comps_n", "comps_cod", "comps_n_1mi", "log_comps_plain",
        "log_rs", "rs_psf", "rs_years", "alt7_major_n", "alt7_n", "alt_since_prior_major", "yrs_since_major_alt", "t"]
KW = ["gut", "kitchen", "bath", "extension", "convert", "facade", "struct", "damage", "mech"]
GROUPS = {
    "G1": ["ps_years", "ps_changed", "ps_rel_ppsf"],
    "G2": [f"{k}_{w}" for k in ("pl", "el", "mech", "gc") for w in ("3y", "7y", "since_ps")],
    "G5": ["cost_max_7y", "cost_sum_7y", "cost_sum_since_ps", "cost_psf_7y", "n_major_7y", "n_minor_7y", "nb_10y", "demo_10y", "units_chg_7y"] + [f"kw_{k}_7y" for k in KW],
    # G6 (purchase/renovation loans) is the research's: homeowners' mortgage records. It is only ever
    # filled from the research's saved tables in the local reproduction check; production leaves it out
    # (Brief 44 revision 5, data minimization).
    "G6": ["ltv_purchase", "later_loans_n", "later_loan_max_ratio", "loan_7y_n", "loan_7y_max_ratio"],
    "G8": ["hpd_A_3y", "hpd_B_3y", "hpd_C_3y", "hpd_BC_open_at_sale", "dob_viol_3y", "dob_haz_7y", "ecb_3y", "ecb_class1_7y"],
    "N4": ["fp_area", "fp_gross_ratio", "fp_dims_ratio", "fp_height", "fp_n_bldgs"],
    "N7": ["exempt_421a"],
}
RESEARCH_FEATURES = BASE + [f for g in ("G1", "G2", "G5", "G6", "G8", "N4", "N7") for f in GROUPS[g]]   # 95
PRODUCTION_FEATURES = BASE + [f for g in ("G1", "G2", "G5", "G8", "N4", "N7") for f in GROUPS[g]]       # 90


def transform(X: pd.DataFrame) -> pd.DataFrame:
    """Derived inputs and category codes, as the research built them. Codes are assigned over all
    rows passed in at once (training, scoring and sellers together) so they agree across months."""
    X = X.copy()
    for c in ["lotfront", "lotdepth", "bldgfront", "bldgdepth", "builtfar", "residfar", "numfloors", "land_sqft", "sqft", "dof_mv",
              "comps_est", "comps_ppsf", "comps_plain", "rs_est"]:
        X[c] = pd.to_numeric(X[c], errors="coerce")
    X["t"] = (pd.to_datetime(X["date"]) - config.T_ORIGIN).dt.days
    with np.errstate(divide="ignore", invalid="ignore"):
        X["log_sqft"] = np.log(X["sqft"])
        X["log_land"] = np.log(X["land_sqft"].where(X["land_sqft"] > 0))
        X["log_mv"] = np.log(X["dof_mv"])
        X["mv_psf"] = np.log(X["dof_mv"] / X["sqft"])
        X["log_comps"] = np.log(X["comps_est"])
        X["log_comps_ppsf"] = np.log(X["comps_ppsf"])
        X["log_comps_plain"] = np.log(X["comps_plain"])
        X["log_rs"] = np.log(X["rs_est"])
        X["rs_psf"] = np.log(X["rs_est"] / X["sqft"])
    X["far_gap"] = X["residfar"] - X["builtfar"]
    X["hist"] = X["histdist"].notna().astype(int)
    X["lmk"] = X["landmark"].notna().astype(int)
    X["nb_raw"] = X["neighborhood"]
    X["grp_raw"] = X["grp"]
    for c in CATS:
        X[c] = X[c].astype(str).astype("category").cat.codes.astype("int16")
    return X


def fit(X: pd.DataFrame, rows: np.ndarray, y: np.ndarray, feats: list[str], **params) -> HistGradientBoostingRegressor:
    kw = dict(config.MODEL_PARAMS, **params)
    return HistGradientBoostingRegressor(categorical_features=[f in CATS for f in feats], **kw).fit(X.loc[rows, feats], y[rows])


def train_mask(X: pd.DataFrame, month: pd.Timestamp, max_months: int | None = config.TRAIN_MAX_MONTHS) -> np.ndarray:
    """Training rows for a month: priced sales before it, at most `max_months` back."""
    d = X["date"]
    tr = (d < month) & X["price"].notna()
    if max_months is not None:
        tr &= d >= month - pd.DateOffset(months=max_months)
    return tr.to_numpy()


def walk_forward(X: pd.DataFrame, months, feats: list[str], max_months: int | None = config.TRAIN_MAX_MONTHS, log=None) -> np.ndarray:
    """Out-of-sample log-price predictions for every row in `months`: one model per month,
    trained only on sales before that month."""
    y = np.log(X["price"].to_numpy(float))
    pred = np.full(len(X), np.nan)
    for m in months:
        m = pd.Timestamp(m)
        te = (X["month"] == m).to_numpy()
        if not te.any():
            continue
        mdl = fit(X, train_mask(X, m, max_months), y, feats)
        pred[te] = mdl.predict(X.loc[te, feats])
        if log:
            log(f"  month {m.date()}: trained on {int(train_mask(X, m, max_months).sum())}, scored {int(te.sum())}")
    return pred


def metrics(pred: np.ndarray, price: np.ndarray, mask: np.ndarray) -> dict:
    """Typical miss (median |value/price - 1|), shares within 5/10/20%, and the median bias."""
    m = mask & np.isfinite(pred)
    e = np.exp(pred[m] - np.log(price[m])) - 1
    a = np.abs(e)
    if not m.any():
        return {"n": 0}
    return {"n": int(m.sum()), "mdape": round(float(np.median(a)), 4), "w5": round(float((a <= .05).mean()), 3),
            "w10": round(float((a <= .10).mean()), 3), "w20": round(float((a <= .20).mean()), 3), "bias": round(float(np.median(e)), 4)}


def segments(X: pd.DataFrame) -> dict[str, np.ndarray]:
    grp = X["grp_raw"].astype(str).to_numpy()
    nb = X["nb_raw"].astype(str).to_numpy()
    two4 = np.isin(grp, ["2F", "3F", "4F"])
    return {"all": np.ones(len(X), bool), "two_to_four": two4, "top8_two_to_four": two4 & np.isin(nb, config.TOP8)}
