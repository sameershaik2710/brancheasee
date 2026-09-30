"""
Indian banking calendar: which days a branch is open and the calendar events
that drive footfall (month-start pension days, holidays, life-certificate
season, year-end, festivals, crop-loan and school-fee seasons).

Holiday dates are an approximate Karnataka bank-holiday list for Apr 2025 -
Oct 2026. Replace with RBI's official state-wise list before real use.
"""
from datetime import date, timedelta

HOLIDAYS = {
    date(2025, 4, 1): "Annual closing of accounts",
    date(2025, 4, 10): "Mahavir Jayanti",
    date(2025, 4, 14): "Dr. Ambedkar Jayanti",
    date(2025, 4, 18): "Good Friday",
    date(2025, 4, 30): "Basava Jayanti",
    date(2025, 5, 1): "May Day",
    date(2025, 6, 7): "Bakrid",
    date(2025, 8, 8): "Varamahalakshmi Vrata",
    date(2025, 8, 15): "Independence Day",
    date(2025, 8, 27): "Ganesh Chaturthi",
    date(2025, 9, 5): "Id-e-Milad",
    date(2025, 10, 1): "Maha Navami / Ayudha Puja",
    date(2025, 10, 2): "Gandhi Jayanti / Vijayadashami",
    date(2025, 10, 7): "Maharshi Valmiki Jayanti",
    date(2025, 10, 20): "Naraka Chaturdashi",
    date(2025, 10, 22): "Balipadyami (Deepavali)",
    date(2025, 11, 1): "Kannada Rajyotsava",
    date(2025, 11, 8): "Kanakadasa Jayanti",
    date(2025, 12, 25): "Christmas",
    date(2026, 1, 15): "Makara Sankranti",
    date(2026, 1, 26): "Republic Day",
    date(2026, 3, 19): "Ugadi",
    date(2026, 3, 20): "Ramzan (Id-ul-Fitr)",
    date(2026, 3, 31): "Mahavir Jayanti",
    date(2026, 4, 1): "Annual closing of accounts",
    date(2026, 4, 3): "Good Friday",
    date(2026, 4, 14): "Dr. Ambedkar Jayanti",
    date(2026, 5, 1): "May Day",
    date(2026, 5, 27): "Bakrid",
    date(2026, 6, 26): "Muharram",
    date(2026, 8, 15): "Independence Day",
    date(2026, 8, 26): "Id-e-Milad",
    date(2026, 9, 14): "Ganesh Chaturthi",
    date(2026, 10, 2): "Gandhi Jayanti",
    date(2026, 10, 20): "Vijayadashami",
}

FESTIVAL_WEEKS = [  # cash and gold-loan demand rises in the days before
    (date(2025, 8, 4), date(2025, 8, 7), "Varamahalakshmi"),
    (date(2025, 8, 21), date(2025, 8, 26), "Ganesh Chaturthi"),
    (date(2025, 9, 22), date(2025, 9, 30), "Dasara"),
    (date(2025, 10, 13), date(2025, 10, 18), "Deepavali"),
    (date(2025, 12, 19), date(2025, 12, 24), "Christmas"),
    (date(2026, 1, 9), date(2026, 1, 14), "Sankranti"),
    (date(2026, 3, 13), date(2026, 3, 18), "Ugadi / Ramzan"),
    (date(2026, 9, 7), date(2026, 9, 12), "Ganesh Chaturthi"),
    (date(2026, 10, 12), date(2026, 10, 19), "Dasara"),
]


def is_open(d: date) -> bool:
    """Branch open for public dealing? Sundays, 2nd/4th Saturdays and holidays are closed."""
    if d in HOLIDAYS or d.weekday() == 6:
        return False
    if d.weekday() == 5:
        nth = (d.day - 1) // 7 + 1
        if nth in (2, 4):
            return False
    return True


def closure_reason(d: date) -> str:
    if d in HOLIDAYS:
        return HOLIDAYS[d]
    if d.weekday() == 6:
        return "Sunday"
    if d.weekday() == 5:
        return "2nd/4th Saturday"
    return ""


def _run(d: date, step: int) -> int:
    n, x = 0, d + timedelta(days=step)
    while not is_open(x) and n < 10:
        n += 1
        x += timedelta(days=step)
    return n


def working_day_index_in_month(d: date) -> int:
    """1 for the first working day of the month, 2 for the second, ..."""
    idx, x = 0, date(d.year, d.month, 1)
    while x <= d:
        if is_open(x):
            idx += 1
        x += timedelta(days=1)
    return idx


def in_ranges(d, ranges):
    for a, b, name in ranges:
        if a <= d <= b:
            return name
    return ""


def features(d: date) -> dict:
    """Calendar features for an open day (used by both the generator and the model)."""
    wd = working_day_index_in_month(d)
    closed_after, closed_before = _run(d, 1), _run(d, -1)
    next_day = d + timedelta(days=1)
    pre_holiday = int(next_day in HOLIDAYS or closed_after >= 2)
    post_closure = int(closed_before >= 2)
    if d.month == 11:
        lc = 2          # all pensioners submit life certificates in November
    elif d.month == 10:
        lc = 1          # super-senior (80+) window opens on 1 October
    else:
        lc = 0
    year_end = int(d.month == 3 and d.day >= 15)
    crop = int((date(d.year, 6, 1) <= d <= date(d.year, 7, 31)) or (date(d.year, 10, 15) <= d <= date(d.year, 11, 30)))
    fee = int(date(d.year, 4, 2) <= d <= date(d.year, 7, 15))
    festival = in_ranges(d, FESTIVAL_WEEKS)
    return dict(
        dow=d.weekday(), dom=d.day, month=d.month,
        month_start=wd if wd <= 3 else 0,
        pre_holiday=pre_holiday, closed_days_after=closed_after,
        post_closure=post_closure, closed_days_before=closed_before,
        life_cert=lc, year_end=year_end, crop_season=crop, fee_season=fee,
        festival=int(bool(festival)), festival_name=festival,
        next_holiday=HOLIDAYS.get(next_day, ""),
    )


def daterange(a: date, b: date):
    x = a
    while x <= b:
        yield x
        x += timedelta(days=1)
