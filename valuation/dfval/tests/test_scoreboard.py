import numpy as np

from valuation.dfval import config
from valuation.dfval.scoreboard import rank_auc, scoreboard, spread_cdf, spread_quantiles


def test_spread_cdf_matches_sellerprice_ts():
    q = config.SPREAD_Q
    assert spread_cdf(np.array([q[0] - 1]))[0] == 0.0
    assert spread_cdf(np.array([q[-1] + 1]))[0] == 1.0
    assert spread_cdf(np.array([q[8]]))[0] == 0.5  # the median knot
    mid = (q[4] + q[5]) / 2
    assert abs(spread_cdf(np.array([mid]))[0] - (config.SPREAD_P[4] + config.SPREAD_P[5]) / 2) < 1e-12


def test_rank_auc_against_brute_force():
    rng = np.random.default_rng(1)
    s = rng.integers(0, 5, 300).astype(float)
    t = rng.random(300) < 0.4
    pos, neg = s[t], s[~t]
    brute = np.mean([(a > b) + 0.5 * (a == b) for a in pos for b in neg])
    assert abs(rank_auc(s, t) - brute) < 1e-12


def test_scoreboard_rewards_better_values():
    rng = np.random.default_rng(2)
    price = np.log(rng.uniform(6e5, 3e6, 400))
    good = price + rng.normal(0, 0.05, 400)
    bad = price + rng.normal(0, 0.40, 400)
    m = np.ones(400, bool)
    g, b = scoreboard(good, price, m), scoreboard(bad, price, m)
    for style in ("up_to", "band25", "band10"):
        assert g[style]["rank_auc"] > b[style]["rank_auc"]
    assert g["homes"] == 400 and g["buyers"] == config.SCOREBOARD_BUYERS
    assert scoreboard(good, price, np.zeros(400, bool)) == {"homes": 0, "buyers": config.SCOREBOARD_BUYERS}


def test_spread_quantiles_shape():
    rng = np.random.default_rng(3)
    p = np.log(rng.uniform(6e5, 3e6, 500))
    q = spread_quantiles(p, p + rng.normal(0, 0.2, 500), np.ones(500, bool))
    assert len(q) == 17 and q == sorted(q)
    assert spread_quantiles(p, p, np.zeros(500, bool)) is None


def test_scoreboard_can_use_another_spread_table():
    rng = np.random.default_rng(4)
    price = np.log(rng.uniform(6e5, 3e6, 300))
    est = price + rng.normal(0, 0.1, 300)
    m = np.ones(300, bool)
    wide = [x * 3 for x in config.SPREAD_Q]
    assert scoreboard(est, price, m)["up_to"] != scoreboard(est, price, m, spread_q=wide)["up_to"]
    assert scoreboard(est, price, m, spread_q=list(config.SPREAD_Q)) == scoreboard(est, price, m)

