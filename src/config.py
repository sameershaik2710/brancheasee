"""
Central configuration for the Branch Load Optimizer prototype.

Everything a bank would tune lives here: branches, services, staff, calendar
effects, redirection options and the rupee assumptions used for impact.
All figures are synthetic / illustrative and clearly marked as assumptions.
"""
from datetime import date

SEED = 2026

# ----------------------------------------------------------------------------
# Time window
# ----------------------------------------------------------------------------
HIST_START = date(2025, 4, 1)       # first day of synthetic history (18 months)
HIST_END = date(2026, 9, 30)        # "today" - planning happens this evening
FUTURE_END = date(2026, 10, 7)      # forecast horizon (next working week)
HOLDOUT_START = date(2026, 9, 1)    # model is evaluated on September 2026

OPEN_MIN = 0            # 10:00 -> minute 0
CLOSE_MIN = 360         # 16:00 -> tokens stop being issued
HOURS = [10, 11, 12, 13, 14, 15]  # public-dealing hours
BIN_MIN = 15            # queue model resolution

# ----------------------------------------------------------------------------
# Service catalogue (grouped categories) and which counter pool serves them
# ----------------------------------------------------------------------------
POOLS = ["CASH", "GENERAL", "EXPERT"]
POOL_LABEL = {"CASH": "Cash counter", "GENERAL": "General counter", "EXPERT": "Loans & advisory desk"}

SERVICES = {
    "CASH":     dict(label="Cash deposit / withdrawal", pool="CASH",    mean=6.0,  cv=0.55),
    "PASSBOOK": dict(label="Passbook & enquiry",        pool="GENERAL", mean=2.2,  cv=0.50),
    "ACCOUNT":  dict(label="Account services & KYC",    pool="GENERAL", mean=7.0,  cv=0.60),
    "REMIT":    dict(label="DD / NEFT / cheques",       pool="GENERAL", mean=6.0,  cv=0.55),
    "PENSION":  dict(label="Pension & life certificate", pool="GENERAL", mean=6.0, cv=0.50),
    "LOAN":     dict(label="Loans, FD & advisory",      pool="EXPERT",  mean=15.0, cv=0.60),
}
SERVICE_ORDER = list(SERVICES)

# Raw sub-types as they appear on the token machine (messy on purpose) and the
# relative service time of each sub-type within its category.
SUBTYPES = {
    "CASH": [("Cash Withdrawal", 1.0, 0.55), ("Cash Deposit", 1.05, 0.45)],
    "PASSBOOK": [("Passbook Update", 1.0, 0.7), ("Balance Enquiry", 0.8, 0.3)],
    "ACCOUNT": [("KYC Update", 1.0, 0.30), ("Account Opening", 1.6, 0.20), ("Mobile Number Update", 0.6, 0.25),
                ("Address Change", 0.8, 0.10), ("Nominee Registration", 0.7, 0.15)],
    "REMIT": [("Demand Draft", 1.75, 0.40), ("NEFT/RTGS", 0.65, 0.35), ("Cheque Deposit", 0.45, 0.25)],
    "PENSION": [("Life Certificate", 1.0, 0.55), ("Pension Query", 1.1, 0.45)],
    "LOAN": [("Home Loan Enquiry", 1.2, 0.20), ("Gold Loan", 0.9, 0.25), ("Crop Loan (KCC)", 1.1, 0.15),
             ("FD Opening / Renewal", 0.6, 0.30), ("NRI Services", 1.3, 0.10)],
}
# Variant spellings seen in token-machine exports (preprocessing must group these)
RAW_VARIANTS = {
    "Cash Withdrawal": ["Cash Withdrawal", "cash wdl", "CASH WITHDRAWAL", "Withdrawal - slip"],
    "Cash Deposit": ["Cash Deposit", "CASH DEP", "cash dep.", "Deposit (Cash)"],
    "Passbook Update": ["Passbook Update", "PB print", "passbook", "Pass Book Entry"],
    "Balance Enquiry": ["Balance Enquiry", "bal enq", "Enquiry"],
    "KYC Update": ["KYC Update", "Re-KYC", "kyc", "KYC updation"],
    "Account Opening": ["Account Opening", "A/c Opening", "New Account", "AC OPEN"],
    "Mobile Number Update": ["Mobile Number Update", "Mobile No Update", "mob no change"],
    "Address Change": ["Address Change", "addr change", "Change of Address"],
    "Nominee Registration": ["Nominee Registration", "Nominee Regn", "nomination"],
    "Demand Draft": ["Demand Draft", "DD", "dd issue", "D.D."],
    "NEFT/RTGS": ["NEFT/RTGS", "NEFT", "RTGS", "neft transfer"],
    "Cheque Deposit": ["Cheque Deposit", "Chq Deposit", "cheque"],
    "Life Certificate": ["Life Certificate", "Jeevan Pramaan", "life cert", "LC submission"],
    "Pension Query": ["Pension Query", "pension arrears", "Pension"],
    "Home Loan Enquiry": ["Home Loan Enquiry", "Home Loan Enq", "HL enquiry"],
    "Gold Loan": ["Gold Loan", "gold loan", "GL"],
    "Crop Loan (KCC)": ["Crop Loan (KCC)", "KCC", "crop loan", "KCC/Crop Loan"],
    "FD Opening / Renewal": ["FD Opening / Renewal", "FD Opening", "FD Renewal", "fixed deposit"],
    "NRI Services": ["NRI Services", "NRI A/c", "NRE/NRO"],
}

