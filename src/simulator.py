"""
Discrete-event simulation of one branch-day (SimPy).

Each staff member is a process that pulls the next token from the queue of the
counter pool they are assigned to. Customers join a pool's priority queue
(appointments first) and walk out if they wait longer than their patience.
Staff can switch counters at block boundaries (e.g. 13:00) and take lunch.

The same simulator produces the synthetic history (status-quo staffing) and
re-runs September 2026 with the optimiser's plan for the before/after backtest.
"""
import math
import numpy as np
import simpy

from config import CLOSE_MIN


def simulate_day(cust, staff_plan, outage=None):
    """
    cust: dict of numpy arrays (same length n):
        arrival (min from 10:00), pool (str), prio (0/1), base_dur (min), patience (min)
    staff_plan: list of dicts:
        id, blocks=[(start_min, end_min, pool), ...], lunch=(start, end) or None, factor={pool: speed}
    outage: (start_min, end_min, slow_factor) or None
    Returns dict of arrays: start, end, staff (index into staff_plan, -1 if none), left (bool), left_at
    """
    n = len(cust["arrival"])
    start = np.full(n, np.nan)
    end = np.full(n, np.nan)
    served_by = np.full(n, -1, dtype=int)
    left = np.zeros(n, dtype=bool)
    left_at = np.full(n, np.nan)

    env = simpy.Environment()
    pools = set(cust["pool"]) | {b[2] for s in staff_plan for b in s["blocks"]}
    queues = {p: simpy.PriorityStore(env) for p in pools}

    def pool_at(st, t):
        for a, b, p in st["blocks"]:
            if a <= t < b:
                return p
        return st["blocks"][-1][2]

    def staff_proc(k, st):
        lunch = st.get("lunch")
        had_lunch = lunch is None
        while True:
            t = env.now
            if not had_lunch and t >= lunch[0]:
                yield env.timeout(lunch[1] - lunch[0])
                had_lunch = True
                continue
            pool = pool_at(st, t)
            nb = math.inf
            if not had_lunch:
                nb = lunch[0]
            for a, _, _ in st["blocks"]:
                if a > t:
                    nb = min(nb, a)
            get = queues[pool].get()
            if nb < math.inf:
                yield get | env.timeout(nb - t)
                if not get.triggered:
                    get.cancel()
                    continue
            else:
                yield get
            _, _, i = get.value
            if left[i]:
                continue
            start[i] = env.now
            served_by[i] = k
            f = st["factor"].get(pool, 1.2)
            if outage is not None and outage[0] <= env.now < outage[1]:
                f *= outage[2]
            yield env.timeout(cust["base_dur"][i] * f)
            end[i] = env.now

    def cust_proc(i):
        yield env.timeout(cust["arrival"][i])
        queues[cust["pool"][i]].put((int(cust["prio"][i]), float(cust["arrival"][i]), i))
        yield env.timeout(cust["patience"][i])
        if np.isnan(start[i]):
            left[i] = True
            left_at[i] = env.now

    for k, st in enumerate(staff_plan):
        env.process(staff_proc(k, st))
    for i in range(n):
        env.process(cust_proc(i))
    env.run(until=CLOSE_MIN + 300)
    return dict(start=start, end=end, staff=served_by, left=left, left_at=left_at)


def default_lunch(staff_ids_by_pool):
    """Status-quo lunch: staggered 13:15-13:45 / 13:45-14:15; a one-person desk closes 13:30-14:00."""
    lunch = {}
    for pool, ids in staff_ids_by_pool.items():
        if len(ids) == 1:
            lunch[ids[0]] = (210, 240)
        else:
            for j, sid in enumerate(ids):
                lunch[sid] = (195, 225) if j % 2 == 0 else (225, 255)
    return lunch
