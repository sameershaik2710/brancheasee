"""
Recommendations for each branch and forecast day.

Plan steps are applied in a fixed, explainable order and each step's impact is
measured on top of the previous ones (a "wait-time waterfall"):
  1. Guide eligible customers to self-service / digital channels (per service)
  2. Offer non-urgent morning appointments a quieter afternoon slot
  3. Re-deploy staff between counters (morning / afternoon blocks)
  4. Stagger lunch one person at a time
  5. Borrow a cross-trained colleague from a nearby branch with spare capacity (network pass)
plus customer-experience actions (senior priority lane, kiosk helper, document checklist)
that have no queue effect but address what the feedback says.
"""
import json
import math
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

from config import (POOLS, POOL_LABEL, SERVICES, SERVICE_ORDER, SLA_WAIT, REDIRECT, COST, BRANCHES, BRANCH_BY_ID,
                    MANAGERS, REGIONAL_MANAGER, STAFF, HIST_END)
from daybuild import build_day, staff_factors
from engine import evaluate, optimize, home_plan, objective, rupees, AM_BINS, NB_DAY, POOL_OF
from preprocess import map_service

ROOT = Path(__file__).resolve().parents[1]
PROC, OUT, RAW = ROOT / "data" / "processed", ROOT / "outputs", ROOT / "data" / "raw"
NON_URGENT = {"FD Opening / Renewal", "KYC Update", "Nominee Registration", "Address Change", "Mobile Number Update"}
DOCS = {"ACCOUNT": "Aadhaar, PAN card and one passport photo", "LOAN": "Aadhaar, PAN, last 3 salary slips / land records and 6 months' bank statement",
        "PENSION": "Pension payment order (PPO) number, Aadhaar and passbook"}
KN = {
    "kiosk": "ಪಾಸ್‌ಬುಕ್ ನವೀಕರಣಕ್ಕೆ ಪ್ರವೇಶದ್ವಾರದಲ್ಲಿರುವ ಕಿಯೋಸ್ಕ್ ಬಳಸಿ. ಟೋಕನ್ ಬೇಕಿಲ್ಲ.",
    "resched": "ನಾಳೆ ಬೆಳಿಗ್ಗೆ ಶಾಖೆಯಲ್ಲಿ ಹೆಚ್ಚು ಜನಸಂದಣಿ ನಿರೀಕ್ಷಿಸಲಾಗಿದೆ. ನಿಮ್ಮ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಅನ್ನು ಮಧ್ಯಾಹ್ನಕ್ಕೆ ಬದಲಾಯಿಸಲು 1 ಒತ್ತಿರಿ.",
    "docs": "ದಯವಿಟ್ಟು ನಿಮ್ಮ ಭೇಟಿಗೆ ಈ ದಾಖಲೆಗಳನ್ನು ತನ್ನಿ:",
}


def block_peak(ev, pool, bins):
    """Worst hourly (arrival-weighted) wait of a pool within the given bins."""
    bins = list(bins)
    best = 0.0
    for h in range(6):
        hb = [x for x in range(h * 4, h * 4 + 4) if x in bins]
        a = sum(ev[pool]["arr_bins"][x] for x in hb)
        if a > 1.0:
            best = max(best, sum(ev[pool]["arr_bins"][x] * ev[pool]["wait_bins"][x] for x in hb) / a)
    return best


def hhmm(minutes):
    h, m = divmod(int(round(minutes)), 60)
    return f"{10 + h:02d}:{m:02d}"


def block_label(block):
    return "10:00-13:00" if block == "AM" else "13:00-16:00"


def round_int(x):
    return int(math.floor(x + 0.5))


def kpis(ev):
    b = ev["_branch"]
    return dict(avg_wait=round(b["avg_wait"], 1), peak_wait=round(b["peak_wait"], 1), walkouts=round(b["walkouts"], 1),
                overtime_min=int(b["overtime_min"]), arrivals=round(b["arrivals"], 1), breaches=int(b["breaches"]),
                pools={p: dict(avg_wait=round(ev[p]["avg_wait"], 1), peak_wait=round(ev[p]["peak_wait"], 1),
                               walkouts=round(ev[p]["walkouts"], 1), arrivals=round(ev[p]["arrivals"], 1),
                               overtime_min=int(ev[p]["overtime_min"])) for p in POOLS})