# Hour-of-day shape (10..15) per service on a normal day
HOUR_PROFILE = {
    "CASH":     [0.20, 0.22, 0.19, 0.13, 0.14, 0.12],
    "PASSBOOK": [0.22, 0.23, 0.18, 0.12, 0.14, 0.11],
    "ACCOUNT":  [0.18, 0.21, 0.19, 0.13, 0.16, 0.13],
    "REMIT":    [0.18, 0.22, 0.20, 0.13, 0.15, 0.12],
    "PENSION":  [0.26, 0.25, 0.19, 0.10, 0.12, 0.08],
    "LOAN":     [0.14, 0.20, 0.20, 0.14, 0.18, 0.14],
}

DOW_FACTOR = {0: 1.20, 1: 1.02, 2: 0.95, 3: 0.94, 4: 1.02, 5: 1.08}   # Mon..Sat

# ----------------------------------------------------------------------------
# Branch network (fictional branches of a fictional bank, Bengaluru region)
# ----------------------------------------------------------------------------
BRANCHES = [
    dict(id="B01", name="Jayanagar", kind="Urban - residential", lat=12.9299, lon=77.5826,
         base=280, senior=0.38, digital=0.58, hv=0.10, rural=0.0,
         mix=dict(CASH=0.33, PASSBOOK=0.17, ACCOUNT=0.15, REMIT=0.12, PENSION=0.10, LOAN=0.07),
         langs=dict(Kannada=0.55, English=0.25, Hindi=0.10, Tamil=0.10)),
    dict(id="B02", name="Whitefield", kind="Urban - IT corridor", lat=12.9698, lon=77.7500,
         base=180, senior=0.12, digital=0.88, hv=0.16, rural=0.0,
         mix=dict(CASH=0.24, PASSBOOK=0.10, ACCOUNT=0.24, REMIT=0.14, PENSION=0.02, LOAN=0.14),
         langs=dict(English=0.45, Kannada=0.20, Hindi=0.20, Telugu=0.15)),
    dict(id="B03", name="Malleshwaram", kind="Urban - residential", lat=13.0035, lon=77.5709,
         base=240, senior=0.42, digital=0.54, hv=0.12, rural=0.0,
         mix=dict(CASH=0.32, PASSBOOK=0.17, ACCOUNT=0.14, REMIT=0.12, PENSION=0.11, LOAN=0.08),
         langs=dict(Kannada=0.60, English=0.20, Tamil=0.10, Hindi=0.10)),
    dict(id="B04", name="Hoskote", kind="Semi-urban", lat=13.0707, lon=77.7982,
         base=160, senior=0.25, digital=0.38, hv=0.05, rural=0.7,
         mix=dict(CASH=0.40, PASSBOOK=0.18, ACCOUNT=0.12, REMIT=0.08, PENSION=0.07, LOAN=0.10),
         langs=dict(Kannada=0.75, Hindi=0.10, Telugu=0.10, English=0.05)),
    dict(id="B05", name="Devanahalli", kind="Rural", lat=13.2473, lon=77.7110,
         base=125, senior=0.28, digital=0.26, hv=0.04, rural=1.0,
         mix=dict(CASH=0.47, PASSBOOK=0.17, ACCOUNT=0.09, REMIT=0.05, PENSION=0.08, LOAN=0.09),
         langs=dict(Kannada=0.80, Telugu=0.10, Hindi=0.05, English=0.05)),
]
BRANCH_BY_ID = {b["id"]: b for b in BRANCHES}

