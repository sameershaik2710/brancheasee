"""
Customer-feedback analysis.

Comments arrive in English, Kannada and Hindi typed in Latin script
("tumba late aaytu", "bahut der lagi"), so themes are found with a small
multilingual lexicon that branch staff can read and extend. In production the
same step can call an LLM to label new phrasing; the lexicon stays as the
auditable fallback.

Outputs: themes by branch, rating vs wait, slow-process and repeat-visit
detectors, a service-recovery callback queue and today's in-branch alerts.
"""
import json
import re
from pathlib import Path

import numpy as np
import pandas as pd

from config import HIST_END, BRANCHES, SERVICES

ROOT = Path(__file__).resolve().parents[1]
PROC, OUT, TRUTH = ROOT / "data" / "processed", ROOT / "outputs", ROOT / "data" / "sim_truth"

THEMES = [  # checked in this order; first match wins
    ("walkout", "Left without service", [r"left without", r"went back", r"wapas", r"vaapas hode", r"could not wait"]),
    ("documents", "Documents / repeat visit", [r"document", r"second time", r"dobara", r"phir se", r"matte barbeku", r"\bproof\b", r"rejected"]),
    ("system_down", "System or server down", [r"server", r"\bsystem\b", r"\blink\b"]),
    ("slow_dd", "Demand drafts are slow", [r"\bdd\b", r"demand draft"]),
    ("lunch", "Counter closed at lunch", [r"lunch"]),
    ("seating", "Seniors: seating / separate line", [r"\bsit\b", r"senior", r"elderly", r"buzurg", r"hiriyar", r"standing"]),
    ("staff", "Staff behaviour / guidance", [r"rude", r"behaviour", r"not explain", r"sari maathaad", r"nobody at", r"enquiry desk"]),
    ("long_wait", "Long wait / crowd", [r"wait", r"queue", r"\bline\b", r"\blong\b", r"too slow", r"\bder\b", r"late aaytu", r"kaay",
                                        r"\brush\b", r"bheed", r"crowd", r"lambi", r"took more", r"bega aagalilla"]),
    ("positive", "Praise", [r"thank", r"helpful", r"\bgood\b", r"quick", r"happy", r"accha", r"chennagi", r"dhanyav", r"bega kelsa", r"jaldi"]),
]
THEME_LABEL = {k: lab for k, lab, _ in THEMES}
_COMPILED = [(k, [re.compile(p, re.I) for p in pats]) for k, _, pats in THEMES]


def theme_of(text):
    if not isinstance(text, str) or not text.strip():
        return ""
    for k, pats in _COMPILED:
        if any(p.search(text) for p in pats):
            return k
    return "other"


