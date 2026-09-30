"""
Before / after backtest on September 2026 (the forecast holdout month).

For every branch-day we take the forecast made without seeing September,
build the plan exactly as we would the evening before, and replay the SAME
customers (same arrival times, service times and patience) through the
minute-by-minute simulator twice:
  status quo  - everyone at their home counter, usual lunch
  with plan   - redirection, appointment moves, re-deployment, lunch timing
Staff lent between branches are excluded here, so the result is conservative.
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

from config import STAFF, REDIRECT, SERVICE_ORDER, BRANCHES, POOLS, MANAGERS
from daybuild import build_day
from engine import lunch_intervals
from recommend import build_plan, load_context
from simulator import simulate_day, default_lunch

ROOT = Path(__file__).resolve().parents[1]
OUT, TRUTH, PROC = ROOT / "outputs", ROOT / "data" / "sim_truth", ROOT / "data" / "processed"
CFG = {s["id"]: s for s in STAFF}


def status_quo(day):
    by_pool = {}
    for sid, st in day["staff"].items():
        by_pool.setdefault(st["home"], []).append(sid)
    lunch = default_lunch(by_pool)
    return [dict(id=sid, blocks=[(0, 10 ** 6, st["home"])], lunch=lunch.get(sid),
                 factor=CFG[sid]["skills"] if sid in CFG else st["factor"]) for sid, st in day["staff"].items()]


def planned(day, plan, policy):
    lunch = lunch_intervals(plan, list(plan), policy)
    return [dict(id=sid, blocks=[(0, 180, a["AM"]), (180, 10 ** 6, a["PM"])], lunch=lunch.get(sid),
                 factor=CFG[sid]["skills"] if sid in CFG else day["staff"][sid]["factor"]) for sid, a in plan.items()]


def run(c, staff_plan, outage):
    res = simulate_day(dict(arrival=c["arrival"].to_numpy(), pool=c["pool"].to_numpy(), prio=c["prio"].to_numpy(),
                            base_dur=c["base_dur"].to_numpy(), patience=c["patience"].to_numpy()), staff_plan, outage)
    served = ~res["left"]
    w = res["start"][served] - c["arrival"].to_numpy()[served]
    ot = max(0.0, np.nanmax(res["end"]) - 360) if served.any() else 0.0
    return dict(n=len(c), served=int(served.sum()), walkouts=int(res["left"].sum()), avg_wait=float(np.mean(w)) if len(w) else 0.0,
                p90_wait=float(np.percentile(w, 90)) if len(w) else 0.0, overtime=float(ot),
                sla_breach=float(np.mean(w > 15)) if len(w) else 0.0)


def main():
    cust = pd.read_csv(TRUTH / "customers_holdout.csv.gz")
    outages = pd.read_csv(TRUTH / "outages.csv")
    hh = pd.read_csv(OUT / "holdout_hourly.csv.gz")
    ctx = load_context()
    ap = ctx["appts"]
    rows = []
    for (b, d), c in cust.groupby(["branch_code", "date"]):
        c = c.sort_values("arrival").reset_index(drop=True)
        f = hh[(hh["branch"] == b) & (hh["date"] == d)]
        lam = {s: [float(f[(f["service"] == s) & (f["hour"] == h)]["pred"].sum()) for h in range(10, 16)] for s in SERVICE_ORDER}
        day = build_day(b, d, lam)
        o = outages[(outages["branch"] == b) & (outages["date"] == d)]
        outage = (float(o.start_min.iloc[0]), float(o.end_min.iloc[0]), 1.8) if len(o) else None
        steps, levers, plan, _, _, _ = build_plan(day, ctx, None, ap[(ap["branch_code"] == b) & (ap["slot_date"] == d)], d,
                                                  include_experience=False)
        base = run(c, status_quo(day), outage)

        # staffing only
        staff_only = run(c, planned(day, plan, levers.get("lunch", "standard")), outage)

        # full plan: remove customers who accept a self-service / digital channel, move rescheduled appointments
        keep = np.ones(len(c), dtype=bool)
        moved = 0
        for s, frac in levers.get("redirect", {}).items():
            r = REDIRECT[s]
            elig = (c["service"] == s) & (c["digital"] | (not r["needs_digital"]))
            go = elig & (c["redirect_u"] < r["share"] * r["accept"])
            keep &= ~go.to_numpy()
            moved += int(go.sum())
        c2 = c[keep].copy()
        for m in levers.get("reschedule", []):
            idx = c2[(c2["service"] == m["service"]) & c2["appt"] & ((c2["arrival"] // 60) == m["from_hour"])].index[:int(round(m["count"]))]
            c2.loc[idx, "arrival"] = m["to_hour"] * 60 + c2.loc[idx, "arrival"] % 60
        c2 = c2.sort_values("arrival").reset_index(drop=True)
        full = run(c2, planned(day, plan, levers.get("lunch", "standard")), outage)
        full["walkouts_total"] = full["walkouts"]
        rows.append(dict(branch=b, date=d, customers=len(c), redirected=moved,
                         **{f"base_{k}": v for k, v in base.items()}, **{f"staff_{k}": v for k, v in staff_only.items()},
                         **{f"plan_{k}": v for k, v in full.items()}))
    df = pd.DataFrame(rows)
    df.to_csv(OUT / "backtest_daily.csv", index=False)

    def wavg(col, wcol):
        return float((df[col] * df[wcol]).sum() / df[wcol].sum())

    busiest = df.sort_values("customers", ascending=False).groupby("branch").head(3)
    summ = dict(
        period="1-30 Sep 2026 (forecast holdout)", branch_days=int(len(df)), customers=int(df["customers"].sum()),
        avg_wait=dict(before=wavg("base_avg_wait", "base_served"), staffing_only=wavg("staff_avg_wait", "staff_served"),
                      full_plan=wavg("plan_avg_wait", "plan_served")),
        walkouts=dict(before=int(df["base_walkouts"].sum()), staffing_only=int(df["staff_walkouts"].sum()), full_plan=int(df["plan_walkouts"].sum())),
        sla_breach_share=dict(before=wavg("base_sla_breach", "base_served"), full_plan=wavg("plan_sla_breach", "plan_served")),
        overtime_hours=dict(before=round(df["base_overtime"].sum() / 60, 1), full_plan=round(df["plan_overtime"].sum() / 60, 1)),
        redirected_customers=int(df["redirected"].sum()),
        busiest_days=dict(avg_wait_before=float(busiest["base_avg_wait"].mean()), avg_wait_after=float(busiest["plan_avg_wait"].mean()),
                          walkouts_before=int(busiest["base_walkouts"].sum()), walkouts_after=int(busiest["plan_walkouts"].sum()),
                          p90_before=float(busiest["base_p90_wait"].mean()), p90_after=float(busiest["plan_p90_wait"].mean()), n=int(len(busiest))),
        by_branch={b: dict(avg_wait_before=float(g["base_avg_wait"].mean()), avg_wait_after=float(g["plan_avg_wait"].mean()),
                           walkouts_before=int(g["base_walkouts"].sum()), walkouts_after=int(g["plan_walkouts"].sum()))
                   for b, g in df.groupby("branch")},
    )
    json.dump(summ, open(OUT / "backtest_summary.json", "w"), indent=1)
    print(json.dumps(summ, indent=1))


if __name__ == "__main__":
    main()
