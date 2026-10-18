"""Settings for DealFlow's monthly valuation job (Brief 44).

The model is the valuation research's "DealFlow model today" (Briefs 39 and 39B, the
tighten-the-range and neural-net studies): gradient-boosted trees on free public records,
retrained each month on earlier sales only. Every number below comes from that research
unless it says otherwise. Rules are labelled by source: Ryan's instruction (with its date),
the law, a site's terms, or an engineering precaution.

This job never downloads anything. It reads the folder written by `valuation/fetch`
(Brief 44.1): `<data>/raw/<dataset-id>.parquet`, `<data>/raw/dof_annual/*.xls` and
`<data>/manifest.json`.
"""
from __future__ import annotations

import pandas as pd

# ---- Where results go ------------------------------------------------------------------
# DealFlow's own protected addresses. The job holds no database credentials (Brief 44 §5,
# engineering precaution); the key comes from the environment variable below.
DEALFLOW_URL = "https://dealflow-inbox-intelligence.vercel.app"
SECRET_ENV = "VALUATION_IMPORT_SECRET"
BATCH_SIZE = 200  # rows per request: Vercel caps a request body at 4.5 MB (lib/valuations/contract.ts)
USER_AGENT = "dealflow-valuation (monthly, read-only public records)"
REQUEST_TIMEOUT_S = 120

# Production inputs: model e + condition-clue groups G1, G2, G5, G8 + footprints (N4) +
# 421-a (N7) = 90 inputs. The research's 95th-input group, G6 (homeowners' mortgage and loan
# records), is left out (Brief 44 Revision 5, data minimization).
MODEL_VERSION = "gbm90-v1"

# ---- The data folder written by valuation/fetch --------------------------------------
DATASETS = {
    "sales_annual": "w2pb-icbu",
    "sales_rolling": "usep-8jbt",
    "pluto": "64uk-42ks",
    "acris_master": "bnx9-e6tj",
    "acris_legals": "8h5j-fqxa",
    "roll": "8y4t-faws",
    "dob_permits": "ipu4-2q9a",
    "dob_jobs": "ic3t-wcy2",
    "dobnow_jobs": "w9ak-ipjd",
    "dobnow_permits": "rbx6-tga4",
    "dobnow_electrical": "dm9a-ab7w",
    "dob_violations": "3h2n-5cm9",
    "ecb_violations": "6bgk-3dad",
    "hpd_violations": "wvxf-dwi5",
    "footprints": "5zhs-2jue",
    "exemptions": "muvi-b6kx",
    "stations": "39hk-dx4f",
}
BOROUGHS = (3, 4)  # Brooklyn and Queens: the research's area (Brief 44 §9 keeps the rest out)

# ---- Sales and the arm's-length screen ---------------------------------------------------
FLOOR_PRICE = 100_000  # a sale under $100k is not a market sale (research)
FAMILY_CLASSES = r"^(A\d|B\d|C0|C3)$"  # DOF classes the model covers: 1-4 family homes
ACRIS_START = pd.Timestamp("2022-07-01")  # deeds are matched from here (14 months before training starts)
ORDINARY_DEED = "DEED"
# Brief 44 revision 3: the production screen reads no names. A sale also has to be priced at
# least this share of the city's market value for its lot (the roll in effect before the sale).
# Chosen on the tuning year (Sep 2024-Aug 2025) as the cutoff with the most non-market sales caught
# minus ordinary sales dropped, measured once against the research's saved per-deed flags (which
# stay on the research Mac): at 30% it caught 84 of 703 flagged sales and dropped 76 of 12,063
# ordinary ones (README.md, "Reproduction check").
MIN_PRICE_TO_MARKET_VALUE = 0.30

# ---- Walk-forward training -----------------------------------------------------------------
T_ORIGIN = pd.Timestamp("2023-09-01")  # the research's training start and the zero of its time input
TRAIN_MAX_MONTHS = 48  # engineering precaution: the window stops growing after 4 years (Brief 44 revision 2)
MODEL_PARAMS = dict(
    loss="absolute_error", max_iter=600, max_leaf_nodes=63, learning_rate=0.05,
    min_samples_leaf=30, l2_regularization=1.0, random_state=0,
)

# The research's tuning and test years (the reproduction check runs on these).
RESEARCH_TUNE = (pd.Timestamp("2024-09-01"), pd.Timestamp("2025-09-01"))
RESEARCH_TEST = (pd.Timestamp("2025-09-01"), pd.Timestamp("2026-09-01"))

# Ryan's 8 focus neighborhoods, as DOF spells them.
TOP8 = ("BEDFORD STUYVESANT", "BUSHWICK", "CROWN HEIGHTS", "PARK SLOPE", "RIDGEWOOD", "OCEAN HILL", "GREENPOINT", "SUNSET PARK")

# ---- Comps (the research's tuned rule) -----------------------------------------------------
COMPS_RADIUS_MI = 0.5
COMPS_PRIMARY = (548, 8)   # within 548 days, at least 8 comps
COMPS_FALLBACK = (730, 3)  # else within 730 days, at least 3
COMPS_K = 40
COMPS_SIZE_BAND = 1.5      # building size within x1.5 either way
COMPS_POOL_DAYS = 740      # the pool reaches this far back before the subject's date
MAX_COMPS = 8              # nearby sales stored for the CRM card

# ---- One value and one range (Ryan, 2026-10-04: no buttons, one value + a tight range,
# sized to be right about 2 times in 3) ------------------------------------------------------
RANGE_COVER = 2 / 3
RANGE_TUNE_MONTHS = 12  # half-widths re-chosen each run on these months (Brief 44 revision 2)
GATE_MONTHS = 3         # the publish gates are checked on the 3 most recent complete months

# ---- Publish gates (engineering precautions, Brief 44 §5; DealFlow re-checks them) ---------
GATES = {
    "typical_miss_all": {"max": 0.115},
    "typical_miss_top8_2to4": {"max": 0.145},
    "range_coverage": {"min": 0.60, "max": 0.75},
    "sellers_valued": {"min": 1300},
}

# ---- The matching scoreboard (Ryan, 2026-10-05: judge values by matching) ------------------
SCOREBOARD_BUYERS = 400
SCOREBOARD_SEED = 20261005
MIN_FIT_PROBABILITY = 0.10  # lib/matching/sellerPrice.ts
# lib/matching/sellerPrice.ts's spread table: quantiles of ln(sale price / estimate).
SPREAD_P = [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.975, 0.99, 0.995]
SPREAD_Q = [-1.7143, -0.9961, -0.7201, -0.4395, -0.3039, -0.166, -0.0877, -0.0294, 0.0221, 0.0757, 0.1314, 0.19, 0.2925, 0.38, 0.5121, 0.6464, 0.7273]

NO_VALUE_REASONS = ("five_plus_units", "condo_without_unit", "not_found", "other_property_type")
