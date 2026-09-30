"""
Synthetic data generator.

Produces the raw data a bank would export, deliberately messy:
  data/raw/branches.csv, staff_master.csv, holidays.csv
  data/raw/token_log_raw.csv        branch visit logs + token queue data
  data/raw/appointments_raw.csv     appointment records (incl. next week's bookings)
  data/raw/staff_roster_raw.csv     daily staff rosters (incl. next week's planned leave)
  data/raw/feedback_raw.csv         ratings + free-text comments (English / Kannada / Hindi)
and simulation truth used for the backtest (data/sim_truth/).

Demand = branch base x service mix x day-of-week x Indian banking calendar
effects x demand shifts x noise. Queues are simulated minute by minute with
SimPy using status-quo staffing (everyone at their home counter).
Service times are lognormal and customer patience exponential, the shapes
reported for real bank queues (Brown et al., JASA 2005, Technion call-centre data).
"""
import math
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from config import (SEED, HIST_START, HIST_END, FUTURE_END, HOLDOUT_START, SERVICES, SERVICE_ORDER, SUBTYPES,
                    RAW_VARIANTS, HOUR_PROFILE, DOW_FACTOR, BRANCHES, DEMAND_SHIFTS, STAFF, MANAGERS,
                    PLANNED_LEAVE, UNPLANNED_LEAVE_RATE, PATIENCE_MEAN, APPT_SHARE, APPT_SHARE_WHITEFIELD,
                    NO_SHOW_RATE, INCOMPLETE_RATE, OUTAGE_PROB, FEEDBACK_RATE, POOLS)
from calendar_in import features, is_open, daterange, closure_reason
from simulator import simulate_day, default_lunch

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
TRUTH = ROOT / "data" / "sim_truth"
RAW.mkdir(parents=True, exist_ok=True)
TRUTH.mkdir(parents=True, exist_ok=True)

rng = np.random.default_rng(SEED)


# ----------------------------------------------------------------------------
# Demand model (ground truth the forecaster has to learn)
# ----------------------------------------------------------------------------
def expected_daily(b, d, f):
    base = b["base"] * DOW_FACTOR[f["dow"]]
    sens_p = b["senior"] / 0.30
    m = {s: 1.0 for s in SERVICE_ORDER}

    def bump(s, e, sens=1.0):
        m[s] *= 1 + e * sens

    if f["month_start"]:
        k = {1: 1.0, 2: 0.65, 3: 0.35}[f["month_start"]]
        for s, e in dict(CASH=.55, PASSBOOK=.80, PENSION=.70, REMIT=.15, ACCOUNT=.05, LOAN=.05).items():
            bump(s, e * k, sens_p if s in ("CASH", "PASSBOOK", "PENSION") else 1.0)
    if f["pre_holiday"]:
        k = 1 + 0.15 * max(0, f["closed_days_after"] - 1)
        for s, e in dict(CASH=.35, REMIT=.20, PASSBOOK=.10, ACCOUNT=.05, PENSION=.05, LOAN=.05).items():
            bump(s, e * k)
    if f["post_closure"]:
        k = min(f["closed_days_before"], 3) / 2
        for s in m:
            bump(s, (0.20 if s == "CASH" else 0.12) * k)
    if f["life_cert"] == 1:
        bump("PENSION", 0.9, sens_p)
    if f["life_cert"] == 2:
        bump("PENSION", 2.0, sens_p)
        bump("PASSBOOK", 0.15, sens_p)
    if f["year_end"]:
        bump("ACCOUNT", .35); bump("LOAN", .45); bump("REMIT", .30)
    if f["festival"]:
        bump("CASH", .25); bump("LOAN", .15 * (1 + b["rural"]))
    if f["crop_season"]:
        bump("LOAN", .70 * b["rural"]); bump("CASH", .15 * b["rural"])
    if f["fee_season"]:
        bump("REMIT", .35); bump("ACCOUNT", .10)

    shift_all = 1.0
    for sh in DEMAND_SHIFTS:
        if sh["branch"] != b["id"] or d < sh["start"]:
            continue
        if sh["kind"] == "trend":
            shift_all *= 1 + sh["pct"] * (d - sh["start"]).days / 365
        elif sh["kind"] == "step":
            shift_all *= 1 + sh["pct"] * min(1.0, (d - sh["start"]).days / sh["ramp_days"])
        elif sh["kind"] == "service_step":
            m[sh["service"]] *= 1 + sh["pct"]
    return {s: base * b["mix"][s] * m[s] * shift_all for s in SERVICE_ORDER}


