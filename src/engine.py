"""
Decision engine: turns a footfall forecast into predicted waits, bottleneck
alerts and a recommended plan (redirection, appointment moves, staff
re-deployment, lunch timing, staff lent between branches).

Queue model (per counter pool, 15-minute bins):
  * arrivals from the hourly forecast, split with the observed within-hour shape
    (half of the 10:00 hour arrives in the first 15 minutes - the door-opening crowd)
  * capacity from the staff assigned to the pool and their measured speed
  * waiting = time to clear the backlog + Erlang-C waiting at the bin's load
  * customers walk out with gamma-distributed patience (shape 2.5)
The same model is mirrored in dashboard/engine.js so the what-if simulator and
approvals recompute instantly in the browser.
"""
import math
from itertools import product

from config import POOLS, SERVICES, SERVICE_ORDER, SLA_WAIT, COST, REDIRECT, BIN_MIN

NB_DAY = 24                 # 10:00-16:00 in 15-minute bins
NB_MAX = NB_DAY + 16        # up to 4 hours of overtime to clear the queue
AM_BINS = 12                # 10:00-13:00 is the morning block
PATIENCE = dict(CASH=30.0, GENERAL=33.0, EXPERT=51.0)   # calibrated against the simulation (calibrate.py)
POOL_OF = {s: SERVICES[s]["pool"] for s in SERVICE_ORDER}


# ----------------------------------------------------------------------------
# maths helpers (kept dependency-free so the JS port is line-for-line)
# ----------------------------------------------------------------------------
def erfc(x):
    # Abramowitz & Stegun 7.1.26
    t = 1.0 / (1.0 + 0.3275911 * x)
    y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
    return y * math.exp(-x * x)


def walk_prob(w, patience_mean):
    """P(patience < w) for gamma(shape 2.5) patience with the given mean."""
    if w <= 0:
        return 0.0
    x = w / (patience_mean / 2.5)
    q = erfc(math.sqrt(x)) + (1.5 * math.sqrt(x) + x ** 1.5) * math.exp(-x) / (0.75 * math.sqrt(math.pi))
    return min(1.0, max(0.0, 1.0 - q))


RHO_CAP = 0.85        # steady-state term only up to this load; overload is carried by the backlog
CV_FACTOR = 0.65      # Allen-Cunneen (1 + cv^2) / 2 with service-time cv ~0.55 from the logs
T_WINDOW = 120.0      # a branch queue never reaches steady state: damp by relaxation time (Whitt)


def erlang_c_wait(c, A, s):
    """Mean queueing delay (minutes) for M/G/c (Allen-Cunneen) with offered load A and mean service time s."""
    if c <= 0:
        return 0.0
    A = min(A, RHO_CAP * c)
    if A <= 0:
        return 0.0
    term, total = 1.0, 1.0
    for k in range(1, c):
        term *= A / k
        total += term
    top = term * A / c * c / (c - A)
    pw = top / (total + top)
    rho = A / c
    tau = s / (c * (1 - math.sqrt(rho)) ** 2)
    return CV_FACTOR * pw * s / (c - A) * (1 - math.exp(-T_WINDOW / tau))


# ----------------------------------------------------------------------------
# inputs
# ----------------------------------------------------------------------------
def bin_arrivals(lam, within, levers):
    """lam[service][hour_idx] -> arrivals per service per bin after redirection / rescheduling."""
    red = levers.get("redirect", {})
    out = {s: [0.0] * NB_MAX for s in SERVICE_ORDER}
    for s in SERVICE_ORDER:
        hourly = list(lam[s])
        for r in levers.get("reschedule", []):
            if r["service"] == s:
                mv = min(r["count"], hourly[r["from_hour"]])
                hourly[r["from_hour"]] -= mv
                hourly[r["to_hour"]] += mv
        keep = 1.0 - red.get(s, 0.0)
        for h in range(6):
            for q in range(4):
                out[s][h * 4 + q] = hourly[h] * keep * within[h][q]
    return out