# ----------------------------------------------------------------------------
# context from history
# ----------------------------------------------------------------------------
def load_context():
    tok = pd.read_csv(PROC / "tokens.csv.gz", usecols=["branch", "date", "service", "subtype", "digital", "senior",
                                                       "super_senior", "hni", "incomplete", "lang"])
    recent = tok[tok["date"] >= "2026-06-01"]
    g = recent.groupby(["branch", "service"])
    ctx = dict(
        digital=g["digital"].mean().to_dict(), senior=g["senior"].mean().to_dict(),
        super_senior=g["super_senior"].mean().to_dict(),
        hv=recent.groupby("branch")["hni"].mean().to_dict(),
        incomplete=recent.groupby(["branch", "service"])["incomplete"].mean().to_dict(),
        lang=recent.groupby("branch")["lang"].agg(lambda s: s.value_counts(normalize=True).round(3).to_dict()).to_dict(),
    )
    ap = pd.read_csv(RAW / "appointments_raw.csv")
    ap["subtype"] = ap["service_raw"].map(lambda r: map_service(r)[0])
    ap["service"] = ap["service_raw"].map(lambda r: map_service(r)[1])
    ap["hour"] = ap["slot_time"].str[:2].astype(int)
    ctx["appts"] = ap
    return ctx


def distance_km(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a["lat"], a["lon"], b["lat"], b["lon"]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h)) * 1.3   # x1.3 road-distance factor


# ----------------------------------------------------------------------------
# alerts
# ----------------------------------------------------------------------------
ROLE_PLURAL = dict(CASH="cashiers", GENERAL="customer-service staff", EXPERT="loan officers")


def pool_bin_series(frows, pool, within):
    """Forecast and driver contributions for one pool, spread into 15-minute bins."""
    cols = ["pred", "d_normal"] + [c for c in frows.columns if c.startswith("d_") and c != "d_normal"]
    sub = frows[frows["service"].map(POOL_OF) == pool].groupby("hour")[cols].sum()
    out = {c: [0.0] * NB_DAY for c in cols}
    for h in range(6):
        if 10 + h not in sub.index:
            continue
        for q in range(4):
            for c in cols:
                out[c][h * 4 + q] = float(sub.at[10 + h, c]) * within[h][q]
    return out


def make_alerts(ev, day, frows, labels):
    alerts = []
    b = day["branch"]
    for pool in POOLS:
        bins = ev[pool]["breach_bins"]
        if not bins:
            continue
        runs, cur = [], [bins[0]]
        for x in bins[1:]:
            if x <= cur[-1] + 2:          # merge runs separated by a single quiet bin
                cur.extend(range(cur[-1] + 1, x + 1))
            else:
                runs.append(cur); cur = [x]
        runs.append(cur)
        series = pool_bin_series(frows, pool, day["within"])
        normal_n = sum(1 for st in STAFF if st["branch"] == b and st["home"] == pool)
        on_duty = sum(1 for sid, st in day["staff"].items() if st["home"] == pool and not sid.startswith("MGR"))
        for run in runs:
            s_min, e_min = run[0] * 15, (run[-1] + 1) * 15
            peak = max(ev[pool]["wait_bins"][x] for x in run)
            if len(run) < 2 and peak < 1.5 * SLA_WAIT[pool]:
                continue            # a single 15-minute blip is not worth an alert
            pred = sum(series["pred"][x] for x in run)
            normal = sum(series["d_normal"][x] for x in run)
            drv = sorted(((k[2:], sum(series[k][x] for x in run)) for k in series if k.startswith("d_") and k != "d_normal"),
                         key=lambda kv: -kv[1])
            causes = []
            if pred > normal * 1.1:
                top = [(k, v) for k, v in drv if v >= 1][:2]
                causes.append(f"{round_int(pred)} customers expected at the {POOL_LABEL[pool].lower()} between {hhmm(s_min)} and {hhmm(e_min)}, "
                              f"vs {round_int(normal)} on a normal day"
                              + (". Why: " + "; ".join(f"{labels[k]} (+{round_int(v)})" for k, v in top) if top else ""))
            away = [a for a in day["absent"] if a["home"] == pool]
            if away:
                who = ", ".join(f"{a['name']} ({(a['reason'] or a['status']).lower()})" for a in away)
                causes.append(f"{who}: {on_duty} of {normal_n} {ROLE_PLURAL[pool]} on duty")
            lunch_bins = [x for x in run if 13 <= x <= 16]
            if lunch_bins and min(ev[pool]["servers_bins"][x] for x in lunch_bins) < on_duty:
                causes.append("lunch breaks take people off this counter at the same time")
            if not causes:
                causes.append(f"{round_int(pred)} customers arrive in this window for {on_duty} staff")
            sev = "critical" if peak >= 2 * SLA_WAIT[pool] else "warning"
            walk = sum(ev[pool]["arr_bins"][x] for x in run)
            alerts.append(dict(pool=pool, start=hhmm(s_min), end=hhmm(e_min), peak_wait=round(peak, 1),
                               sla=SLA_WAIT[pool], arrivals=round(pred, 1), servers=on_duty, severity=sev, causes=causes,
                               title=f"{POOL_LABEL[pool]}: waits up to {round_int(peak)} min, {hhmm(s_min)}-{hhmm(e_min)}"))
    alerts.sort(key=lambda a: (a["severity"] != "critical", -a["peak_wait"]))
    return alerts