def hour_profile(s, f):
    p = np.array(HOUR_PROFILE[s], dtype=float)
    if f["month_start"] and s in ("CASH", "PASSBOOK", "PENSION"):
        p *= np.array([1.25, 1.15, 1.0, 0.8, 0.8, 0.7])
    if f["pre_holiday"] and s == "CASH":
        p *= np.array([0.9, 0.95, 1.0, 1.05, 1.15, 1.2])
    return p / p.sum()


def lognorm(mean, cv, size):
    sigma = math.sqrt(math.log(1 + cv * cv))
    mu = math.log(mean) - sigma * sigma / 2
    return rng.lognormal(mu, sigma, size)


# ----------------------------------------------------------------------------
# Customer base per branch
# ----------------------------------------------------------------------------
def build_customer_base(b):
    n = int(b["base"] * 45)
    senior = rng.random(n) < b["senior"]
    super_senior = rng.random(n) < 0.22
    age = np.where(senior, np.where(super_senior, rng.integers(80, 95, n), rng.integers(60, 80, n)),
                   rng.integers(19, 60, n))
    band_mult = np.select([age < 35, age < 60, age < 80], [1.2, 1.0, 0.55], 0.2)
    digital = rng.random(n) < np.clip(b["digital"] * band_mult, 0.02, 0.97)
    hv = rng.random(n) < b["hv"] * np.where((age >= 35) & (age < 75), 1.4, 0.5)
    langs = list(b["langs"])
    lang = rng.choice(langs, n, p=np.array(list(b["langs"].values())))
    cif = rng.choice(np.arange(10 ** 10, 10 ** 10 + 5 * 10 ** 8, dtype=np.int64), n, replace=False)
    mobile = rng.integers(6_000_000_000, 9_999_999_999, n, dtype=np.int64)
    return pd.DataFrame(dict(cif=cif, age=age, digital=digital, hv=hv, lang=lang, mobile=mobile,
                             yob=HIST_END.year - age))


_wcache = {}


def service_weights(bid, base, s, f):
    key = (bid, s, bool(f["month_start"]), f["life_cert"])
    if key in _wcache:
        return _wcache[key]
    age, hv = base["age"].to_numpy(), base["hv"].to_numpy()
    ms = bool(f["month_start"])
    if s == "PENSION":
        w = (age >= 60) * np.where((age >= 80) & (f["life_cert"] == 1), 4.0, 1.0)
    elif s == "PASSBOOK":
        w = np.where(age >= 60, 3.5 if ms else 2.0, 1.0)
    elif s == "CASH":
        w = np.where(age >= 60, 2.2 if ms else 1.0, 1.0)
    elif s == "LOAN":
        w = np.where((age >= 23) & (age <= 68), 1.0, 0.1) * np.where(hv, 3.0, 1.0)
    else:
        w = np.where(age < 78, 1.0, 0.4)
    w = w.astype(float) / w.sum()
    _wcache[key] = w
    return w