def lunch_intervals(plan, staff_ids, policy):
    """Lunch windows (minutes from 10:00) given who works where in the afternoon."""
    by_pool = {}
    for sid in staff_ids:
        by_pool.setdefault(plan[sid]["PM"], []).append(sid)
    out = {}
    for pool, ids in by_pool.items():
        ids = sorted(ids)
        if len(ids) == 1:
            out[ids[0]] = (210, 240)
        elif policy == "one_at_a_time":
            for j, sid in enumerate(ids):
                out[sid] = (180 + 30 * j, 210 + 30 * j)
        else:
            for j, sid in enumerate(ids):
                out[sid] = (195, 225) if j % 2 == 0 else (225, 255)
    return out


def evaluate(day, plan, levers=None):
    """
    day: dict(lam={service:[6]}, within=[[4]x6], svc_mean={service:min}, staff={id:{factor:{pool:f}}})
    plan: {staff_id: {"AM": pool, "PM": pool}}  (only staff who are present)
    levers: redirect {service: fraction}, reschedule [...], lunch "standard"|"one_at_a_time"
    """
    levers = levers or {}
    arr = bin_arrivals(day["lam"], day["within"], levers)
    lunch = lunch_intervals(plan, list(plan), levers.get("lunch", "standard"))
    res = {}
    for pool in POOLS:
        svcs = [s for s in SERVICE_ORDER if POOL_OF[s] == pool]
        a = [sum(arr[s][b] for s in svcs) for b in range(NB_MAX)]
        tot = {s: sum(arr[s]) for s in svcs}
        day_mix_s = sum(tot[s] * day["svc_mean"][s] for s in svcs) / max(1e-9, sum(tot.values())) if sum(tot.values()) > 0 else \
            sum(day["svc_mean"][s] for s in svcs) / len(svcs)
        waits, walks, served_w = [0.0] * NB_MAX, [0.0] * NB_MAX, [0.0] * NB_MAX
        servers = [0] * NB_MAX
        mu = [0.0] * NB_MAX
        for b in range(NB_MAX):
            lam_b = sum(arr[s][b] for s in svcs)
            s_b = sum(arr[s][b] * day["svc_mean"][s] for s in svcs) / lam_b if lam_b > 1e-9 else day_mix_s
            t0 = b * BIN_MIN
            block = "AM" if b < AM_BINS else "PM"
            r, c = 0.0, 0
            for sid, asg in plan.items():
                if asg[block] != pool:
                    continue
                lw = lunch.get(sid)
                if lw and lw[0] <= t0 < lw[1]:
                    continue
                f = day["staff"][sid]["factor"].get(pool, 1.2)
                r += 1.0 / (s_b * f)
                c += 1
            servers[b], mu[b] = c, r
        B, last_busy = 0.0, 0
        for b in range(NB_MAX):
            ab = a[b]
            c, r = servers[b], mu[b]
            if c == 0:
                k = b
                while k < NB_MAX and servers[k] == 0:
                    k += 1
                r_next = mu[k] if k < NB_MAX else 1e-6
                W = (k - b) * BIN_MIN - BIN_MIN / 2 + B / max(r_next, 1e-6) if ab > 0 or B > 0 else 0.0
                cap = 0.0
            else:
                s_eff = c / r
                A = (ab / BIN_MIN) * s_eff
                cap = r * BIN_MIN
                overflow = max(0.0, ab - cap) / 2
                W = B / r + erlang_c_wait(c, A, s_eff) + overflow / r
            p = walk_prob(W, PATIENCE[pool])
            eff = ab * (1 - p)
            waits[b], walks[b], served_w[b] = W, ab * p, eff
            B = max(0.0, B + eff - cap)
            if B > 0.05 or ab > 0.05:
                last_busy = b
        tot_a = sum(a)
        wsum = sum(a[b] * waits[b] for b in range(NB_MAX))
        ssum = sum(served_w[b] * waits[b] for b in range(NB_MAX))
        hourly = []
        for h in range(6):
            ah = sum(a[h * 4:(h + 1) * 4])
            if ah > 1.0:
                hourly.append(sum(a[x] * waits[x] for x in range(h * 4, (h + 1) * 4)) / ah)
        peak = max(hourly or [0.0])      # worst hour (arrival-weighted), robust to one-off 15-min spikes
        overtime = max(0, (last_busy + 1 - NB_DAY) * BIN_MIN)
        res[pool] = dict(
            arrivals=tot_a, walkouts=sum(walks), wait_minutes=wsum,
            avg_wait=wsum / tot_a if tot_a else 0.0, avg_wait_served=ssum / max(1e-9, sum(served_w)),
            peak_wait=peak, overtime_min=overtime,
            breach_bins=[b for b in range(NB_DAY) if waits[b] > SLA_WAIT[pool] and a[b] > 0.3],
            wait_bins=[round(waits[b], 2) for b in range(NB_DAY)], arr_bins=[round(a[b], 2) for b in range(NB_DAY)],
            servers_bins=servers[:NB_DAY],
        )
    tot = sum(res[p]["arrivals"] for p in POOLS)
    res["_branch"] = dict(
        arrivals=tot, walkouts=sum(res[p]["walkouts"] for p in POOLS),
        wait_minutes=sum(res[p]["wait_minutes"] for p in POOLS),
        avg_wait=sum(res[p]["wait_minutes"] for p in POOLS) / tot if tot else 0.0,
        peak_wait=max(res[p]["peak_wait"] for p in POOLS),
        overtime_min=max(res[p]["overtime_min"] for p in POOLS),
        breaches=sum(len(res[p]["breach_bins"]) for p in POOLS),
    )
    return res