# ----------------------------------------------------------------------------
# the plan
# ----------------------------------------------------------------------------
def step_record(kind, title, ev_before, ev_after, plan_b, plan_a, home, hv, **kw):
    d_wait = ev_before["_branch"]["wait_minutes"] - ev_after["_branch"]["wait_minutes"]
    rec = dict(kind=kind, title=title,
               impact=dict(wait_minutes_saved=round(d_wait), walkouts_avoided=round(ev_before["_branch"]["walkouts"] - ev_after["_branch"]["walkouts"], 1),
                           avg_wait_before=round(ev_before["_branch"]["avg_wait"], 1), avg_wait_after=round(ev_after["_branch"]["avg_wait"], 1),
                           peak_wait_before=round(ev_before["_branch"]["peak_wait"], 1), peak_wait_after=round(ev_after["_branch"]["peak_wait"], 1),
                           overtime_before=int(ev_before["_branch"]["overtime_min"]), overtime_after=int(ev_after["_branch"]["overtime_min"]),
                           rupees=rupees(ev_before, ev_after, hv, kw.pop("moved", 0.0)) - kw.pop("extra_cost", 0)),
               **kw)
    return rec


def build_plan(day, ctx, frows=None, appts=None, date_str=None, include_experience=True):
    """Returns (steps, levers, plan, ev_before, ev_after)."""
    b = day["branch"]
    hv = ctx["hv"].get(b, 0.08)
    home = home_plan(day)
    levers = {"redirect": {}, "reschedule": [], "lunch": "standard"}
    ev0 = evaluate(day, home, levers)
    ev, plan = ev0, home
    steps = []

    # 1. redirection, one service at a time (largest pool pressure first)
    order = sorted([s for s in SERVICE_ORDER if REDIRECT[s]["share"] > 0],
                   key=lambda s: -(ev[POOL_OF[s]]["peak_wait"] / SLA_WAIT[POOL_OF[s]]))
    for s in order:
        pool = POOL_OF[s]
        pressure = ev[pool]["peak_wait"] > 0.6 * SLA_WAIT[pool] or s == "PASSBOOK"
        if not pressure:
            continue
        r = REDIRECT[s]
        dig = ctx["digital"].get((b, s), 0.5)
        frac = r["share"] * r["accept"] * (dig if r["needs_digital"] else 1.0)
        moved = sum(day["lam"][s]) * frac
        if moved < 3:
            continue
        trial = dict(levers, redirect=dict(levers["redirect"], **{s: round(frac, 4)}))
        ev_t = evaluate(day, plan, trial)
        if ev["_branch"]["wait_minutes"] - ev_t["_branch"]["wait_minutes"] < 5 and s != "PASSBOOK":
            continue
        nondig = moved * (1 - dig) if not r["needs_digital"] else 0.0
        label = SERVICES[s]["label"]
        text_en = (f"{label}? Skip the queue: {r['channel']}." if s != "PASSBOOK"
                   else "Passbook update? Use the kiosk at the entrance - no token needed. Staff will help you.")
        rec = step_record("redirect", f"Guide about {round_int(moved)} {r['noun']} customers to {r['short']}",
                          ev, ev_t, plan, plan, home, hv, moved=moved,
                          effect=dict(type="redirect", service=s, fraction=round(frac, 4)),
                          customers_moved=round(moved, 1), needs_help=round(nondig, 1),
                          why=(f"About {round(frac * 100)}% of {r['noun']} requests can be done at {r['short']}"
                               + (f" ({round(dig * 100)}% of these customers use digital banking)" if r["needs_digital"] else "")
                               + f". That frees the {POOL_LABEL[pool].lower()} for work only staff can do."
                               + (f" Around {round_int(nondig)} of them are not digital users, so a floor helper or the voice kiosk assists them." if nondig >= 3 else "")),
                          owner="Token machine + floor staff", autopilot=True,
                          notify=[dict(to="Token machine (all customers)", channel="Screen + voice prompt", text=text_en,
                                       text_local=KN["kiosk"] if s == "PASSBOOK" else f"{r['kn']} - ಸರತಿ ಇಲ್ಲ"),
                                  dict(to="Floor staff", channel="Staff app", text=f"Tomorrow: guide {r['noun']} customers to {r['short']}; help anyone who is unsure.")])
        steps.append(rec)
        levers, ev = trial, ev_t

    # 2. reschedule non-urgent morning appointments in breached windows
    if appts is not None:
        for s in ("LOAN", "ACCOUNT"):
            pool = POOL_OF[s]
            am_breach = [x for x in ev[pool]["breach_bins"] if x < AM_BINS]
            if not am_breach:
                continue
            hours = sorted({x // 4 for x in am_breach})
            booked = appts[(appts["service"] == s) & (appts["hour"].isin([10 + h for h in hours])) & (appts["subtype"].isin(NON_URGENT))]
            if booked.empty:
                continue
            pm_waits = [(sum(ev[pool]["wait_bins"][h * 4:(h + 1) * 4]) / 4, h) for h in (4, 5)]
            to_h = min(pm_waits)[1]
            moves = []
            for h in hours:
                n = len(booked[booked["hour"] == 10 + h]) * 0.5
                if n >= 0.5:
                    moves.append(dict(service=s, from_hour=h, to_hour=to_h, count=round(n, 2)))
            if not moves:
                continue
            trial = dict(levers, reschedule=levers["reschedule"] + moves)
            ev_t = evaluate(day, plan, trial)
            n_sms = len(booked)
            steps.append(step_record(
                "reschedule", f"Offer {n_sms} non-urgent {SERVICES[s]['label'].split(',')[0].lower()} appointments an afternoon slot",
                ev, ev_t, plan, plan, home, hv,
                effect=dict(type="reschedule", moves=moves), customers_moved=round(sum(m["count"] for m in moves), 1),
                why=(f"The {POOL_LABEL[pool].lower()} is over its {SLA_WAIT[pool]}-minute target in the morning. {n_sms} customers booked "
                     f"routine work (FD renewal, KYC or nominee updates) in those hours. If about half accept a {10 + to_h}:00 slot, "
                     f"urgent loan customers get seen sooner."),
                owner="Customer messaging (automatic, customer opts in)", autopilot=True,
                notify=[dict(to=f"{n_sms} appointment holders", channel="SMS / WhatsApp",
                             text=f"Heavy rush expected at the branch tomorrow morning. Reply 1 to move your appointment to {10 + to_h}:00, 2 to keep it.",
                             text_local=KN["resched"])]))
            levers, ev = trial, ev_t

    # 3. staff re-deployment
    best = optimize(day, levers)
    ev_t = evaluate(day, best, levers)
    moves = [dict(staff=sid, name=day["staff"][sid]["name"], block=blk, frm=home[sid][blk], to=best[sid][blk])
             for sid in best for blk in ("AM", "PM") if best[sid][blk] != home[sid][blk]]
    if moves and (ev["_branch"]["wait_minutes"] - ev_t["_branch"]["wait_minutes"] >= 60
                  or ev["_branch"]["walkouts"] - ev_t["_branch"]["walkouts"] >= 2):
        # merge AM+PM moves of the same person into one line
        lines = {}
        for m in moves:
            key = (m["staff"], m["frm"], m["to"])
            lines.setdefault(key, []).append(m["block"])
        detail = []
        for (sid, frm, to), blocks in lines.items():
            when = "all day" if len(blocks) == 2 else block_label(blocks[0])
            detail.append(dict(staff=sid, name=day["staff"][sid]["name"], frm=frm, to=to, when=when, blocks=blocks))
        pressure = []
        for m in detail:
            to_bins = range(0, AM_BINS) if m["blocks"] == ["AM"] else (range(AM_BINS, NB_DAY) if m["blocks"] == ["PM"] else range(NB_DAY))
            arr = sum(ev[m["to"]]["arr_bins"][x] for x in to_bins)
            pk = block_peak(ev, m["to"], to_bins)
            pk_after = block_peak(ev_t, m["to"], to_bins)
            fr_after = block_peak(ev_t, m["frm"], to_bins)
            pressure.append(f"{m['name']} to the {POOL_LABEL[m['to']].lower()} ({m['when']}): {round_int(arr)} customers expected there, "
                            f"peak wait {round_int(pk)} -> {round_int(pk_after)} min; the {POOL_LABEL[m['frm']].lower()} stays at "
                            f"{round_int(fr_after)} min or less.")
        steps.append(step_record(
            "staff", "Re-deploy " + ", ".join(f"{m['name']} to {POOL_LABEL[m['to']].split(' ')[0].lower()}" for m in detail),
            ev, ev_t, plan, best, home, hv,
            effect=dict(type="staff", moves=[dict(staff=m["staff"], block=m["block"], to=m["to"]) for m in moves]),
            moves=detail, why=" ".join(pressure) + " Each person is only moved to a counter they are trained for (skill matrix, speed measured from past tokens).",
            owner=f"{MANAGERS[b]} (branch manager)", autopilot=False,
            notify=[dict(to=m["name"], channel="Staff app", text=f"Tomorrow {m['when']}: please work at the {POOL_LABEL[m['to']].lower()} instead of the {POOL_LABEL[m['frm']].lower()}.")
                    for m in detail]))
        plan, ev = best, ev_t

    # 4. lunch one at a time
    trial = dict(levers, lunch="one_at_a_time")
    ev_t = evaluate(day, plan, trial)
    if ev["_branch"]["wait_minutes"] - ev_t["_branch"]["wait_minutes"] > 20:
        steps.append(step_record(
            "lunch", "Stagger lunch one person at a time per counter (13:00-15:00)", ev, ev_t, plan, plan, home, hv,
            effect=dict(type="lunch", policy="one_at_a_time"),
            why="The usual two-wave lunch (13:15-14:15) takes half of each counter away at once while the afternoon queue is still clearing. "
                "Rotating one person at a time keeps more counters open.",
            owner=f"{MANAGERS[b]} (branch manager)", autopilot=False,
            notify=[dict(to="All counter staff", channel="Staff app", text="Tomorrow lunch is one person at a time per counter, 30 minutes each, from 13:00. Check the app for your slot.")]))
        levers, ev = trial, ev_t

    exp = []
    if include_experience and frows is not None:
        # seniors and assisted help
        sen_hr = []
        for h in range(6):
            v = sum(day["lam"][s][h] * ctx["senior"].get((b, s), 0.2) for s in SERVICE_ORDER)
            sen_hr.append(v)
        sen_am = sum(sen_hr[:2])
        super_sr = sum(sum(day["lam"][s]) * ctx["super_senior"].get((b, s), 0.03) for s in SERVICE_ORDER)
        if sen_am >= 25:
            exp.append(dict(kind="experience", title=f"Open a senior-citizen priority lane with seating, 10:00-12:00",
                            why=f"About {round_int(sen_am)} customers aged 60+ are expected in the first two hours "
                                f"({round_int(super_sr)} aged 80+ over the day). Feedback at this branch mentions seniors standing in the queue.",
                            detail=f"Token machine gives age 75+ a priority token automatically; offer doorstep banking to the 80+ customers who call.",
                            owner="Floor manager", autopilot=True, effect=dict(type="none"),
                            impact=dict(customers=round(sen_am)),
                            notify=[dict(to="Token machine", channel="Rule update", text="Priority token for customers aged 75+ and differently-abled customers, 10:00-12:00.")]))
        red = [st for st in steps if st["kind"] == "redirect"]
        helpers = sum(st.get("needs_help", 0) for st in red)
        if helpers >= 10:
            peak_h = max(range(6), key=lambda h: sum(day["lam"][s][h] for s in ("PASSBOOK", "CASH", "PENSION")))
            exp.append(dict(kind="experience", title=f"Voice kiosk first; one floor helper on standby {10 + peak_h}:00-{11 + peak_h}:00",
                            why=f"About {round_int(helpers)} customers sent to self-service are not digital users. The voice kiosk "
                                f"(Kannada / Hindi / English) handles most of them; a colleague is alerted only when the kiosk detects "
                                f"confusion, so no one is posted there full time.",
                            owner="Floor staff (on alert)", autopilot=True, effect=dict(type="none"),
                            impact=dict(customers=round(helpers)), notify=[]))
        if appts is not None:
            bk = appts[appts["service"].isin(["ACCOUNT", "LOAN", "PENSION"])]
            if len(bk):
                exp_fail = sum(ctx["incomplete"].get((b, s), 0.08) for s in bk["service"])
                exp.append(dict(kind="experience", title=f"Send a document checklist to {len(bk)} customers with appointments",
                                why=f"Historically {round(100 * np.mean([ctx['incomplete'].get((b, s), 0.08) for s in bk['service']]))}% of these visits fail "
                                    f"for a missing document and the customer has to come back. A checklist the evening before avoids about "
                                    f"{max(1, round_int(exp_fail * 0.6))} repeat visits.",
                                owner="Customer messaging (automatic)", autopilot=True, effect=dict(type="none"),
                                impact=dict(customers=len(bk), repeat_visits_avoided=max(1, round_int(exp_fail * 0.6))),
                                notify=[dict(to=f"{len(bk)} appointment holders", channel="WhatsApp / SMS",
                                             text=f"For your visit tomorrow please bring: {DOCS['ACCOUNT']} (account/KYC) or {DOCS['LOAN']} (loans).",
                                             text_local=KN["docs"] + " ಆಧಾರ್, ಪ್ಯಾನ್ ಮತ್ತು ಒಂದು ಫೋಟೋ.")]))
    return steps, levers, plan, ev0, ev, exp


# ----------------------------------------------------------------------------
def network_pass(results, date_str, ctx):
    """Lend a cross-trained colleague from a branch with spare capacity to one over its targets."""
    moves = []
    used = set()
    for _ in range(3):
        best = None
        for rb, R in results.items():
            evR = R["ev_after"]
            bpool = max(POOLS, key=lambda p: evR[p]["peak_wait"] / SLA_WAIT[p])
            if evR[bpool]["peak_wait"] <= SLA_WAIT[bpool]:
                continue
            for db, D in results.items():
                if db == rb or distance_km(BRANCH_BY_ID[rb], BRANCH_BY_ID[db]) > 25:
                    continue
                km = distance_km(BRANCH_BY_ID[rb], BRANCH_BY_ID[db])
                base_d = D["ev_after"]["_branch"]
                for sid, st in D["day"]["staff"].items():
                    if sid.startswith("MGR") or sid in used or bpool not in st["factor"] or sid not in D["plan"]:
                        continue
                    for blocks in (("AM",), ("AM", "PM")):
                        # donor re-plans its remaining staff around the gap
                        dplan = {k: dict(v) for k, v in D["plan"].items()}
                        for blk in blocks:
                            dplan[sid][blk] = "AWAY"
                        dplan = optimize(D["day"], D["levers"], start=dplan, fixed={(sid, "AM"), (sid, "PM")})
                        ev_d = evaluate(D["day"], dplan, D["levers"])
                        if any(ev_d[p]["peak_wait"] > 0.9 * SLA_WAIT[p] for p in POOLS if ev_d[p]["arrivals"] > 1):
                            continue
                        if ev_d["_branch"]["avg_wait"] - base_d["avg_wait"] > 2:
                            continue
                        rday = dict(R["day"], staff=dict(R["day"]["staff"]))
                        rday["staff"][sid] = dict(st, home=bpool)
                        rplan = {k: dict(v) for k, v in R["plan"].items()}
                        rplan[sid] = {"AM": "AWAY", "PM": "AWAY"}
                        for blk in blocks:
                            rplan[sid][blk] = bpool
                        ev_r = evaluate(rday, rplan, R["levers"])
                        gain = (evR["_branch"]["wait_minutes"] + 30 * evR["_branch"]["walkouts"]) - \
                               (ev_r["_branch"]["wait_minutes"] + 30 * ev_r["_branch"]["walkouts"])
                        loss = (ev_d["_branch"]["wait_minutes"] + 30 * ev_d["_branch"]["walkouts"]) - \
                               (base_d["wait_minutes"] + 30 * base_d["walkouts"])
                        net = gain - loss - 60 * len(blocks)
                        if net > 150 and (best is None or net > best["net"]):
                            best = dict(net=net, rb=rb, db=db, sid=sid, pool=bpool, blocks=blocks, km=km,
                                        ev_r=ev_r, ev_d=ev_d, rday=rday, rplan=rplan, dplan=dplan)
        if best is None:
            break
        used.add(best["sid"])
        R, D = results[best["rb"]], results[best["db"]]
        st = D["day"]["staff"][best["sid"]]
        when = "10:00-13:00, back after lunch" if best["blocks"] == ("AM",) else "all day"
        hvR = ctx["hv"].get(best["rb"], 0.08)
        rec = step_record(
            "float", f"Borrow {st['name']} from {BRANCH_BY_ID[best['db']]['name']} for the {POOL_LABEL[best['pool']].lower()} ({when})",
            R["ev_after"], best["ev_r"], R["plan"], best["rplan"], None, hvR, extra_cost=COST["floating_trip"] * len(best["blocks"]),
            effect=dict(type="float", staff=best["sid"], from_branch=best["db"], to_branch=best["rb"], pool=best["pool"],
                        blocks=list(best["blocks"]), factor=st["factor"], name=st["name"], role=st["role"],
                        donor_plan=best["dplan"]),
            why=(f"{BRANCH_BY_ID[best['db']]['name']} ({round(best['km'])} km away) stays within its wait targets without {st['name']} "
                 f"(worst counter {round_int(max(best['ev_d'][p]['peak_wait'] for p in POOLS))} min after re-planning its other staff). "
                 f"{st['name']} is trained for the {POOL_LABEL[best['pool']].lower()}, which is still the bottleneck here after the other steps."),
            owner=f"{REGIONAL_MANAGER} approves; both branch managers notified", autopilot=False,
            notify=[dict(to=REGIONAL_MANAGER, channel="Approval request", text=f"Lend {st['name']} from {BRANCH_BY_ID[best['db']]['name']} to {BRANCH_BY_ID[best['rb']]['name']} tomorrow ({when})."),
                    dict(to=st["name"], channel="Staff app", text=f"Tomorrow please report to {BRANCH_BY_ID[best['rb']]['name']} branch at 9:45 ({when}), {POOL_LABEL[best['pool']].lower()}."),
                    dict(to=MANAGERS[best["db"]], channel="Staff app", text=f"{st['name']} is lent to {BRANCH_BY_ID[best['rb']]['name']} tomorrow ({when}). Your counters stay within target.")])
        rec["donor_impact"] = dict(avg_wait_before=round(D["ev_after"]["_branch"]["avg_wait"], 1), avg_wait_after=round(best["ev_d"]["_branch"]["avg_wait"], 1),
                                   peak_wait_after=round(best["ev_d"]["_branch"]["peak_wait"], 1))
        R["steps"].append(rec)
        R["day"], R["plan"], R["ev_after"] = best["rday"], best["rplan"], best["ev_r"]
        D["plan"], D["ev_after"] = best["dplan"], best["ev_d"]
        D.setdefault("lent", []).append(dict(staff=best["sid"], name=st["name"], to=best["rb"], blocks=list(best["blocks"])))
        moves.append(dict(date=date_str, staff=best["sid"], name=st["name"], from_branch=best["db"], to_branch=best["rb"],
                          pool=best["pool"], blocks=list(best["blocks"]), km=round(best["km"], 1)))
    return moves


def main():
    from forecast import driver_short as driver_label
    fh = pd.read_csv(OUT / "forecast_hourly.csv")
    summ = json.load(open(OUT / "forecast_summary.json"))
    ctx = load_context()
    ap = ctx["appts"]
    out = dict(days={}, network={})
    for d in sorted(fh["date"].unique()):
        results = {}
        for b in BRANCHES:
            bid = b["id"]
            rows = fh[(fh["date"] == d) & (fh["branch"] == bid)]
            lam = {s: [float(rows[(rows["service"] == s) & (rows["hour"] == h)]["pred"].sum()) for h in range(10, 16)] for s in SERVICE_ORDER}
            day = build_day(bid, d, lam)
            cal = summ["days"][f"{d}|{bid}"]["calendar"]
            labels = {g: driver_label(g, cal) for g in ["recent", "month_start", "holiday", "life_cert", "year_end", "festival", "crop", "fee", "appointments"]}
            appts = ap[(ap["branch_code"] == bid) & (ap["slot_date"] == d)]
            steps, levers, plan, ev0, ev, exp = build_plan(day, ctx, rows, appts, d)
            alerts = make_alerts(ev0, day, rows, labels)
            results[bid] = dict(day=day, steps=steps, levers=levers, plan=plan, ev_before=ev0, ev_after=ev, exp=exp,
                                alerts=alerts, appts=appts, home=home_plan(day))
        out["network"][d] = network_pass(results, d, ctx)
        out["days"][d] = {}
        for bid, R in results.items():
            appts = R["appts"]
            out["days"][d][bid] = dict(
                alerts=R["alerts"], steps=R["steps"], experience=R["exp"],
                kpi_before=kpis(R["ev_before"]), kpi_after=kpis(R["ev_after"]),
                home_plan=R["home"], plan=R["plan"], levers=R["levers"],
                absent=R["day"]["absent"], present=[k for k in R["day"]["staff"] if R["day"]["staff"][k].get("home") != "AWAY"],
                staff={k: dict(name=v["name"], role=v["role"], home=v["home"], factor=v["factor"]) for k, v in R["day"]["staff"].items()},
                lent=R.get("lent", []),
                appointments={s: [int(((appts["service"] == s) & (appts["hour"] == h)).sum()) for h in range(10, 16)] for s in ("LOAN", "ACCOUNT")},
                seniors=[round(sum(R["day"]["lam"][s][h] * ctx["senior"].get((bid, s), 0.2) for s in SERVICE_ORDER), 1) for h in range(6)],
                nondigital=[round(sum(R["day"]["lam"][s][h] * (1 - ctx["digital"].get((bid, s), 0.5)) for s in SERVICE_ORDER), 1) for h in range(6)],
            )
        k0, k1 = out["days"][d]["B01"]["kpi_before"], out["days"][d]["B01"]["kpi_after"]
        print(d, "network moves:", [(m["name"], m["from_branch"], m["to_branch"], m["blocks"]) for m in out["network"][d]])
        for bid in results:
            kb, ka = out["days"][d][bid]["kpi_before"], out["days"][d][bid]["kpi_after"]
            print(f"   {bid} avg {kb['avg_wait']}->{ka['avg_wait']}  peak {kb['peak_wait']}->{ka['peak_wait']}  walk {kb['walkouts']}->{ka['walkouts']}  "
                  f"alerts={len(out['days'][d][bid]['alerts'])} steps={[s['kind'] for s in out['days'][d][bid]['steps']]}")
    out["digital_share"] = {f"{b}|{s}": round(v, 3) for (b, s), v in ctx["digital"].items()}
    out["hv_share"] = {k: round(v, 3) for k, v in ctx["hv"].items()}
    out["lang_mix"] = ctx["lang"]
    json.dump(out, open(OUT / "recommendations.json", "w"), indent=1, default=float)


if __name__ == "__main__":
    main()