# Demand shifts across branches (the PS asks for these explicitly)
DEMAND_SHIFTS = [
    dict(branch="B02", kind="trend", start=date(2025, 4, 1), pct=0.20,
         note="New residential towers: Whitefield footfall grows ~20% a year"),
    dict(branch="B04", kind="step", start=date(2026, 6, 1), pct=0.20, ramp_days=14,
         note="Nearby branch merged into Hoskote on 1 Jun 2026: +20% footfall, no extra staff"),
    dict(branch="B05", kind="service_step", start=date(2026, 3, 1), pct=-0.20, service="CASH",
         note="Bank Mitra (BC) outlet opened near Devanahalli on 1 Mar 2026: cash visits -20%"),
]

# ----------------------------------------------------------------------------
# Staff (fictional). skills = {pool: speed factor}; <1 faster, >1 slower
# ----------------------------------------------------------------------------
STAFF = [
    # Jayanagar
    dict(id="JAY01", branch="B01", name="Lakshmi N", role="Cashier (senior)", home="CASH", skills=dict(CASH=0.9)),
    dict(id="JAY02", branch="B01", name="Ravi K", role="Cashier", home="CASH", skills=dict(CASH=1.0, GENERAL=1.1)),
    dict(id="JAY03", branch="B01", name="Manjunath B", role="Cashier", home="CASH", skills=dict(CASH=1.0)),
    dict(id="JAY04", branch="B01", name="Priya S", role="Customer service officer", home="GENERAL", skills=dict(GENERAL=1.0, CASH=1.1)),
    dict(id="JAY05", branch="B01", name="Arun R", role="Customer service officer", home="GENERAL", skills=dict(GENERAL=1.0)),
    dict(id="JAY06", branch="B01", name="Kavya H", role="Customer service associate", home="GENERAL", skills=dict(GENERAL=1.15)),
    dict(id="JAY08", branch="B01", name="Farida Z", role="Customer service officer", home="GENERAL", skills=dict(GENERAL=1.0, CASH=1.15)),
    dict(id="JAY07", branch="B01", name="Deepa M", role="Loans & advisory officer", home="EXPERT", skills=dict(EXPERT=0.9, GENERAL=1.0)),
    # Whitefield
    dict(id="WHF01", branch="B02", name="Rohan D", role="Cashier", home="CASH", skills=dict(CASH=1.0, GENERAL=1.1)),
    dict(id="WHF02", branch="B02", name="Sneha P", role="Cashier", home="CASH", skills=dict(CASH=1.0)),
    dict(id="WHF03", branch="B02", name="Imran A", role="Customer service officer", home="GENERAL", skills=dict(GENERAL=1.0, CASH=1.05)),
    dict(id="WHF04", branch="B02", name="Nisha V", role="Customer service officer", home="GENERAL", skills=dict(GENERAL=0.95)),
    dict(id="WHF05", branch="B02", name="Karthik M", role="Loans & advisory officer", home="EXPERT", skills=dict(EXPERT=0.9, GENERAL=1.0)),
    dict(id="WHF06", branch="B02", name="Ananya R", role="NRI & wealth officer", home="EXPERT", skills=dict(EXPERT=1.0)),
    dict(id="WHF07", branch="B02", name="Farhan Q", role="Floating officer", home="GENERAL", skills=dict(GENERAL=1.0, CASH=1.0)),
    # Malleshwaram
    dict(id="MAL01", branch="B03", name="Shankar G", role="Cashier (senior)", home="CASH", skills=dict(CASH=0.9, GENERAL=1.1)),
    dict(id="MAL02", branch="B03", name="Rekha T", role="Cashier", home="CASH", skills=dict(CASH=1.0)),
    dict(id="MAL03", branch="B03", name="Venkatesh L", role="Cashier", home="CASH", skills=dict(CASH=1.0)),
    dict(id="MAL04", branch="B03", name="Meera J", role="Customer service officer", home="GENERAL", skills=dict(GENERAL=1.0, CASH=1.1)),
    dict(id="MAL05", branch="B03", name="Sanjay P", role="Customer service officer", home="GENERAL", skills=dict(GENERAL=1.0)),
    dict(id="MAL06", branch="B03", name="Pooja K", role="Customer service associate", home="GENERAL", skills=dict(GENERAL=1.15)),
    dict(id="MAL07", branch="B03", name="Gopal S", role="Loans & advisory officer", home="EXPERT", skills=dict(EXPERT=0.9, GENERAL=1.0)),
    # Hoskote
    dict(id="HSK01", branch="B04", name="Nagaraj C", role="Cashier", home="CASH", skills=dict(CASH=1.0)),
    dict(id="HSK02", branch="B04", name="Savitha R", role="Cashier", home="CASH", skills=dict(CASH=1.0, GENERAL=1.1)),
    dict(id="HSK03", branch="B04", name="Mohan K", role="Customer service officer", home="GENERAL", skills=dict(GENERAL=1.0, CASH=1.1)),
    dict(id="HSK04", branch="B04", name="Asha B", role="Customer service officer", home="GENERAL", skills=dict(GENERAL=1.0)),
    dict(id="HSK05", branch="B04", name="Harish N", role="Agri & loans officer", home="EXPERT", skills=dict(EXPERT=0.95, GENERAL=1.0)),
    # Devanahalli
    dict(id="DEV01", branch="B05", name="Basavaraj H", role="Cashier", home="CASH", skills=dict(CASH=1.0, GENERAL=1.1)),
    dict(id="DEV02", branch="B05", name="Shobha M", role="Cashier", home="CASH", skills=dict(CASH=1.0)),
    dict(id="DEV03", branch="B05", name="Ramesh Y", role="Customer service officer", home="GENERAL", skills=dict(GENERAL=1.0, CASH=1.1)),
    dict(id="DEV04", branch="B05", name="Girish A", role="Agri & loans officer", home="EXPERT", skills=dict(EXPERT=0.95, GENERAL=1.05)),
]
MANAGERS = {"B01": "Suresh H", "B02": "Anjali K", "B03": "Prakash V", "B04": "Latha S", "B05": "Kumar R"}
REGIONAL_MANAGER = "Regional Office, Bengaluru East"