# ----------------------------------------------------------------------------
# Feedback text (multilingual, transliterated as customers actually type)
# ----------------------------------------------------------------------------
TEMPLATES = {
    "long_wait": dict(
        en=["Waited {w} minutes for {svc}. Too slow.", "Very long queue today, waited {w} min.",
            "Only {c} counters working and a huge crowd.", "The wait is too long, {w} minutes for {svc}.",
            "Took more than {w} minutes just for {svc}."],
        kn=["Tumba late aaytu, {w} nimisha kaaybeku aaytu.", "Queue tumba doddadittu, {w} nimisha wait maadide.",
            "Counter alli tumba rush idittu, bega aagalilla."],
        hi=["Bahut der lagi, {w} minute wait kiya.", "Line bahut lambi thi, {w} min lage.",
            "Sirf {c} counter khule the, bahut bheed thi."]),
    "walkout": dict(
        en=["Left without being served after {w} minutes.", "Could not wait anymore, went back without my work done."],
        kn=["{w} nimisha aadru kelsa aagilla, vaapas hode."],
        hi=["{w} minute baad bhi number nahi aaya, wapas chala gaya."]),
    "documents": dict(
        en=["Came a second time because nobody told me which documents to bring.",
            "Document list was not given earlier, have to come again.", "Rejected for a missing proof, wasted a trip."],
        kn=["Yaava document beku antha modle heLilla, matte barbeku.", "Document illa antha vaapas kalisidru."],
        hi=["Kaunse documents chahiye pehle nahi bataya, phir se aana padega.", "Document ke liye dobara aana padega."]),
    "system_down": dict(
        en=["Server was down, nothing moved for an hour.", "System slow, link failure again.",
            "Staff kept saying server problem."],
        kn=["Server down antha heLidru, ondu ghante kaaytidde."],
        hi=["Server down tha, ek ghanta kuch nahi hua."]),
    "slow_dd": dict(
        en=["DD took very long to issue.", "Demand draft process is too slow.",
            "Why does a DD take so long when NEFT is quick?"],
        kn=["DD maadlikke tumba time togondru."],
        hi=["DD banane mein bahut time laga."]),
    "lunch": dict(
        en=["Counter closed for lunch while everyone was waiting.", "At lunch time only one counter was open.",
            "Loan desk was empty during lunch."],
        kn=["Lunch time alli counter close maadidru."],
        hi=["Lunch time pe counter band tha."]),
    "seating": dict(
        en=["No place to sit for senior citizens.", "Elderly people standing in the queue for long.",
            "Please give a separate line for senior citizens."],
        kn=["Hiriyarige kootkolloke jaaga illa.", "Senior citizens ge bere line beku."],
        hi=["Buzurgon ke liye baithne ki jagah nahi hai."]),
    "staff": dict(
        en=["Staff was rude and did not explain properly.", "Nobody at the enquiry desk to guide."],
        kn=["Staff sari maathaadalilla."],
        hi=["Staff ka behaviour theek nahi tha."]),
    "positive": dict(
        en=["Quick service, thank you.", "Staff very helpful and polite.", "Good service, explained everything clearly.",
            "Work done in {w} minutes, happy."],
        kn=["Chennagi help maadidru, dhanyavaada.", "Bega kelsa aaytu, thanks."],
        hi=["Bahut accha service, dhanyavaad.", "Jaldi kaam ho gaya."]),
}


def comment_text(theme, lang, w, svc, c):
    code = {"Kannada": "kn", "Hindi": "hi"}.get(lang, "en")
    if code != "en" and rng.random() < 0.3:
        code = "en"
    opts = TEMPLATES[theme][code]
    return opts[rng.integers(len(opts))].format(w=int(round(w)), svc=svc.lower(), c=c)


# ----------------------------------------------------------------------------
# Roster
# ----------------------------------------------------------------------------
def roster_status(sid, d):
    for pl in PLANNED_LEAVE:
        if pl["staff"] == sid and pl["start"] <= d <= pl["end"]:
            return "Training" if pl["reason"] == "Training" else "Leave", pl["reason"]
    if d <= HIST_END and rng.random() < UNPLANNED_LEAVE_RATE:
        return "Leave", "Sick / unplanned"
    return "Present", ""


def status_quo_plan(bid, present_ids):
    staff = [s for s in STAFF if s["branch"] == bid and s["id"] in present_ids]
    by_pool = defaultdict(list)
    for s in staff:
        by_pool[s["home"]].append(s["id"])
    plan = [dict(id=s["id"], blocks=[(0, 10 ** 6, s["home"])], factor=s["skills"]) for s in staff]
    for pool in POOLS:
        if not by_pool[pool]:  # nobody at this desk today -> the manager covers it
            mid = f"MGR-{bid}"
            plan.append(dict(id=mid, blocks=[(0, 10 ** 6, pool)], factor={pool: 1.15}))
            by_pool[pool].append(mid)
    lunch = default_lunch(by_pool)
    for p in plan:
        p["lunch"] = lunch.get(p["id"])
    return plan


