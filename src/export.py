"""Bundle every pipeline output into dashboard/data.js (window.DATA = {...})."""
import json
import math
from datetime import date
from pathlib import Path

import pandas as pd

from config import (BRANCHES, STAFF, MANAGERS, SERVICES, SERVICE_ORDER, POOLS, POOL_LABEL, SLA_WAIT, COST, REDIRECT,
                    HIST_END, DEMAND_SHIFTS)
from daybuild import within_matrix, queue_inputs, staff_factors
import engine
from recommend import distance_km

ROOT = Path(__file__).resolve().parents[1]
OUT, PROC, DASH = ROOT / "outputs", ROOT / "data" / "processed", ROOT / "website"


def clean(o):
    if isinstance(o, float):
        return None if math.isnan(o) else round(o, 3)
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    return o


def main():
    rec = json.load(open(OUT / "recommendations.json"))
    fs = json.load(open(OUT / "forecast_summary.json"))
    fh = pd.read_csv(OUT / "forecast_hourly.csv")
    fb = json.load(open(OUT / "feedback_insights.json"))
    bt = json.load(open(OUT / "backtest_summary.json"))
    btd = pd.read_csv(OUT / "backtest_daily.csv")
    cal = json.load(open(OUT / "queue_calibration.json"))
    dq = json.load(open(PROC / "data_quality.json"))
    hd = pd.read_csv(OUT / "holdout_daily.csv")
    hourly = pd.read_csv(PROC / "hourly.csv.gz")
    tok = pd.read_csv(PROC / "tokens.csv.gz", usecols=["branch", "date", "wait_min", "walkout"])

    plan_days = sorted(rec["days"])
    interval = fs["metrics"]["daily_interval"]
    days = {}
    for d in plan_days:
        days[d] = {}
        for b in BRANCHES:
            bid = b["id"]
            R = rec["days"][d][bid]
            rows = fh[(fh["date"] == d) & (fh["branch"] == bid)]
            lam = {s: [round(float(rows[(rows["service"] == s) & (rows["hour"] == h)]["pred"].sum()), 3) for h in range(10, 16)]
                   for s in SERVICE_ORDER}
            ex = fs["days"][f"{d}|{bid}"]
            days[d][bid] = dict(
                lam=lam,
                explain=dict(total=ex["total"], normal=ex["normal"], typical=ex["typical_same_weekday"], drivers=ex["drivers"],
                             low=round(ex["total"] * interval["p10"]), high=round(ex["total"] * interval["p90"]),
                             next_holiday=ex["calendar"].get("next_holiday", "")),
                **{k: R[k] for k in ["alerts", "steps", "experience", "kpi_before", "kpi_after", "home_plan", "plan", "levers",
                                     "absent", "present", "staff", "lent", "appointments", "seniors", "nondigital"]},
            )

    branches = []
    for b in BRANCHES:
        nb = sorted([dict(id=o["id"], km=round(distance_km(b, o), 1)) for o in BRANCHES if o["id"] != b["id"]], key=lambda x: x["km"])
        branches.append(dict(id=b["id"], name=b["name"], kind=b["kind"], manager=MANAGERS[b["id"]], lat=b["lat"], lon=b["lon"],
                             hv=rec["hv_share"].get(b["id"], 0.08), neighbors=nb,
                             shifts=[s["note"] for s in DEMAND_SHIFTS if s["branch"] == b["id"]]))

    # recent history for context: daily customers and average wait, last 16 weeks
    daily = hourly.groupby(["branch", "date"])["arrivals"].sum().reset_index()
    waits = tok.groupby(["branch", "date"]).agg(wait=("wait_min", "mean"), walk=("walkout", "mean")).reset_index()
    daily = daily.merge(waits, on=["branch", "date"], how="left")
    daily = daily[daily["date"] >= "2026-06-08"]
    history = {bid: dict(dates=list(g["date"]), customers=[int(x) for x in g["arrivals"]], wait=[round(float(x), 1) for x in g["wait"]],
                         walkout=[round(float(x), 3) for x in g["walk"]]) for bid, g in daily.groupby("branch")}

    from calendar_in import is_open, closure_reason, daterange
    from datetime import timedelta
    closures = [dict(date=x.isoformat(), reason=closure_reason(x)) for x in daterange(HIST_END, HIST_END + timedelta(days=31)) if not is_open(x)]
    DATA = dict(
        meta=dict(bank="Demo Bank (fictional)", closures=closures, hours="10:00-16:00 (Mon-Sat; closed Sundays and 2nd/4th Saturdays)", region="Bengaluru region", today=HIST_END.isoformat(), plan_days=plan_days,
                  day_labels={d: date.fromisoformat(d).strftime("%a %-d %b") for d in plan_days},
                  sla=SLA_WAIT, cost=COST, pools=POOLS, pool_label=POOL_LABEL,
                  services={s: dict(label=SERVICES[s]["label"], pool=SERVICES[s]["pool"]) for s in SERVICE_ORDER},
                  redirect={s: dict(share=v["share"], accept=v["accept"], needs_digital=v["needs_digital"], short=v["short"],
                                    noun=v["noun"], channel=v["channel"]) for s, v in REDIRECT.items()},
                  within=within_matrix(), svc_mean=queue_inputs()["service_mean"],
                  engine=dict(patience=engine.PATIENCE, rho_cap=engine.RHO_CAP, cv_factor=engine.CV_FACTOR, t_window=engine.T_WINDOW,
                              nb_day=engine.NB_DAY, nb_max=engine.NB_MAX, am_bins=engine.AM_BINS),
                  digital_share=rec["digital_share"], lang_mix=rec["lang_mix"]),
        branches=branches,
        staff_dir={s["id"]: dict(name=s["name"], role=s["role"], branch=s["branch"], home=s["home"], factor=staff_factors(s)) for s in STAFF},
        days=days, network=rec["network"],
        model=dict(metrics=fs["metrics"], calibration=cal,
                   holdout=[dict(date=r.date, branch=r.branch, y=int(r.y), pred=round(float(r.pred), 1), naive=int(r.naive))
                            for r in hd.itertuples()]),
        backtest=dict(summary=bt, daily=[dict(branch=r.branch, date=r.date, customers=int(r.customers),
                                              before=round(float(r.base_avg_wait), 2), after=round(float(r.plan_avg_wait), 2),
                                              walk_before=int(r.base_walkouts), walk_after=int(r.plan_walkouts)) for r in btd.itertuples()]),
        feedback=fb, data_quality=dq, history=history,
    )
    DASH.mkdir(exist_ok=True)
    txt = json.dumps(clean(DATA), separators=(",", ":"), ensure_ascii=False)
    (DASH / "data.js").write_text("window.DATA = " + txt + ";\n", encoding="utf-8")
    print(f"website/data.js written ({len(txt) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