# Planned absences known in advance (history + next week)
PLANNED_LEAVE = [
    dict(staff="HSK02", start=date(2026, 7, 1), end=date(2026, 8, 14), reason="Transfer gap"),
    dict(staff="JAY01", start=date(2026, 10, 1), end=date(2026, 10, 1), reason="Casual leave"),
    dict(staff="MAL05", start=date(2026, 9, 28), end=date(2026, 10, 3), reason="Training"),
    dict(staff="DEV03", start=date(2026, 10, 5), end=date(2026, 10, 6), reason="Casual leave"),
]
UNPLANNED_LEAVE_RATE = 0.035

# ----------------------------------------------------------------------------
# Customer behaviour
# ----------------------------------------------------------------------------
PATIENCE_MEAN = dict(senior=55, regular=35, hv=30)   # minutes before walking out
APPT_SHARE = dict(LOAN=0.35, ACCOUNT=0.10)            # share booked in advance
APPT_SHARE_WHITEFIELD = dict(LOAN=0.55, ACCOUNT=0.20)
NO_SHOW_RATE = 0.18
INCOMPLETE_RATE = dict(ACCOUNT=0.12, LOAN=0.08, PENSION=0.06)   # missing documents -> repeat visit
OUTAGE_PROB = 0.02          # chance a branch-day has a core-banking slowdown
FEEDBACK_RATE = 0.16        # share of served customers who leave a rating

