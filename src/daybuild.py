"""Helpers that assemble one branch-day's inputs for the engine."""
import json
from pathlib import Path

import pandas as pd

from config import STAFF, POOLS, SERVICE_ORDER, MANAGERS

ROOT = Path(__file__).resolve().parents[1]
PROC = ROOT / "data" / "processed"
_Q = None
_ROSTER = None


def queue_inputs():
    global _Q
    if _Q is None:
        _Q = json.load(open(PROC / "queue_inputs.json"))
    return _Q


def roster():
    global _ROSTER
    if _ROSTER is None:
        _ROSTER = pd.read_csv(PROC / "roster.csv")
    return _ROSTER


def staff_factors(s):
    """Speed at each counter: home-counter speed measured from the logs, other counters from the skill matrix."""
    q = queue_inputs()
    measured = q["staff_speed"].get(s["id"])
    home_cfg = s["skills"][s["home"]]
    scale = measured / home_cfg if measured else 1.0
    return {p: round(f * scale, 3) for p, f in s["skills"].items()}


def within_matrix():
    q = queue_inputs()["within_hour"]
    return [[q[str(h)][str(b)] for b in range(4)] for h in range(10, 16)]


def build_day(branch, date, lam):
    """lam: {service: [6 hourly values]}; staff present from the roster; manager covers an empty desk."""
    ro = roster()
    today = ro[(ro["branch_code"] == branch) & (ro["date"] == date)]
    status = dict(zip(today["staff_id"], today["status"]))
    reason = dict(zip(today["staff_id"], today["remarks"].fillna("")))
    staff = {}
    absent = []
    for s in STAFF:
        if s["branch"] != branch:
            continue
        present = status.get(s["id"], "Present") == "Present"
        if not present:
            absent.append(dict(id=s["id"], name=s["name"], home=s["home"], status=status.get(s["id"]), reason=reason.get(s["id"], "")))
            continue
        staff[s["id"]] = dict(name=s["name"], role=s["role"], home=s["home"], factor=staff_factors(s), present=True)
    for p in POOLS:
        if not any(v["home"] == p for v in staff.values()):
            mid = f"MGR-{branch}"
            staff[mid] = dict(name=f"{MANAGERS[branch]} (Branch manager)", role="Branch manager", home=p,
                              factor={p: 1.15}, present=True)
    return dict(branch=branch, date=date, lam={s: list(lam[s]) for s in SERVICE_ORDER}, within=within_matrix(),
                svc_mean=queue_inputs()["service_mean"], staff=staff, absent=absent)
