# BranchEase

Prototype for **Banking PS 5: Intelligent Branch Service Load and Customer Experience Optimizer**.

A website with two sides: a **customer app** (plan a visit, crowd meter, skip-the-trip advice, virtual token, appointments, feedback) and a **branch staff dashboard** (forecast, alerts, recommended plan, approvals, what-if, network, feedback, model evidence). Each has its own log in and sign up, and both share the Sahayak chatbot (English, Kannada, Hindi).

It predicts how busy each branch will be, hour by hour and counter by counter, and explains why in plain language. It then recommends what to do (redirect customers, move appointments, re-deploy or borrow staff, stagger lunch) and turns approved actions into messages for staff, the token machine and customers.

## How it maps to the Solution Expectations

| PS asks for | Where it is |
|---|---|
| Anticipate service pressure | LightGBM forecast per branch × service × hour, 7 days ahead (`src/forecast.py`) |
| Load forecasts | Plan tab: forecast, likely range, customers per hour by counter |
| Explanations managers understand | Exact Shapley values vs a normal day, e.g. "Normal Thursday 266 · month-start +145 · holiday tomorrow +44 · life-certificate window +38" |
| Bottleneck alerts | Queue model finds counters over their wait target and says why (demand, leave, lunch) |
| Staff suggestions | Exhaustive skill-aware optimiser for morning/afternoon counters, plus staff lent between nearby branches |
| Customer redirection | Self-service/digital guidance sized by each branch's digital share, appointment moves, token kiosk in English/Kannada/Hindi |
| Insight → decision support → workflow | The three numbered sections of the Plan tab; approvals recompute live, create messages, autopilot and escalation |
| Data considerations | Synthetic logs, rosters, appointments, feedback; cleaning, grouping, anonymisation, wait indicators (`src/preprocess.py`) |

## Results (synthetic data)

- **Forecast error** (September 2026, held out): 9.4% daily vs 21.6% for "same day last week"; 12.3% vs 22.8% on busy days.
- **Backtest**: every September branch-day was planned from the forecast alone, then the same 26,318 customers were replayed through a minute-by-minute simulation. Walkouts fell **1,900 → 1,303 (−31%)**, average wait 6.0 → 5.0 min, and waits over target 13.7% → 10.7%. On the busiest days walkouts fell 640 → 421. Staff lending was excluded, so this is conservative.
- **Tomorrow (Thu 1 Oct: month-start, day before Gandhi Jayanti, a cashier on leave)**: Jayanagar goes from 16.8 to 8.7 min average wait and 126 to 32 likely walkouts with the full plan.
- **Queue model vs simulation**: 2.1 min mean error, 0.87 correlation, walkouts within 9%.

## Run it

```bash
pip install -r requirements.txt
python run_pipeline.py          # ~4 min: data -> model -> plan -> backtest -> dashboard
open website/index.html         # or the single-file website/dist/branchease.html
node tests/parity.js            # checks the browser engine matches the Python engine
```

## Pipeline

| Step | File | What it does |
|---|---|---|
| 1 | `generate_data.py` + `simulator.py` | 18 months, 5 Bengaluru-area branches, ~471K tokens. Demand is driven by the Indian banking calendar (month-start pensions, holidays, November life certificates, year-end, festivals, crop and fee seasons). Queues are simulated with SimPy. Includes demand shifts (Whitefield growth, Hoskote merger, Devanahalli BC outlet), staff shortages and messy exports. |
| 2 | `preprocess.py` | Removes duplicates, parses two timestamp formats, fixes clock skew, imputes unclosed tokens, groups 132 raw labels into 19 sub-types and 6 categories, hashes customer IDs, computes wait/walkout/SLA indicators, learns staff speed from the logs |
| 3 | `forecast.py` | LightGBM (Poisson) with calendar, lag and appointment features; Shapley explanations; error on the held-out month |
| 4 | `engine.py`, `calibrate.py` | 15-minute queue model (backlog + Erlang-C/Allen–Cunneen + gamma patience), staff optimiser, checked against the simulation |
| 5 | `recommend.py` | Alerts, step-by-step plan with impact and ₹ value, messages (English + Kannada), staff lending between branches |
| 6 | `feedback_nlp.py` | Multilingual themes (English, Kannada and Hindi in Latin script), rating vs wait, slow-process and repeat-visit detectors, callback queue, in-branch alerts |
| 7 | `backtest.py` | Before/after on September with the same customers |
| 8 | `export.py`, `build_artifact.py` | Dashboard data and single-file build |

## Website (`website/`)

Plain HTML/JS, no build step. `site.js` (router, landing, customer and staff log in / sign up, demo store), `customer.js`, `staff.js`, `chat.js`, `engine.js` (mirrors `engine.py`, so what-ifs and approvals recompute in the browser), `charts.js`, `data.js` (pipeline output).

Demo accounts: customers Meena Rao (9000000001, Kannada, no mobile banking) and Arjun Kumar (9000000002); staff DB10001 branch manager, DB10002 counter staff, DB10003 regional office, password `demo1234`. New accounts and bookings are stored only in the browser (localStorage); OTPs are shown on screen. Production would use the bank's SMS gateway and staff single sign-on.

The two sides are connected: a manager's approvals change the waits customers see; customer tokens, low ratings and doorstep requests appear on the staff dashboard.

**Sahayak chatbot**: rule-based intents grounded in the forecast and plan, so it works offline; understands Kannada and Hindi, including when typed in English letters ("naale cash ge eshtu rush ide?"). Customers can ask about waits, best time, documents, holidays and nearby branches, book tokens, or raise a complaint. Staff can ask why a day is busy, list alerts, see the plan, run what-ifs ("what if demand is 20% higher and Ravi is on leave?") and approve actions. When the page is opened as a published Claude artifact, questions outside the rules are answered by Claude using the same data.

## Assumptions to state in the pitch

- All data, the bank, branches and staff are synthetic and fictional. Holiday dates are approximate; use RBI's list in production.
- Wait targets: cash 15 min, general 20, loans 30.
- ₹ figures are illustrative: counter transaction ₹60 vs digital ₹4; walkout value ₹150 regular, ₹3,000 high-value; overtime ₹975/hour.
- Self-service take-up when nudged: 30–60% depending on the service.

## Production path

FastAPI service around `src/`, Postgres (Supabase) for live tokens, WhatsApp/SMS through Twilio or Meta's API, voice via Bhashini or Sarvam, an LLM to label new feedback phrasing and polish explanations, and OR-Tools CP-SAT when staff allocation spans many branches.