# ----------------------------------------------------------------------------
# Redirection options (share of a service's requests that can be done elsewhere)
# needs_digital=False means usable by anyone (kiosk with help, BC point, doorstep)
# ----------------------------------------------------------------------------
REDIRECT = {
    "PASSBOOK": dict(share=0.90, accept=0.60, needs_digital=False,
                     channel="Self-service passbook kiosk (floor staff assist)", short="the passbook kiosk", noun="passbook", kn="ಪಾಸ್‌ಬುಕ್ ಕಿಯೋಸ್ಕ್ ಬಳಸಿ"),
    "CASH":     dict(share=0.35, accept=0.40, needs_digital=False,
                     channel="Cash deposit machine / ATM, or Bank Mitra point for small amounts", short="cash machines (CDM / ATM)", noun="cash", kn="ನಗದು ಠೇವಣಿ ಯಂತ್ರ / ಎಟಿಎಂ"),
    "ACCOUNT":  dict(share=0.30, accept=0.50, needs_digital=True,
                     channel="Mobile app / ATM for mobile & address updates, Video KYC", short="the mobile app / ATM", noun="account-service", kn="ಮೊಬೈಲ್ ಆಪ್ / ಎಟಿಎಂ"),
    "REMIT":    dict(share=0.40, accept=0.50, needs_digital=True,
                     channel="NEFT/RTGS on net banking or UPI (not DDs)", short="net banking / UPI", noun="NEFT / RTGS", kn="ನೆಟ್ ಬ್ಯಾಂಕಿಂಗ್ / ಯುಪಿಐ"),
    "PENSION":  dict(share=0.40, accept=0.40, needs_digital=False,
                     channel="Jeevan Pramaan digital life certificate or doorstep banking (80+)", short="Jeevan Pramaan / doorstep banking", noun="pension and life-certificate", kn="ಜೀವನ್ ಪ್ರಮಾಣ್ / ಮನೆ ಬಾಗಿಲಿಗೆ ಬ್ಯಾಂಕಿಂಗ್"),
    "LOAN":     dict(share=0.0, accept=0.0, needs_digital=False, channel="Book an appointment slot", short="an appointment slot", noun="loan", kn="ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಬುಕ್ ಮಾಡಿ"),
}

# ----------------------------------------------------------------------------
# Service-level targets and rupee assumptions (illustrative - editable)
# ----------------------------------------------------------------------------
SLA_WAIT = dict(CASH=15, GENERAL=20, EXPERT=30)   # minutes
COST = dict(
    staff_hour=650,          # loaded cost of one staff hour (Rs)
    overtime_hour=975,       # 1.5x for work after closing
    branch_txn=60,           # cost of serving one transaction at a counter (Rs)
    digital_txn=4,           # cost of the same transaction on a digital / self-service channel (Rs)
    walkout_regular=150,     # value at risk when a regular customer walks out
    walkout_hv=3000,         # value at risk when a high-value customer walks out
    floating_trip=400,       # travel + coordination cost to lend one staff member for a half day
)
