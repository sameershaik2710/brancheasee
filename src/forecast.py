"""
Footfall forecast: customers per branch x service x hour, up to 7 days ahead.

Model: LightGBM (Poisson objective, so calendar effects stack multiplicatively) on calendar features (Indian banking calendar), recent-demand
lags (only information available 7+ days before the target day) and
appointments already booked for the slot.

Explainability: each day's forecast is decomposed with exact Shapley values
over driver groups (month-start, holiday, life-certificate season, recent
trend, ...) measured against a counterfactual "normal day" for the same branch
and weekday. The values are in customers and add up exactly to the forecast,
so we can say "+145 customers because it is the first working day of the
month". LightGBM's TreeSHAP gives the global driver importance on the model tab.
"""
import json
from datetime import date, timedelta
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

from config import SEED, HIST_END, FUTURE_END, HOLDOUT_START, HOURS, SERVICE_ORDER, BRANCHES
from calendar_in import features as cal_features, is_open, daterange

ROOT = Path(__file__).resolve().parents[1]
PROC, OUT = ROOT / "data" / "processed", ROOT / "outputs"
OUT.mkdir(exist_ok=True)

CAT = ["branch", "service"]
CAL = ["month_start", "pre_holiday", "closed_days_after", "post_closure", "closed_days_before",
       "life_cert", "year_end", "crop_season", "fee_season", "festival"]
FEATURES = CAT + ["hour", "dow"] + CAL + ["lag7", "rm4", "level", "appt_booked"]

GROUPS = {
    "base": ["branch", "service", "hour", "dow"],
    "recent": ["lag7", "rm4", "level"],
    "month_start": ["month_start"],
    "holiday": ["pre_holiday", "closed_days_after", "post_closure", "closed_days_before"],
    "life_cert": ["life_cert"],
    "year_end": ["year_end"],
    "festival": ["festival"],
    "crop": ["crop_season"],
    "fee": ["fee_season"],
    "appointments": ["appt_booked"],
}


def driver_short(g, f):
    """Short phrase for alert text."""
    if g == "holiday":
        if f.get("pre_holiday"):
            return f"branch closed tomorrow ({f.get('next_holiday') or 'long weekend'})"
        return "first day after a closure"
    return {"recent": "recent footfall trend", "month_start": "month-start pension and salary credits",
            "life_cert": "life-certificate season", "year_end": "financial year-end", "festival": "festival week",
            "crop": "crop-loan season", "fee": "fee season (demand drafts)", "appointments": "appointments booked"}.get(g, g)


def driver_label(g, f):
    """Plain-English name for a driver on a given day (f = calendar features)."""
    if g == "recent":
        return "Recent footfall trend at this branch (last 4 weeks)"
    if g == "month_start":
        n = f.get("month_start", 0)
        return {1: "First working day of the month: pensions and salaries credited",
                2: "Second working day of the month: pension and salary rush continues",
                3: "Third working day of the month"}.get(n, "Not a month-start day")
    if g == "holiday":
        if f.get("pre_holiday"):
            nh = f.get("next_holiday") or "a long closure"
            return f"Branch closed next day ({nh}): people finish cash and remittance work before it"
        if f.get("post_closure"):
            return f"First day after {f.get('closed_days_before')} closed days: pent-up visits"
        return "No holiday effect"
    if g == "life_cert":
        return {1: "Life-certificate window for pensioners aged 80+ is open (October)",
                2: "November life-certificate season for all pensioners"}.get(f.get("life_cert"), "Outside life-certificate season")
    return {"year_end": "Financial year-end (KYC, FD, tax-saving rush)",
            "festival": f"Festival week ({f.get('festival_name', '')}): cash and gold-loan demand",
            "crop": "Crop-loan season (Kharif / Rabi)",
            "fee": "School and college fee season: demand drafts",
            "appointments": "Appointments already booked for the day",
            "base": "Normal level for this branch and weekday"}.get(g, g)


