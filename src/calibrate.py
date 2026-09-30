"""
Check the fast queue model against the minute-by-minute simulation it replaces:
feed September 2026's actual arrivals and rosters to the queue model and compare
predicted waits and walkouts with what happened.
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

from config import POOLS, SERVICE_ORDER, HOLDOUT_START, BRANCHES
from daybuild import build_day
from engine import evaluate, home_plan

ROOT = Path(__file__).resolve().parents[1]
PROC, OUT = ROOT / "data" / "processed", ROOT / "outputs"


def main():
    tok = pd.read_csv(PROC / "tokens.csv.gz")
    tok = tok[tok["date"] >= HOLDOUT_START.isoformat()]
    hourly = tok.groupby(["branch", "date", "service", "hour"]).size()
    obs = tok.groupby(["branch", "date", "pool"]).agg(wait=("wait_min", "mean"), walkouts=("walkout", "sum"),
                                                      n=("token_id", "size")).reset_index()
    rows = []
    for (b, d), _ in tok.groupby(["branch", "date"]):
        lam = {s: [float(hourly.get((b, d, s, h), 0)) for h in range(10, 16)] for s in SERVICE_ORDER}
        day = build_day(b, d, lam)
        ev = evaluate(day, home_plan(day))
        for p in POOLS:
            o = obs[(obs.branch == b) & (obs.date == d) & (obs.pool == p)]
            if o.empty:
                continue
            rows.append(dict(branch=b, date=d, pool=p, obs_wait=float(o.wait.iloc[0]), model_wait=ev[p]["avg_wait_served"],
                             obs_walk=float(o.walkouts.iloc[0]), model_walk=ev[p]["walkouts"], n=int(o.n.iloc[0])))
    df = pd.DataFrame(rows)
    out = dict(
        pool_days=int(len(df)),
        wait_mae_min=round(float((df.obs_wait - df.model_wait).abs().mean()), 2),
        wait_corr=round(float(np.corrcoef(df.obs_wait, df.model_wait)[0, 1]), 3),
        walkout_total_obs=int(df.obs_walk.sum()), walkout_total_model=round(float(df.model_walk.sum()), 1),
        walkout_corr=round(float(np.corrcoef(df.obs_walk, df.model_walk)[0, 1]), 3),
        by_pool={p: dict(obs_wait=round(float(g.obs_wait.mean()), 2), model_wait=round(float(g.model_wait.mean()), 2),
                         obs_walk=int(g.obs_walk.sum()), model_walk=round(float(g.model_walk.sum()), 1))
                 for p, g in df.groupby("pool")},
    )
    df.to_csv(OUT / "queue_calibration.csv", index=False)
    json.dump(out, open(OUT / "queue_calibration.json", "w"), indent=1)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
