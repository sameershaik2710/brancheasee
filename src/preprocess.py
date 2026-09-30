"""
Preprocessing - the four steps the PS lists:
  1. group service types      (messy token-machine labels -> sub-types -> 6 categories)
  2. clean timestamps         (two export formats, counter-clock skew, unclosed tokens, duplicates)
  3. anonymise customers      (CIF -> salted hash, mobile dropped, birth year -> age band)
  4. calculate wait indicators (wait, service time, walkout, SLA breach, overtime)
Outputs go to data/processed/ plus a data-quality report used by the dashboard.
"""
import hashlib
import json
import re
from pathlib import Path

import numpy as np
import pandas as pd

from config import SUBTYPES, RAW_VARIANTS, SERVICES, SLA_WAIT, HIST_END, HOURS, SERVICE_ORDER, BIN_MIN
from calendar_in import is_open, daterange

ROOT = Path(__file__).resolve().parents[1]
RAW, OUT = ROOT / "data" / "raw", ROOT / "data" / "processed"
OUT.mkdir(parents=True, exist_ok=True)
SALT = "demo-salt-rotate-in-production"


def norm_label(s: str) -> str:
    s = str(s).lower().strip()
    s = re.sub(r"[^a-z0-9/ ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


VARIANT_TO_SUB = {norm_label(v): sub for sub, vs in RAW_VARIANTS.items() for v in vs}
SUB_TO_CAT = {sub: cat for cat, subs in SUBTYPES.items() for sub, _, _ in subs}


def map_service(raw: str):
    sub = VARIANT_TO_SUB.get(norm_label(raw))
    return sub, SUB_TO_CAT.get(sub, "OTHER") if sub else "OTHER"


def anon(cif) -> str:
    return hashlib.sha256(f"{SALT}{cif}".encode()).hexdigest()[:12]


def age_band(age):
    return pd.cut(age, [0, 29, 44, 59, 79, 200], labels=["18-29", "30-44", "45-59", "60-79", "80+"]).astype(str)


def main():
    q = {}
    t = pd.read_csv(RAW / "token_log_raw.csv", dtype={"call_time": str, "close_time": str})
    q["raw_rows"] = len(t)

    # ---- duplicates
    t = t.drop_duplicates(subset="token_id", keep="first")
    q["duplicates_removed"] = q["raw_rows"] - len(t)

    # ---- timestamps
    a_iso = pd.to_datetime(t["arrival_time"], format="%Y-%m-%d %H:%M:%S", errors="coerce")
    a_alt = pd.to_datetime(t["arrival_time"], format="%d/%m/%Y %H:%M", errors="coerce")
    q["timestamps_alt_format_fixed"] = int((a_iso.isna() & a_alt.notna()).sum())
    t["arrival"] = a_iso.fillna(a_alt)
    t["call"] = pd.to_datetime(t["call_time"], format="%Y-%m-%d %H:%M:%S", errors="coerce")
    t["close"] = pd.to_datetime(t["close_time"], format="%Y-%m-%d %H:%M:%S", errors="coerce")
    skew = t["call"].notna() & (t["call"] < t["arrival"])
    q["clock_skew_fixed"] = int(skew.sum())
    t.loc[skew, "call"] = t.loc[skew, "arrival"]

    # ---- service grouping
    q["raw_service_labels"] = int(t["service_raw"].nunique())
    mapped = t["service_raw"].map(map_service)
    t["subtype"] = mapped.map(lambda x: x[0])
    t["service"] = mapped.map(lambda x: x[1])
    q["service_subtypes"] = int(t["subtype"].nunique())
    q["service_categories"] = int(t["service"].nunique())
    q["unmapped_labels"] = int((t["service"] == "OTHER").sum())
    t["pool"] = t["service"].map(lambda s: SERVICES.get(s, {}).get("pool", "GENERAL"))

    # ---- impute unclosed tokens with the median duration of that sub-type
    t["service_min"] = (t["close"] - t["call"]).dt.total_seconds() / 60
    med = t.groupby("subtype")["service_min"].median()
    unclosed = t["call"].notna() & t["close"].isna()
    q["unclosed_tokens_imputed"] = int(unclosed.sum())
    t.loc[unclosed, "service_min"] = t.loc[unclosed, "subtype"].map(med)
    t.loc[unclosed, "close"] = (t.loc[unclosed, "call"] + pd.to_timedelta(
        (t.loc[unclosed, "service_min"] * 60).round(), unit="s")).astype(t["close"].dtype)

    # ---- anonymise
    t["cust_key"] = t["cif"].map(anon)
    t["age_band"] = age_band(HIST_END.year - t["year_of_birth"])
    t["senior"] = (HIST_END.year - t["year_of_birth"]) >= 60
    t["super_senior"] = (HIST_END.year - t["year_of_birth"]) >= 80
    t["digital"] = t["digital_user"].eq("Y")
    t["hni"] = t["hni_flag"].eq("Y")
    q["customers_anonymised"] = int(t["cust_key"].nunique())
    q["pii_columns_dropped"] = ["cif", "mobile", "year_of_birth"]

    # ---- wait indicators
    t["date"] = t["arrival"].dt.date.astype(str)
    t["hour"] = t["arrival"].dt.hour
    open_ts = pd.to_datetime(t["date"]) + pd.Timedelta(hours=10)
    t["arrival_min"] = (t["arrival"] - open_ts).dt.total_seconds() / 60
    t["wait_min"] = (t["call"] - t["arrival"]).dt.total_seconds() / 60
    t["walkout"] = t["status"].eq("Left")
    t["incomplete"] = t["status"].eq("Incomplete-Docs")
    t["sla_breach"] = t["wait_min"] > t["pool"].map(SLA_WAIT)
    t["overtime_min"] = ((t["close"] - (pd.to_datetime(t["date"]) + pd.Timedelta(hours=16))).dt.total_seconds() / 60).clip(lower=0).fillna(0)
    t["repeat_visit"] = t.duplicated(subset=["cust_key", "subtype"], keep="first") & t.groupby(["cust_key", "subtype"])["date"].transform("nunique").gt(1)

    keep = ["token_id", "branch_code", "date", "hour", "arrival_min", "token_no", "pool", "service", "subtype", "channel",
            "cust_key", "age_band", "senior", "super_senior", "digital", "hni", "preferred_language", "wait_min",
            "service_min", "walkout", "incomplete", "sla_breach", "overtime_min", "repeat_visit", "counter", "staff_id", "status"]
    tok = t[keep].rename(columns={"branch_code": "branch", "preferred_language": "lang"})
    tok.to_csv(OUT / "tokens.csv.gz", index=False)

    # ---- hourly grid (zeros included) for forecasting
    days = [d.isoformat() for d in daterange(pd.to_datetime(tok["date"].min()).date(), HIST_END) if is_open(d)]
    grid = pd.MultiIndex.from_product([sorted(tok["branch"].unique()), days, HOURS, SERVICE_ORDER],
                                      names=["branch", "date", "hour", "service"]).to_frame(index=False)
    agg = tok.groupby(["branch", "date", "hour", "service"]).agg(
        arrivals=("token_id", "size"), walkouts=("walkout", "sum"), wait_mean=("wait_min", "mean"),
        seniors=("senior", "sum"), digital=("digital", "sum")).reset_index()
    hourly = grid.merge(agg, how="left", on=["branch", "date", "hour", "service"])
    hourly[["arrivals", "walkouts", "seniors", "digital"]] = hourly[["arrivals", "walkouts", "seniors", "digital"]].fillna(0).astype(int)
    hourly.to_csv(OUT / "hourly.csv.gz", index=False)

    # ---- appointments booked per slot (known in advance -> forecast feature)
    ap = pd.read_csv(RAW / "appointments_raw.csv")
    ap["service"] = ap["service_raw"].map(lambda r: map_service(r)[1])
    ap["hour"] = ap["slot_time"].str[:2].astype(int)
    ap_agg = ap.groupby(["branch_code", "slot_date", "hour", "service"]).agg(
        booked=("appt_id", "size"), no_show=("status", lambda s: (s == "No-show").sum())).reset_index()
    ap_agg.rename(columns={"branch_code": "branch", "slot_date": "date"}).to_csv(OUT / "appointments_booked.csv", index=False)
    q["appointments"] = int(len(ap))
    q["no_show_rate"] = round(float((ap["status"] == "No-show").sum() / max(1, ap["status"].isin(["No-show", "Attended"]).sum())), 3)

    # ---- roster
    ro = pd.read_csv(RAW / "staff_roster_raw.csv")
    ro.to_csv(OUT / "roster.csv", index=False)

    # ---- feedback joined to its visit
    fb = pd.read_csv(RAW / "feedback_raw.csv")
    fb = fb.merge(tok[["token_id", "service", "subtype", "pool", "hour", "wait_min", "walkout", "senior", "hni", "lang", "incomplete"]],
                  on="token_id", how="left")
    fb.to_csv(OUT / "feedback.csv.gz", index=False)
    q["feedback_records"] = int(len(fb))
    q["feedback_with_text"] = int(fb["comment"].notna().sum())

    # ---- empirical inputs for the queue model
    served = tok[tok["service_min"].notna() & ~tok["counter"].eq("MGR")]
    tok["bin"] = (tok["arrival_min"] % 60 // BIN_MIN).astype(int)
    within = tok.groupby(["hour", "bin"]).size().unstack(fill_value=0)
    within = within.div(within.sum(axis=1), axis=0).round(4)
    # each staff member's speed at their home counter, learned from the logs
    served = served.assign(ratio=served["service_min"] / served["service"].map(served.groupby("service")["service_min"].median()))
    speed = served.groupby("staff_id")["ratio"].median().round(3).to_dict()
    # mean service time per category at "standard" speed (staff speed divided out)
    svc_mean = (served["service_min"] / served["staff_id"].map(speed)).groupby(served["service"]).mean().round(2).to_dict()
    inc_rate = tok.groupby("subtype")["incomplete"].mean().round(4).to_dict()
    sub_time = served.groupby("subtype")["service_min"].median().round(2).to_dict()
    json.dump(dict(service_mean=svc_mean, within_hour=within.to_dict(orient="index"), staff_speed=speed,
                   incomplete_rate=inc_rate, subtype_median=sub_time), open(OUT / "queue_inputs.json", "w"), indent=1)

    q["tokens_clean"] = int(len(tok))
    q["walkout_rate"] = round(float(tok["walkout"].mean()), 4)
    q["avg_wait_served"] = round(float(tok["wait_min"].mean()), 2)
    json.dump(q, open(OUT / "data_quality.json", "w"), indent=1)
    print(json.dumps(q, indent=1))


if __name__ == "__main__":
    main()