def counter_labels(plan):
    lab, cnt = {}, defaultdict(int)
    for p in plan:
        pool = p["blocks"][0][2]
        cnt[pool] += 1
        lab[p["id"]] = "MGR" if p["id"].startswith("MGR") else f"{pool[0]}{cnt[pool]}"
    return lab


# ----------------------------------------------------------------------------
# Main generation loop
# ----------------------------------------------------------------------------
def next_open_after(d, k):
    x = d + timedelta(days=int(k))
    while not is_open(x):
        x += timedelta(days=1)
    return x


def main():
    bases = {b["id"]: build_customer_base(b) for b in BRANCHES}
    returns = defaultdict(list)          # (branch, date) -> list of (cust_idx, service, subtype)
    token_frames, appt_rows, roster_rows, fb_rows, truth_frames, outages, demand_rows = [], [], [], [], [], [], []
    token_seq = 0
    sub_names = {s: [x[0] for x in SUBTYPES[s]] for s in SUBTYPES}
    sub_fact = {s: {x[0]: x[1] for x in SUBTYPES[s]} for s in SUBTYPES}
    sub_p = {s: np.array([x[2] for x in SUBTYPES[s]]) / sum(x[2] for x in SUBTYPES[s]) for s in SUBTYPES}
    appt_seq = 0

    for d in daterange(HIST_START, FUTURE_END):
        if not is_open(d):
            continue
        f = features(d)
        future = d > HIST_END
        for b in BRANCHES:
            bid, base = b["id"], bases[b["id"]]
            # ---- roster
            present = []
            for s in [x for x in STAFF if x["branch"] == bid]:
                st, reason = roster_status(s["id"], d)
                roster_rows.append(dict(date=d.isoformat(), branch_code=bid, staff_id=s["id"], status=st,
                                        remarks=reason, shift="10:00-17:00" if st == "Present" else ""))
                if st == "Present":
                    present.append(s["id"])

            # ---- arrivals
            lam = expected_daily(b, d, f)
            day_noise = rng.lognormal(0, 0.10)
            cols = defaultdict(list)
            for s in SERVICE_ORDER:
                demand_rows.append(dict(date=d.isoformat(), branch=bid, service=s, expected=lam[s]))
                n = rng.poisson(lam[s] * day_noise * rng.lognormal(0, 0.08))
                if n == 0:
                    continue
                hrs = rng.choice(6, n, p=hour_profile(s, f))
                within = rng.random(n) * 60
                surge = (hrs == 0) & (rng.random(n) < 0.35)
                within[surge] = rng.random(surge.sum()) * 10          # crowd waiting at the door at 10:00
                arr = hrs * 60 + within
                share = (APPT_SHARE_WHITEFIELD if bid == "B02" else APPT_SHARE).get(s, 0.0)
                appt = rng.random(n) < share
                slot = np.floor(arr / 30) * 30
                arr = np.where(appt, np.clip(slot + rng.normal(1, 4, n), np.maximum(slot - 5, 0), slot + 20), arr)
                cust = rng.choice(len(base), n, p=service_weights(bid, base, s, f))
                subs = rng.choice(sub_names[s], n, p=sub_p[s])
                cols["service"] += [s] * n
                cols["subtype"] += list(subs)
                cols["arrival"] += list(arr)
                cols["appt"] += list(appt)
                cols["slot"] += list(slot)
                cols["cust"] += list(cust)
                cols["returning"] += [False] * n
            for (ci, s, sub) in returns.pop((bid, d), []):
                h = rng.choice(6, p=hour_profile(s, f))
                cols["service"].append(s); cols["subtype"].append(sub)
                cols["arrival"].append(h * 60 + rng.random() * 60); cols["appt"].append(False)
                cols["slot"].append(np.nan); cols["cust"].append(ci); cols["returning"].append(True)
            df = pd.DataFrame(cols)
            if df.empty:
                continue

            # ---- appointments (attended + no-shows)
            ap = df[df["appt"]]
            for _, r in ap.iterrows():
                appt_seq += 1
                lead = int(rng.choice([0, 1, 2, 3, 4, 5, 6, 7], p=[.10, .20, .18, .15, .12, .10, .08, .07]))
                appt_rows.append(dict(appt_id=f"AP{appt_seq:07d}", branch_code=bid, cif=int(base.at[r["cust"], "cif"]),
                                      service_raw=r["subtype"], slot_date=d.isoformat(),
                                      slot_time=f"{10 + int(r['slot']) // 60:02d}:{int(r['slot']) % 60:02d}",
                                      booked_on=(d - timedelta(days=lead)).isoformat(),
                                      status="Upcoming" if future else "Attended"))
            n_noshow = rng.binomial(len(ap), NO_SHOW_RATE / (1 - NO_SHOW_RATE)) if len(ap) else 0
            for _ in range(n_noshow):
                appt_seq += 1
                r = ap.iloc[rng.integers(len(ap))]
                lead = int(rng.integers(0, 8))
                appt_rows.append(dict(appt_id=f"AP{appt_seq:07d}", branch_code=bid,
                                      cif=int(base.at[int(rng.integers(len(base))), "cif"]),
                                      service_raw=r["subtype"], slot_date=d.isoformat(),
                                      slot_time=f"{10 + int(r['slot']) // 60:02d}:{int(r['slot']) % 60:02d}",
                                      booked_on=(d - timedelta(days=lead)).isoformat(),
                                      status="Upcoming" if future else "No-show"))
            if future:
                continue

            # ---- customer attributes, service times, patience
            df = df.sort_values("arrival").reset_index(drop=True)
            c = base.loc[df["cust"].to_numpy()].reset_index(drop=True)
            df["age"], df["digital"], df["hv"], df["lang"] = c["age"], c["digital"], c["hv"], c["lang"]
            df["cif"], df["mobile"], df["yob"] = c["cif"], c["mobile"], c["yob"]
            df["pool"] = df["service"].map(lambda s: SERVICES[s]["pool"])
            mean = df.apply(lambda r: SERVICES[r["service"]]["mean"] * sub_fact[r["service"]][r["subtype"]], axis=1)
            cv = df["service"].map(lambda s: SERVICES[s]["cv"])
            sig = np.sqrt(np.log(1 + cv ** 2))
            dur = np.exp(rng.normal(np.log(mean) - sig ** 2 / 2, sig))
            inc_rate = df["service"].map(lambda s: INCOMPLETE_RATE.get(s, 0.0))
            df["incomplete"] = (rng.random(len(df)) < inc_rate) & (~df["returning"])
            dur = np.where(df["incomplete"], dur * 0.6, dur)
            df["base_dur"] = np.maximum(dur, 0.7)
            seg = np.where(df["hv"], "hv", np.where(df["age"] >= 60, "senior", "regular"))
            pm = pd.Series(seg).map(PATIENCE_MEAN).to_numpy() * np.where(df["appt"], 1.8, 1.0) * \
                np.where(df["service"] == "LOAN", 1.5, 1.0)
            df["patience"] = np.maximum(rng.gamma(2.5, pm / 2.5), 4.0)   # few people leave within minutes of taking a token
            df["prio"] = np.where(df["appt"], 0, 1)
            df["redirect_u"] = rng.random(len(df))

            outage = None
            if rng.random() < OUTAGE_PROB:
                t0 = float(rng.integers(30, 240))
                outage = (t0, t0 + float(rng.integers(45, 120)), 1.8)
                outages.append(dict(date=d.isoformat(), branch=bid, start_min=outage[0], end_min=outage[1]))

            plan = status_quo_plan(bid, present)
            res = simulate_day(dict(arrival=df["arrival"].to_numpy(), pool=df["pool"].to_numpy(),
                                    prio=df["prio"].to_numpy(), base_dur=df["base_dur"].to_numpy(),
                                    patience=df["patience"].to_numpy()), plan, outage)
            labels = counter_labels(plan)
            df["start"], df["end"], df["left"] = res["start"], res["end"], res["left"]
            df["staff_id"] = [plan[k]["id"] if k >= 0 else "" for k in res["staff"]]
            df["counter"] = [labels.get(sid, "") for sid in df["staff_id"]]
            df["status"] = np.where(df["left"], "Left", np.where(df["incomplete"], "Incomplete-Docs", "Served"))
            wait = np.where(df["left"], res["left_at"] - df["arrival"], df["start"] - df["arrival"])

            # returns for incomplete visits
            for i in np.where(df["incomplete"] & ~df["left"])[0]:
                rd = next_open_after(d, rng.integers(1, 7))
                returns[(bid, rd)].append((int(df.at[i, "cust"]), df.at[i, "service"], df.at[i, "subtype"]))

            # token numbers per pool
            tok = []
            cnt = defaultdict(int)
            for p in df["pool"]:
                cnt[p] += 1
                tok.append(f"{'CGL'[POOLS.index(p)]}-{cnt[p]:03d}")
            df["token_no"] = tok
            df["token_id"] = [f"T{token_seq + i + 1:08d}" for i in range(len(df))]
            token_seq += len(df)
            df["date"] = d.isoformat()
            df["branch_code"] = bid
            df["wait_true"] = wait

            # ---- feedback
            n_open = sum(1 for p in plan if not p["id"].startswith("MGR"))
            for i, r in df.iterrows():
                w = r["wait_true"]
                if r["left"]:
                    if rng.random() > 0.30:
                        continue
                    rating = int(rng.choice([1, 2], p=[.7, .3]))
                    channel = "IVR callback"
                    theme = "walkout"
                else:
                    p_fb = FEEDBACK_RATE * (1.6 if w > 30 else 1.0)
                    if rng.random() > p_fb:
                        continue
                    in_outage = outage is not None and outage[0] <= r["start"] < outage[1]
                    svc_min = r["end"] - r["start"]
                    slow = r["subtype"] == "Demand Draft" and svc_min > 10
                    score = 4.7 - 0.045 * w - (1.3 if r["incomplete"] else 0) - (0.6 if in_outage else 0) \
                        - (0.4 if slow else 0) + rng.normal(0, 0.6)
                    rating = int(np.clip(round(score), 1, 5))
                    channel = rng.choice(["WhatsApp", "Smiley button"], p=[.6, .4]) if r["digital"] else \
                        rng.choice(["Smiley button", "IVR callback"], p=[.7, .3])
                    theme = None
                    lunch_arr = 195 <= r["arrival"] < 255
                    if r["incomplete"] and rng.random() < .8:
                        theme = "documents"
                    elif in_outage and rng.random() < .7:
                        theme = "system_down"
                    elif slow and rng.random() < .6:
                        theme = "slow_dd"
                    elif lunch_arr and w > 15 and rng.random() < .5:
                        theme = "lunch"
                    elif r["age"] >= 60 and w > 20 and rng.random() < .35:
                        theme = "seating"
                    elif w > 20:
                        theme = "long_wait"
                    elif rating <= 2 and rng.random() < .3:
                        theme = "staff"
                    elif rating >= 4:
                        theme = "positive"
                    else:
                        theme = "long_wait" if w > 10 else "positive"
                comment = ""
                has_text = channel != "Smiley button" and rng.random() < (0.6 if rating <= 2 else 0.35)
                if has_text:
                    comment = comment_text(theme, r["lang"], w, SERVICES[r["service"]]["label"].split(" /")[0], n_open)
                fb_rows.append(dict(fb_id=f"F{len(fb_rows) + 1:07d}", token_id=r["token_id"], branch_code=bid,
                                    date=d.isoformat(), channel=channel, rating=rating, comment=comment,
                                    _theme_truth=theme if comment else ""))

            token_frames.append(df)
            if d >= HOLDOUT_START:
                truth_frames.append(df[["token_id", "branch_code", "date", "service", "subtype", "pool", "arrival",
                                        "prio", "base_dur", "patience", "age", "digital", "hv", "incomplete",
                                        "redirect_u", "appt"]].copy())
        if d.day == 1:
            print("generated", d)

    # ------------------------------------------------------------------------
    # Write raw files (with the messiness real exports have)
    # ------------------------------------------------------------------------
    tl = pd.concat(token_frames, ignore_index=True)
    base_ts = pd.to_datetime(tl["date"]) + pd.Timedelta(hours=10)
    arr_ts = base_ts + pd.to_timedelta(tl["arrival"], unit="m")
    call_ts = base_ts + pd.to_timedelta(tl["start"], unit="m")
    close_ts = base_ts + pd.to_timedelta(tl["end"], unit="m")

    fmt_iso = "%Y-%m-%d %H:%M:%S"
    alt = rng.random(len(tl)) < 0.03                      # 3% exported in dd/mm/yyyy HH:MM
    arrival_str = np.where(alt, arr_ts.dt.strftime("%d/%m/%Y %H:%M"), arr_ts.dt.strftime(fmt_iso))
    call_str = call_ts.dt.strftime(fmt_iso).fillna("")
    close_str = close_ts.dt.strftime(fmt_iso).fillna("")
    skew = (rng.random(len(tl)) < 0.006) & tl["start"].notna()   # counter clock behind token machine
    call_str = np.where(skew, (arr_ts - pd.to_timedelta(rng.integers(1, 5, len(tl)), unit="m")).dt.strftime(fmt_iso), call_str)
    miss_close = (rng.random(len(tl)) < 0.01) & tl["end"].notna()  # teller forgot to close the token
    close_str = np.where(miss_close, "", close_str)

    variants = tl["subtype"].map(lambda s: RAW_VARIANTS[s][rng.integers(len(RAW_VARIANTS[s]))])
    pad = rng.random(len(tl)) < 0.05
    variants = np.where(pad, "  " + variants.str.lower() + " ", variants)

    raw = pd.DataFrame(dict(
        token_id=tl["token_id"], branch_code=tl["branch_code"], token_no=tl["token_no"],
        cif=tl["cif"], mobile=tl["mobile"], year_of_birth=tl["yob"], preferred_language=tl["lang"],
        digital_user=np.where(tl["digital"], "Y", "N"), hni_flag=np.where(tl["hv"], "Y", "N"),
        service_raw=variants, channel=np.where(tl["appt"], "Appointment", "Walk-in"),
        arrival_time=arrival_str, call_time=np.where(tl["start"].notna(), call_str, ""), close_time=close_str,
        counter=tl["counter"], staff_id=tl["staff_id"], status=tl["status"],
    ))
    dup = raw.sample(frac=0.003, random_state=SEED)       # double-exported rows
    raw = pd.concat([raw, dup]).sort_values(["branch_code", "token_id"]).reset_index(drop=True)
    raw.to_csv(RAW / "token_log_raw.csv", index=False)

    pd.DataFrame(appt_rows).to_csv(RAW / "appointments_raw.csv", index=False)
    pd.DataFrame(roster_rows).to_csv(RAW / "staff_roster_raw.csv", index=False)
    fb = pd.DataFrame(fb_rows)
    fb.drop(columns=["_theme_truth"]).to_csv(RAW / "feedback_raw.csv", index=False)
    fb[["fb_id", "_theme_truth"]].rename(columns={"_theme_truth": "theme"}).to_csv(TRUTH / "feedback_theme_truth.csv", index=False)

    pd.DataFrame([dict(branch_code=b["id"], branch_name=b["name"], branch_type=b["kind"], lat=b["lat"], lon=b["lon"],
                       manager=MANAGERS[b["id"]], public_hours="10:00-16:00") for b in BRANCHES]).to_csv(RAW / "branches.csv", index=False)
    pd.DataFrame([dict(staff_id=s["id"], branch_code=s["branch"], name=s["name"], role=s["role"], home_desk=s["home"],
                       skills="|".join(f"{k}:{v}" for k, v in s["skills"].items())) for s in STAFF]).to_csv(RAW / "staff_master.csv", index=False)
    hol = [dict(date=d.isoformat(), reason=closure_reason(d)) for d in daterange(HIST_START, FUTURE_END) if not is_open(d)]
    pd.DataFrame(hol).to_csv(RAW / "holidays.csv", index=False)

    pd.concat(truth_frames).to_csv(TRUTH / "customers_holdout.csv.gz", index=False)
    pd.DataFrame(outages).to_csv(TRUTH / "outages.csv", index=False)
    pd.DataFrame(demand_rows).to_csv(TRUTH / "expected_demand.csv.gz", index=False)
    print(f"tokens={len(raw):,} appointments={len(appt_rows):,} feedback={len(fb):,} roster={len(roster_rows):,}")


if __name__ == "__main__":
    main()