# ----------------------------------------------------------------------------
def load():
    h = pd.read_csv(PROC / "hourly.csv.gz")
    ap = pd.read_csv(PROC / "appointments_booked.csv")
    return h, ap


def build_frame(h, ap, target_dates):
    """Feature rows for every branch x service x hour on each target date (history or future)."""
    piv = h.pivot_table(index=["branch", "service", "hour"], columns="date", values="arrivals", aggfunc="sum")
    hist_dates = sorted(piv.columns)
    hist_set = set(hist_dates)
    keys = piv.index
    ap_idx = ap.set_index(["branch", "date", "hour", "service"])["booked"]
    rows = []
    for td in target_dates:
        t = date.fromisoformat(td)
        f = cal_features(t)
        # same weekday, >= 7 days earlier, open
        prev_same = []
        x = t - timedelta(days=7)
        while len(prev_same) < 4 and x >= date(2025, 3, 1):
            if x.isoformat() in hist_set:
                prev_same.append(x.isoformat())
            x -= timedelta(days=7)
        window = [d for d in hist_dates if t - timedelta(days=34) <= date.fromisoformat(d) <= t - timedelta(days=7)]
        lag7 = piv[prev_same[0]].to_numpy() if prev_same else np.full(len(keys), np.nan)
        rm4 = piv[prev_same].mean(axis=1).to_numpy() if prev_same else np.full(len(keys), np.nan)
        level = piv[window].mean(axis=1).to_numpy() if window else np.full(len(keys), np.nan)
        y = piv[td].to_numpy() if td in hist_set else np.full(len(keys), np.nan)
        for i, (b, s, hr) in enumerate(keys):
            rows.append(dict(date=td, branch=b, service=s, hour=hr, dow=f["dow"],
                             **{k: f[k] for k in CAL}, lag7=lag7[i], rm4=rm4[i], level=level[i],
                             appt_booked=float(ap_idx.get((b, td, hr, s), 0.0)), y=y[i]))
    df = pd.DataFrame(rows)
    for c in CAT:
        df[c] = pd.Categorical(df[c], categories=sorted(df[c].unique()) if c == "branch" else SERVICE_ORDER)
    return df


def fit(train):
    m = lgb.LGBMRegressor(objective="poisson", n_estimators=900, learning_rate=0.03, num_leaves=31,
                          min_child_samples=15, subsample=0.8, subsample_freq=1, colsample_bytree=0.9,
                          reg_lambda=1.0, random_state=SEED, verbose=-1)
    m.fit(train[FEATURES], train["y"], categorical_feature=CAT)
    return m


def wape(y, p):
    return float(np.abs(y - p).sum() / max(1e-9, np.abs(y).sum()))


def contributions(model, X):
    """TreeSHAP contributions grouped by driver (used for global importance)."""
    contrib = model.booster_.predict(X[FEATURES], pred_contrib=True)
    c = pd.DataFrame(contrib, columns=FEATURES + ["bias"], index=X.index)
    return pd.DataFrame({g: c[f].sum(axis=1) for g, f in GROUPS.items()}, index=X.index)


# Drivers explained against a counterfactual "normal day" for the same branch and weekday
EXPLAIN = {k: v for k, v in GROUPS.items() if k != "base"}


def normal_day(X, longrun):
    """Same rows with every calendar event switched off and demand at its long-run level."""
    O = X.copy()
    for c in ["month_start", "pre_holiday", "post_closure", "life_cert", "year_end", "festival", "crop_season", "fee_season"]:
        O[c] = 0
    O["closed_days_after"] = np.where(O["dow"] == 5, 1, 0)     # a normal Saturday is followed by Sunday
    O["closed_days_before"] = np.where(O["dow"] == 0, 1, 0)    # a normal Monday follows Sunday
    lr = O[["branch", "service", "hour", "dow"]].astype({"branch": str, "service": str}).merge(
        longrun, how="left", on=["branch", "service", "hour", "dow"])
    O["lag7"] = lr["lag_lr"].to_numpy()
    O["rm4"] = lr["lag_lr"].to_numpy()
    O["level"] = lr["level_lr"].to_numpy()
    O["appt_booked"] = lr["appt_lr"].to_numpy()
    return O