def objective(ev, plan, home):
    moves = sum((plan[s]["AM"] != home[s]) + (plan[s]["PM"] != home[s]) for s in plan)
    ot = sum(ev[p]["overtime_min"] for p in POOLS)
    return ev["_branch"]["wait_minutes"] + 30 * ev["_branch"]["walkouts"] + 2 * ot + 8 * moves


def home_plan(day):
    return {sid: {"AM": st["home"], "PM": st["home"]} for sid, st in day["staff"].items() if st.get("present", True)}


def optimize(day, levers=None, start=None, extra_home=None, fixed=None):
    """Best AM/PM counter for each present staff member (exhaustive over skill-feasible choices).
    fixed: set of (staff_id, block) whose assignment must not change (e.g. someone lent to another branch)."""
    levers = levers or {}
    fixed = fixed or set()
    plan = {k: dict(v) for k, v in (start or home_plan(day)).items()}
    home = {sid: day["staff"][sid]["home"] for sid in plan}
    if extra_home:
        home.update(extra_home)
    ids = list(plan)
    best_obj = objective(evaluate(day, plan, levers), plan, home)
    for _ in range(2):
        for block in ("AM", "PM"):
            opts = [[plan[sid][block]] if (sid, block) in fixed else list(day["staff"][sid]["factor"].keys()) for sid in ids]
            for combo in product(*opts):
                trial = {sid: dict(plan[sid]) for sid in ids}
                for sid, pool in zip(ids, combo):
                    trial[sid][block] = pool
                ev = evaluate(day, trial, levers)
                # never leave a pool with demand unstaffed
                if any(ev[p]["arrivals"] > 0.5 and all(trial[x][block] != p for x in ids) for p in POOLS):
                    continue
                o = objective(ev, trial, home)
                if o < best_obj - 1e-6:
                    best_obj, plan = o, trial
    return plan


# ----------------------------------------------------------------------------
# money
# ----------------------------------------------------------------------------
def walkout_value(walkouts, hv_share):
    return walkouts * (hv_share * COST["walkout_hv"] + (1 - hv_share) * COST["walkout_regular"])


def rupees(before, after, hv_share, moved=0.0):
    wo = before["_branch"]["walkouts"] - after["_branch"]["walkouts"]
    ot_b = sum(before[p]["overtime_min"] * max(1, before[p]["servers_bins"][-1]) for p in POOLS)
    ot_a = sum(after[p]["overtime_min"] * max(1, after[p]["servers_bins"][-1]) for p in POOLS)
    return round(walkout_value(wo, hv_share) + (ot_b - ot_a) / 60 * COST["overtime_hour"]
                 + moved * (COST["branch_txn"] - COST["digital_txn"]))