def main():
    fb = pd.read_csv(PROC / "feedback.csv.gz")
    tok = pd.read_csv(PROC / "tokens.csv.gz", usecols=["token_id", "branch", "date", "service", "subtype", "service_min", "incomplete",
                                                        "arrival_min", "wait_min", "counter", "age_band", "hni", "senior", "token_no"])
    fb["theme"] = fb["comment"].map(theme_of)
    fb["sentiment"] = np.select([fb["rating"] <= 2, fb["rating"] == 3], ["negative", "neutral"], "positive")

    truth = pd.read_csv(TRUTH / "feedback_theme_truth.csv")
    chk = fb[["fb_id", "theme"]].merge(truth, on="fb_id", suffixes=("", "_true"))
    chk = chk[chk["theme_true"].notna() & (chk["theme_true"] != "")]
    lexicon_accuracy = float((chk["theme"] == chk["theme_true"]).mean())

    recent = fb[fb["date"] >= "2026-09-01"]
    out = dict(lexicon_accuracy=round(lexicon_accuracy, 3), theme_labels=THEME_LABEL, branches={})
    for b in BRANCHES:
        bid = b["id"]
        r = recent[recent["branch_code"] == bid]
        rc = r[r["theme"] != ""]
        themes = rc[rc["theme"] != "positive"]["theme"].value_counts()
        examples = {}
        for th in themes.index[:6]:
            ex = rc[rc["theme"] == th].sort_values("date", ascending=False).head(3)
            examples[th] = [dict(text=t, rating=int(rt), date=d, service=SERVICES.get(s, {}).get("label", s) if isinstance(s, str) else "")
                            for t, rt, d, s in zip(ex["comment"], ex["rating"], ex["date"], ex["service"])]
        weekly = fb[fb["branch_code"] == bid].copy()
        weekly["week"] = pd.to_datetime(weekly["date"]).dt.to_period("W").dt.start_time.dt.strftime("%Y-%m-%d")
        wk = weekly.groupby("week")["rating"].mean().tail(26).round(2)
        out["branches"][bid] = dict(
            n=int(len(r)), avg_rating=round(float(r["rating"].mean()), 2), negative_share=round(float((r["sentiment"] == "negative").mean()), 3),
            comments=int(len(rc)), themes={k: int(v) for k, v in themes.items()},
            praise=int((rc["theme"] == "positive").sum()), examples=examples,
            weekly=dict(weeks=list(wk.index), rating=[float(x) for x in wk.values]),
            lunch_by_hour={int(h): int(v) for h, v in rc[rc["theme"] == "lunch"]["hour"].value_counts().items()},
        )

    # rating vs wait (all branches, all history)
    fb["wait_bucket"] = pd.cut(fb["wait_min"], [-1, 5, 15, 30, 60, 1e9], labels=["0-5", "5-15", "15-30", "30-60", "60+"]).astype(str)
    rw = fb[fb["wait_min"].notna()].groupby("wait_bucket")["rating"].agg(["mean", "size"])
    out["rating_by_wait"] = [dict(bucket=k, rating=round(float(rw.at[k, "mean"]), 2), n=int(rw.at[k, "size"]))
                             for k in ["0-5", "5-15", "15-30", "30-60", "60+"] if k in rw.index]

    # slow-process detector: sub-types much slower than the rest of their category
    t90 = tok[tok["date"] >= "2026-07-01"]
    slow = []
    for cat, g in t90[t90["service_min"].notna()].groupby("service"):
        cat_med = g["service_min"].median()
        for sub, gs in g.groupby("subtype"):
            ratio = gs["service_min"].median() / cat_med
            if ratio >= 1.35 and len(gs) >= 200:
                n_c = int(((recent["subtype"] == sub) & recent["theme"].isin(["slow_dd", "long_wait"])).sum())
                slow.append(dict(service=SERVICES[cat]["label"], subtype=sub, median_min=round(float(gs["service_min"].median()), 1),
                                 category_median=round(float(cat_med), 1), ratio=round(float(ratio), 2), volume_per_day=round(len(gs) / t90["date"].nunique(), 1),
                                 complaints_30d=n_c,
                                 counter_hours_per_month=round(float((gs["service_min"].median() - cat_med) * len(gs) / 60 / 3), 1)))
    out["slow_processes"] = sorted(slow, key=lambda x: -x["ratio"])

    # repeat-visit detector: visits that fail for missing documents
    inc = t90.groupby("subtype")["incomplete"].agg(["mean", "sum"]).sort_values("mean", ascending=False)
    out["repeat_visits"] = [dict(subtype=k, fail_rate=round(float(v["mean"]), 3), failed_visits_per_month=round(float(v["sum"]) / 3, 1))
                            for k, v in inc.head(5).iterrows() if v["mean"] > 0.02]

    # service-recovery callbacks: last 3 working days, negative, prioritised
    last = sorted(fb["date"].unique())[-3:]
    neg = fb[fb["date"].isin(last) & (fb["rating"] <= 2)].merge(tok[["token_id", "age_band", "token_no"]], on="token_id", how="left")
    neg["priority"] = neg["hni"].fillna(False).astype(int) * 3 + neg["walkout"].fillna(False).astype(int) * 2 + neg["senior"].fillna(False).astype(int)
    neg = neg.sort_values(["priority", "date"], ascending=False)
    out["callbacks"] = [dict(branch=r.branch_code, date=r.date, token=r.token_no, service=SERVICES.get(r.service, {}).get("label", ""),
                             rating=int(r.rating), comment=r.comment if isinstance(r.comment, str) else "",
                             theme=THEME_LABEL.get(r.theme, ""), channel=r.channel, walkout=bool(r.walkout),
                             hni=bool(r.hni), senior=bool(r.senior), age_band=r.age_band if isinstance(r.age_band, str) else "",
                             wait=round(float(r.wait_min), 0) if pd.notna(r.wait_min) else None)
                        for r in neg.head(40).itertuples()]

    # today's in-branch alerts: low smiley taps at the counter on the last day, with the time they happened
    today = HIST_END.isoformat()
    live = fb[(fb["date"] == today) & (fb["rating"] <= 2) & (fb["channel"] != "IVR callback")].merge(
        tok[["token_id", "arrival_min", "service_min", "token_no", "counter"]], on="token_id", how="left")
    live["t"] = live["arrival_min"] + live["wait_min"].fillna(0) + live["service_min"].fillna(0)
    live = live.sort_values("t")
    out["live_today"] = [dict(branch=r.branch_code, time=f"{10 + int(r.t // 60):02d}:{int(r.t % 60):02d}", token=r.token_no,
                              counter=r.counter, service=SERVICES.get(r.service, {}).get("label", ""), rating=int(r.rating),
                              wait=round(float(r.wait_min), 0) if pd.notna(r.wait_min) else None, senior=bool(r.senior), hni=bool(r.hni))
                         for r in live.itertuples() if pd.notna(r.t)]
    json.dump(out, open(OUT / "feedback_insights.json", "w"), indent=1, default=str)
    print("lexicon accuracy vs generator labels:", round(lexicon_accuracy, 3))
    print("slow:", [(s["subtype"], s["ratio"]) for s in out["slow_processes"]])
    print("repeat:", out["repeat_visits"][:3])
    print("rating_by_wait:", out["rating_by_wait"])
    print("live today:", len(out["live_today"]), "callbacks:", len(out["callbacks"]))


if __name__ == "__main__":
    main()