def group_shapley(model, X, O):
    """Exact Shapley values over driver groups, switching each group from 'normal' to actual."""
    import math
    active = [g for g, fs in EXPLAIN.items() if not np.allclose(X[fs].to_numpy(float), O[fs].to_numpy(float), equal_nan=True)]
    k, n = len(active), len(X)
    preds = np.zeros((2 ** k, n))
    for mask in range(2 ** k):
        M = O.copy()
        for j, g in enumerate(active):
            if mask >> j & 1:
                M[EXPLAIN[g]] = X[EXPLAIN[g]].to_numpy()
        preds[mask] = np.clip(model.predict(M[FEATURES]), 0, None)
    phi = {g: np.zeros(n) for g in EXPLAIN}
    for j, g in enumerate(active):
        for mask in range(2 ** k):
            if mask >> j & 1:
                continue
            s_ = bin(mask).count("1")
            w = math.factorial(s_) * math.factorial(k - s_ - 1) / math.factorial(k)
            phi[g] += w * (preds[mask | (1 << j)] - preds[mask])
    return preds[0], phi


def longrun_levels(h, ap):
    hh = h.copy()
    hh["dow"] = pd.to_datetime(hh["date"]).dt.dayofweek
    lag_lr = hh.groupby(["branch", "service", "hour", "dow"])["arrivals"].mean().rename("lag_lr").reset_index()
    level_lr = hh.groupby(["branch", "service", "hour"])["arrivals"].mean().rename("level_lr").reset_index()
    a = hh[["branch", "date", "hour", "service"]].merge(ap, how="left", on=["branch", "date", "hour", "service"])
    appt_lr = a.fillna({"booked": 0}).groupby(["branch", "service", "hour"])["booked"].mean().rename("appt_lr").reset_index()
    return lag_lr.merge(level_lr, on=["branch", "service", "hour"]).merge(appt_lr, on=["branch", "service", "hour"])


def main():
    h, ap = load()
    all_dates = sorted(h["date"].unique())
    train_dates = [d for d in all_dates if d >= "2025-04-10"]
    df = build_frame(h, ap, train_dates)

    # ---------------- evaluation on September 2026 ----------------
    tr = df[df["date"] < HOLDOUT_START.isoformat()]
    te = df[df["date"] >= HOLDOUT_START.isoformat()].copy()
    model = fit(tr)
    te["pred"] = np.clip(model.predict(te[FEATURES]), 0, None)
    te["naive"] = te["lag7"].fillna(te["rm4"]).fillna(0)
    te["rm4f"] = te["rm4"].fillna(0)

    daily = te.groupby(["date", "branch"], observed=True)[["y", "pred", "naive", "rm4f"]].sum().reset_index()
    med = daily.groupby("branch", observed=True)["y"].transform("median")
    peak = daily[daily["y"] > 1.2 * med]
    te["pool"] = te["service"].map({"CASH": "CASH", "LOAN": "EXPERT"}).fillna("GENERAL")
    pool_hr = te.groupby(["date", "branch", "pool", "hour"], observed=True)[["y", "pred", "naive"]].sum()
    metrics = dict(
        holdout=f"{HOLDOUT_START.isoformat()} to {HIST_END.isoformat()}",
        hourly_wape=dict(model=wape(te.y, te.pred), seasonal_naive=wape(te.y, te.naive), avg_last_4_weeks=wape(te.y, te.rm4f)),
        pool_hour_wape=dict(model=wape(pool_hr.y, pool_hr.pred), seasonal_naive=wape(pool_hr.y, pool_hr.naive)),
        daily_wape=dict(model=wape(daily.y, daily.pred), seasonal_naive=wape(daily.y, daily.naive), avg_last_4_weeks=wape(daily.y, daily.rm4f)),
        peak_day_wape=dict(model=wape(peak.y, peak.pred), seasonal_naive=wape(peak.y, peak.naive), avg_last_4_weeks=wape(peak.y, peak.rm4f),
                           n_days=int(len(peak))),
    )
    ratio = (daily["y"] / daily["pred"]).to_numpy()
    metrics["daily_interval"] = dict(p10=float(np.quantile(ratio, 0.10)), p90=float(np.quantile(ratio, 0.90)))
    imp = pd.Series(model.booster_.feature_importance("gain"), index=FEATURES)
    metrics["feature_gain_share"] = (imp / imp.sum()).round(4).sort_values(ascending=False).to_dict()
    daily.to_csv(OUT / "holdout_daily.csv", index=False)
    te.drop(columns=["rm4f"]).to_csv(OUT / "holdout_hourly.csv.gz", index=False)
    print(json.dumps({k: v for k, v in metrics.items() if k not in ("feature_gain_share",)}, indent=1))

    # ---------------- final model on all history, forecast next week ----------------
    shap_hold = contributions(model, te)
    metrics["driver_importance"] = (shap_hold.abs().mean() / shap_hold.abs().mean().sum()).round(4).sort_values(ascending=False).to_dict()

    final = fit(df)
    fut_dates = [d.isoformat() for d in daterange(HIST_END + timedelta(days=1), FUTURE_END) if is_open(d)]
    fut = build_frame(h, ap, fut_dates)
    fut["pred"] = np.clip(final.predict(fut[FEATURES]), 0, None)
    longrun = longrun_levels(h, ap)
    parts = []
    for d in fut_dates:
        X = fut[fut["date"] == d]
        base0, phi = group_shapley(final, X, normal_day(X, longrun))
        P = pd.DataFrame({"d_normal": base0, **{f"d_{g}": v for g, v in phi.items()}}, index=X.index)
        parts.append(P)
    fut = pd.concat([fut, pd.concat(parts)], axis=1)
    dcols = ["d_normal"] + [f"d_{g}" for g in EXPLAIN]
    assert np.allclose(fut[dcols].sum(axis=1), fut["pred"], atol=1e-6)
    fut.to_csv(OUT / "forecast_hourly.csv", index=False)

    hist_daily = h.groupby(["branch", "date"])["arrivals"].sum().reset_index()
    hist_daily["dow"] = pd.to_datetime(hist_daily["date"]).dt.dayofweek
    days = {}
    for d in fut_dates:
        f = cal_features(date.fromisoformat(d))
        for b in BRANCHES:
            sub = fut[(fut["date"] == d) & (fut["branch"] == b["id"])]
            same = hist_daily[(hist_daily["branch"] == b["id"]) & (hist_daily["dow"] == f["dow"])].tail(8)
            drivers = []
            for g in EXPLAIN:
                v = float(sub[f"d_{g}"].sum())
                if abs(v) >= 1.0:
                    drivers.append(dict(key=g, label=driver_label(g, f), value=round(v, 1)))
            drivers.sort(key=lambda x: -abs(x["value"]))
            days[f"{d}|{b['id']}"] = dict(
                total=round(float(sub["pred"].sum()), 1),
                normal=round(float(sub["d_normal"].sum()), 1),
                typical_same_weekday=round(float(same["arrivals"].mean()), 1),
                drivers=drivers,
                calendar={k: (int(v) if isinstance(v, (np.integer,)) else v) for k, v in f.items()},
            )
    json.dump(dict(metrics=metrics, days=days), open(OUT / "forecast_summary.json", "w"), indent=1, default=str)
    print("forecast days:", fut_dates)
    for k, v in days.items():
        if k.startswith(fut_dates[0]):
            print(k, v["total"], "normal", v["normal"], "typical", v["typical_same_weekday"],
                  [(x["key"], x["value"]) for x in v["drivers"]])


if __name__ == "__main__":
    main()
