/* BranchEase site shell: shared demo store, router, landing page, customer and staff login / sign-up. */
(function () {
  "use strict";
  const D = window.DATA;
  const BR = Object.fromEntries(D.branches.map((b) => [b.id, b]));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = Charts.fmt;

  // ------------------------------------------------------------ demo store (this browser only)
  const EMPTY = () => ({ customers: {}, staff: {}, session: null, tokens: [], feedback: [], requests: [], seq: 0 });
  const Store = {
    data: EMPTY(),
    load() { try { const s = JSON.parse(localStorage.getItem("branchease-demo") || "null"); if (s) this.data = Object.assign(EMPTY(), s); } catch (e) { /* storage unavailable */ } },
    save() { try { localStorage.setItem("branchease-demo", JSON.stringify(this.data)); } catch (e) { /* storage unavailable */ } },
    reset() { this.data = EMPTY(); this.save(); },
  };
  window.Store = Store;
  Store.load();

  const DEMO_CUSTOMERS = {
    "9000000001": { name: "Meena Rao", mobile: "9000000001", branch: "B01", lang: "kn", age: "60-79", digital: false, help: false, demo: true },
    "9000000002": { name: "Arjun Kumar", mobile: "9000000002", branch: "B02", lang: "en", age: "18-59", digital: true, help: false, demo: true },
  };
  const DEMO_STAFF = {
    DB10001: { name: "Suresh H", empId: "DB10001", branch: "B01", role: "manager", demo: true },
    DB10002: { name: "Priya S", empId: "DB10002", branch: "B01", role: "counter", staffId: "JAY04", demo: true },
    DB10003: { name: "Regional Office", empId: "DB10003", branch: "B01", role: "regional", demo: true },
  };
  const DEMO_PASSWORD = "demo1234";
  const customerBy = (m) => Store.data.customers[m] || DEMO_CUSTOMERS[m];
  const staffBy = (id) => Store.data.staff[id] || DEMO_STAFF[id];

  async function hashPw(salt, pw) {
    try {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + "|" + pw));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch (e) {
      let h = 0; for (const c of salt + "|" + pw) h = (h * 31 + c.charCodeAt(0)) | 0; return "h" + h;
    }
  }
  function toast(msg) { const t = document.getElementById("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600); }
  window.UI = { toast, esc, BR };

  // ------------------------------------------------------------ router
  const app = () => document.getElementById("app");
  function go(h) { if (location.hash === "#" + h) route(); else location.hash = "#" + h; }
  function route() {
    const h = (location.hash || "#home").slice(1) || "home";
    const sess = Store.data.session;
    if (window.StaffApp) StaffApp.unmount();
    if (window.CustomerApp) CustomerApp.unmount();
    if (window.Chat) Chat.unmount();
    Charts.hideTip();
    document.title = "BranchEase";
    if (h === "customer") {
      const u = sess && sess.role === "customer" && customerBy(sess.id);
      if (!u) return go("customer-login");
      CustomerApp.mount(app(), u);
    } else if (h === "staff") {
      const u = sess && sess.role === "staff" && staffBy(sess.id);
      if (!u) return go("staff-login");
      StaffApp.mount(app(), u);
    } else if (h === "customer-login") renderCustomerAuth("login");
    else if (h === "customer-signup") renderCustomerAuth("signup");
    else if (h === "staff-login") renderStaffAuth("login");
    else if (h === "staff-signup") renderStaffAuth("signup");
    else renderHome();
    window.scrollTo({ top: 0 });
  }
  window.addEventListener("hashchange", route);
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-logout]");
    if (!t) return;
    Store.data.session = null; Store.save();
    toast("Logged out");
    go("home");
  });
  window.Site = { go, route, customerBy, staffBy };

  // ------------------------------------------------------------ landing
  function crowdRows() {
    const day = D.meta.plan_days[0];
    return D.branches.map((b) => {
      const ev = StaffApp.before(day, b.id);
      let worst = 0, pool = "CASH";
      ["CASH", "GENERAL", "EXPERT"].forEach((p) => { const w = StaffApp.hourlyWait(ev, p)[1]; if (w / D.meta.sla[p] > worst / D.meta.sla[pool]) { worst = w; pool = p; } });
      const r = worst / D.meta.sla[pool];
      const lvl = r < 0.5 ? "q" : r < 1 ? "m" : "b";
      return { b, worst, lvl, total: D.days[day][b.id].explain.total };
    });
  }
  function renderHome() {
    const BT = D.backtest.summary, M = D.model.metrics;
    const rows = crowdRows();
    const mx = Math.max(...rows.map((r) => r.worst), 1);
    const LV = { q: "Quiet", m: "Moderate", b: "Busy" };
    app().innerHTML = `
    <div class="wrap">
      <nav class="nav" aria-label="Main">
        <a class="brand" href="#home" style="color:inherit;text-decoration:none"><div class="mark" aria-hidden="true">T-07</div><div><h1>BranchEase</h1><p>Shorter queues at bank branches</p></div></a>
        <div class="links"><a class="btn" href="#customer-login">Customer log in</a><a class="btn primary" href="#staff-login">Staff log in</a></div>
      </nav>
      <section class="hero2">
        <div>
          <div class="eyebrow" style="margin-bottom:10px">Banking · Problem statement 5</div>
          <h1>Know the rush before it happens.</h1>
          <p class="lead">BranchEase predicts how busy every branch counter will be, hour by hour. Customers see the best time to visit or how to skip the trip. Branch teams get alerts and a ready plan, and approve it in one click.</p>
          <div class="doors">
            <div class="door">
              <div class="eyebrow">For customers</div>
              <div class="t">Plan your visit</div>
              <div class="d">Check the expected wait, get a token from home, book a slot, or finish the job without visiting.</div>
              <div class="acts"><a class="btn primary small" href="#customer-login">Log in</a><a class="btn small" href="#customer-signup">Create account</a></div>
            </div>
            <div class="door">
              <div class="eyebrow">For branch staff</div>
              <div class="t">Plan tomorrow's branch</div>
              <div class="d">Forecast, bottleneck alerts, staff suggestions, customer redirection, and one-click actions.</div>
              <div class="acts"><a class="btn primary small" href="#staff-login">Staff log in</a><a class="btn small" href="#staff-signup">Register</a></div>
            </div>
          </div>
        </div>
        <aside class="slip" aria-label="Crowd meter">
          <div class="sliphead"><span class="mono">CROWD METER</span><span class="mono">${esc(D.meta.day_labels[D.meta.plan_days[0]])} · 11:00</span></div>
          ${rows.map((r) => `<div class="meterrow"><span>${esc(r.b.name)}</span><span class="mbar"><i class="lvl-${r.lvl}" style="width:${Math.max(6, (r.worst / mx) * 100)}%"></i></span><span class="num">${fmt(r.worst, 0)} min</span><span class="chip ${r.lvl === "b" ? "crit" : r.lvl === "m" ? "warn" : "good"}">${LV[r.lvl]}</span></div>`).join("")}
          <div class="slipfoot">Longest expected wait at any counter, if the branch changes nothing. Tomorrow is the first working day of the month and the day before a holiday.</div>
        </aside>
      </section>

      <section class="section">
        <div class="sechead"><h2>How it works</h2></div>
        <div class="grid g-3">
          <div class="card step"><div class="n">1 · PREDICT</div><h3>Forecast every counter, every hour</h3><p class="why">AI learns from 18 months of token data and India's banking calendar: pension days, holidays, festivals, life-certificate season. It explains each forecast in plain words.</p></div>
          <div class="card step"><div class="n">2 · RECOMMEND</div><h3>Spot the queue and suggest the fix</h3><p class="why">It finds where waits will cross the target and suggests what to do: move a trained colleague, send simple jobs to self-service, offer quieter slots, borrow staff from a nearby branch.</p></div>
          <div class="card step"><div class="n">3 · ACT</div><h3>One click, everyone informed</h3><p class="why">The manager approves. Staff, the token machine and customers get messages in English, Kannada or Hindi. Customers see the updated wait in their app.</p></div>
        </div>
      </section>

      <section class="section">
        <div class="grid g-2">
          <div class="card"><div class="eyebrow">Customer app</div><h3 style="font-size:17px;margin:4px 0 10px">What customers can do</h3>
            <ul class="ticks"><li>See the expected wait for their service, hour by hour, and the best time to go</li><li>Find out if the job can be done without visiting (app, ATM, passbook kiosk, Jeevan Pramaan)</li><li>Get a virtual token from home, with an SMS 10 minutes before their turn</li><li>Book an appointment in a quiet slot and get a document checklist</li><li>Compare nearby branches, rate the visit, ask the Sahayak chatbot in their language</li></ul></div>
          <div class="card"><div class="eyebrow">Branch dashboard</div><h3 style="font-size:17px;margin:4px 0 10px">What branch teams get</h3>
            <ul class="ticks"><li>Tomorrow's forecast with the reasons ("+145 because it is pension day")</li><li>Bottleneck alerts by counter and time</li><li>A ranked plan: redirection, appointment moves, staff re-deployment, lunch timing, staff lending</li><li>What-if simulator, network view for the regional office, customer feedback themes</li><li>Approvals, autopilot for low-risk actions, escalation, and a chatbot that answers "why is tomorrow busy?"</li></ul></div>
        </div>
      </section>

      <section class="section">
        <div class="card" style="display:grid;gap:10px">
          <div class="eyebrow">Built for every customer</div>
          <h3 style="font-size:17px;margin:0">No smartphone? No problem.</h3>
          <p class="why ink2" style="margin:0">A voice kiosk at the entrance speaks Kannada, Hindi and English and uses pictures instead of text. Customers with a basic phone get a missed-call token and a voice call before their turn. Seniors and customers who need assistance get a priority lane automatically, and a colleague is alerted only when the kiosk detects confusion.</p>
        </div>
      </section>

      <section class="section">
        <div class="sechead"><h2>Tested on a month the model never saw</h2><p>September 2026 was held back. We planned each day from the forecast alone and replayed the same customers with and without the plan.</p></div>
        <div class="tiles" style="grid-template-columns:repeat(4,minmax(0,1fr))">
          <div class="tile"><div class="k">Customers walking out</div><div class="v num">−${Math.round((1 - BT.walkouts.full_plan / BT.walkouts.before) * 100)}%</div><div class="was">${fmt(BT.walkouts.before)} → ${fmt(BT.walkouts.full_plan)}</div></div>
          <div class="tile"><div class="k">Waits over target</div><div class="v num">${fmt(BT.sla_breach_share.before * 100, 1)}% → ${fmt(BT.sla_breach_share.full_plan * 100, 1)}%</div><div class="was">share of customers served</div></div>
          <div class="tile"><div class="k">Daily forecast error</div><div class="v num">${fmt(M.daily_wape.model * 100, 1)}%</div><div class="was">vs ${fmt(M.daily_wape.seasonal_naive * 100, 1)}% for "same day last week"</div></div>
          <div class="tile"><div class="k">Busy-day forecast error</div><div class="v num">${fmt(M.peak_day_wape.model * 100, 1)}%</div><div class="was">vs ${fmt(M.peak_day_wape.seasonal_naive * 100, 1)}% for "same day last week"</div></div>
        </div>
      </section>
      <div class="foot">BranchEase is a hackathon prototype. Demo Bank, its branches, staff, customers and all figures are synthetic. Accounts you create are stored only in this browser. <button type="button" class="linkbtn" id="resetdemo">Reset demo data</button></div>
    </div>`;
    document.getElementById("resetdemo").onclick = () => { Store.reset(); toast("Demo data cleared"); route(); };
  }

  // ------------------------------------------------------------ auth helpers
  function authShell(role, inner) {
    const other = role === "customer" ? `Work at a branch? <a href="#staff-login">Staff log in</a>` : `Banking with us? <a href="#customer-login">Customer log in</a>`;
    app().innerHTML = `<div class="wrap"><nav class="nav" aria-label="Main"><a class="brand" href="#home" style="color:inherit;text-decoration:none"><div class="mark" aria-hidden="true">T-07</div><div><h1>BranchEase</h1><p>Shorter queues at bank branches</p></div></a><a class="btn" href="#home">Back to home</a></nav>
      <div class="authwrap"><div class="authcard">${inner}<div class="demo-note">Demo only: accounts are kept in this browser. Do not enter real passwords or phone numbers.</div><div class="switchrole">${other}</div></div></div></div>`;
  }
  function fieldErr(form, name, msg) {
    const el = form.querySelector(`[data-err="${name}"]`);
    if (el) el.textContent = msg || "";
    return !msg;
  }
  const branchOptions = (sel) => D.branches.map((b) => `<option value="${b.id}" ${b.id === sel ? "selected" : ""}>${esc(b.name)} (${esc(b.kind)})</option>`).join("");
  const validMobile = (m) => /^[6-9]\d{9}$/.test(m);

  function otpStep(container, mobile, onOk) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    container.innerHTML = `<div class="sms"><b>Demo SMS to ${esc(mobile.slice(0, 2))}XXXXXX${esc(mobile.slice(-2))}</b><br>Your BranchEase code is <span class="mono" style="font-size:16px;font-weight:600">${code}</span>. It expires in 5 minutes.</div>
      <label class="field">One-time code<input id="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 digits"><span class="err" data-err="otp"></span></label>
      <button class="btn primary block" type="button" id="otp-ok">Verify and continue</button>`;
    const f = container;
    const input = f.querySelector("#otp"); input.focus();
    const ok = () => { if (input.value.trim() !== code) return fieldErr(f, "otp", "That code does not match. Check the demo SMS above."); onOk(); };
    f.querySelector("#otp-ok").onclick = ok;
    input.onkeydown = (e) => { if (e.key === "Enter") ok(); };
  }

  // ------------------------------------------------------------ customer auth
  function renderCustomerAuth(mode) {
    const login = mode === "login";
    authShell("customer", `
      <div><span class="rolepill">Customer</span></div>
      <h2>${login ? "Log in to plan your visit" : "Create your account"}</h2>
      <div class="seg" role="tablist"><a class="segl" href="#customer-login" aria-pressed="${login}">Log in</a><a class="segl" href="#customer-signup" aria-pressed="${!login}">Sign up</a></div>
      <form id="cf" novalidate style="display:grid;gap:12px">
      ${login ? `
        <label class="field">Mobile number<input name="mobile" inputmode="numeric" maxlength="10" placeholder="10-digit mobile" autocomplete="tel-national"><span class="err" data-err="mobile"></span></label>
        <button class="btn primary block" type="submit">Send one-time code</button>
        <div class="or">or try a demo customer</div>
        <div style="display:grid;gap:6px">
          <button type="button" class="btn" data-demo="9000000001">Meena Rao · 68, Jayanagar · prefers Kannada, no smartphone banking</button>
          <button type="button" class="btn" data-demo="9000000002">Arjun Kumar · 29, Whitefield · uses mobile banking</button>
        </div>` : `
        <label class="field">Full name<input name="name" autocomplete="name" placeholder="As on your passbook"><span class="err" data-err="name"></span></label>
        <label class="field">Mobile number<input name="mobile" inputmode="numeric" maxlength="10" placeholder="10-digit mobile" autocomplete="tel-national"><span class="err" data-err="mobile"></span></label>
        <label class="field">Your branch<select name="branch">${branchOptions("B01")}</select></label>
        <div class="grid g-2" style="gap:10px">
          <label class="field">Language<select name="lang"><option value="en">English</option><option value="kn">ಕನ್ನಡ Kannada</option><option value="hi">हिंदी Hindi</option></select></label>
          <label class="field">Age<select name="age"><option value="18-59">18–59</option><option value="60-79">60–79</option><option value="80+">80 or older</option></select></label>
        </div>
        <label class="check"><input type="checkbox" name="digital"> I use mobile or internet banking</label>
        <label class="check"><input type="checkbox" name="help"> I may need assistance at the branch (priority lane)</label>
        <button class="btn primary block" type="submit">Send one-time code</button>`}
      </form>
      <div id="otpbox" style="display:grid;gap:12px"></div>`);
    const f = document.getElementById("cf");
    const enter = (mobile) => { Store.data.session = { role: "customer", id: mobile }; Store.save(); go("customer"); };
    f.querySelectorAll("[data-demo]").forEach((b) => { b.onclick = () => enter(b.dataset.demo); });
    f.onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      const mobile = String(fd.get("mobile") || "").trim();
      let ok = fieldErr(f, "mobile", validMobile(mobile) ? "" : "Enter a 10-digit mobile number starting with 6, 7, 8 or 9.");
      if (login) {
        if (ok && !customerBy(mobile)) ok = fieldErr(f, "mobile", "No account uses this number yet. Create one with Sign up.");
        if (!ok) return;
        otpStep(document.getElementById("otpbox"), mobile, () => enter(mobile));
      } else {
        const name = String(fd.get("name") || "").trim();
        ok = fieldErr(f, "name", name.length >= 2 ? "" : "Enter your name.") && ok;
        if (ok && customerBy(mobile)) ok = fieldErr(f, "mobile", "This number already has an account. Log in instead.");
        if (!ok) return;
        const user = { name, mobile, branch: fd.get("branch"), lang: fd.get("lang"), age: fd.get("age"), digital: !!fd.get("digital"), help: !!fd.get("help"), created: new Date().toISOString() };
        otpStep(document.getElementById("otpbox"), mobile, () => { Store.data.customers[mobile] = user; Store.save(); toast("Account created"); enter(mobile); });
      }
    };
  }

  // ------------------------------------------------------------ staff auth
  function renderStaffAuth(mode) {
    const login = mode === "login";
    authShell("staff", `
      <div><span class="rolepill">Branch staff</span></div>
      <h2>${login ? "Staff log in" : "Register as branch staff"}</h2>
      <div class="seg" role="tablist"><a class="segl" href="#staff-login" aria-pressed="${login}">Log in</a><a class="segl" href="#staff-signup" aria-pressed="${!login}">Register</a></div>
      <form id="sf" novalidate style="display:grid;gap:12px">
      ${login ? `
        <label class="field">Employee ID<input name="emp" placeholder="e.g. DB10001" autocomplete="username"><span class="err" data-err="emp"></span></label>
        <label class="field">Password<input name="pw" type="password" autocomplete="current-password"><span class="err" data-err="pw"></span></label>
        <button class="btn primary block" type="submit">Log in</button>
        <div class="or">or try a demo account (password ${DEMO_PASSWORD})</div>
        <div style="display:grid;gap:6px">
          <button type="button" class="btn" data-demo="DB10001">Suresh H · Branch manager, Jayanagar</button>
          <button type="button" class="btn" data-demo="DB10002">Priya S · Counter staff, Jayanagar</button>
          <button type="button" class="btn" data-demo="DB10003">Regional office · all five branches</button>
        </div>` : `
        <label class="field">Full name<input name="name" autocomplete="name"><span class="err" data-err="name"></span></label>
        <label class="field">Employee ID<input name="emp" placeholder="DB followed by 5 digits" autocomplete="username"><span class="err" data-err="emp"></span></label>
        <div class="grid g-2" style="gap:10px">
          <label class="field">Branch<select name="branch" id="sb">${branchOptions("B01")}</select></label>
          <label class="field">Role<select name="role" id="sr"><option value="manager">Branch manager</option><option value="counter">Counter staff</option><option value="regional">Regional office</option></select></label>
        </div>
        <label class="field" id="rosterf" hidden>Your name in the branch roster<select name="staffId" id="sid"></select><span class="muted" style="font-size:12px">Links your account to your counter assignments.</span></label>
        <label class="field">Work email<input name="email" type="email" placeholder="name@demobank.example" autocomplete="email"><span class="err" data-err="email"></span></label>
        <div class="grid g-2" style="gap:10px">
          <label class="field">Password<input name="pw" type="password" autocomplete="new-password"><span class="err" data-err="pw"></span></label>
          <label class="field">Confirm password<input name="pw2" type="password" autocomplete="new-password"><span class="err" data-err="pw2"></span></label>
        </div>
        <div class="muted" style="font-size:12.5px">In a real deployment, new staff accounts use the bank's single sign-on and are approved by the branch manager.</div>
        <button class="btn primary block" type="submit">Create staff account</button>`}
      </form>`);
    const f = document.getElementById("sf");
    const enter = (id) => { Store.data.session = { role: "staff", id }; Store.save(); go("staff"); };
    f.querySelectorAll("[data-demo]").forEach((b) => { b.onclick = () => enter(b.dataset.demo); });
    if (!login) {
      const sb = f.querySelector("#sb"), sr = f.querySelector("#sr"), sid = f.querySelector("#sid"), rf = f.querySelector("#rosterf");
      const sync = () => {
        rf.hidden = sr.value !== "counter";
        sid.innerHTML = Object.entries(D.staff_dir).filter(([, s]) => s.branch === sb.value).map(([id, s]) => `<option value="${id}">${esc(s.name)} · ${esc(s.role)}</option>`).join("");
      };
      sb.onchange = sync; sr.onchange = sync; sync();
    }
    f.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      const emp = String(fd.get("emp") || "").trim().toUpperCase();
      const pw = String(fd.get("pw") || "");
      if (login) {
        const u = staffBy(emp);
        let ok = fieldErr(f, "emp", u ? "" : "We couldn't find that employee ID.");
        if (!ok) return;
        const good = u.demo ? pw === DEMO_PASSWORD : (await hashPw(emp, pw)) === u.pwHash;
        if (!fieldErr(f, "pw", good ? "" : "Wrong password. Demo accounts use " + DEMO_PASSWORD + ".")) return;
        enter(emp);
      } else {
        const name = String(fd.get("name") || "").trim(), email = String(fd.get("email") || "").trim(), pw2 = String(fd.get("pw2") || "");
        let ok = fieldErr(f, "name", name.length >= 2 ? "" : "Enter your name.");
        ok = fieldErr(f, "emp", !/^DB\d{5}$/.test(emp) ? "Use DB followed by 5 digits, e.g. DB12345." : staffBy(emp) ? "This employee ID is already registered." : "") && ok;
        ok = fieldErr(f, "email", /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? "" : "Enter a valid work email.") && ok;
        ok = fieldErr(f, "pw", pw.length >= 8 && /\d/.test(pw) ? "" : "At least 8 characters, including a number.") && ok;
        ok = fieldErr(f, "pw2", pw === pw2 ? "" : "Passwords do not match.") && ok;
        if (!ok) return;
        const role = fd.get("role");
        Store.data.staff[emp] = { name, empId: emp, branch: fd.get("branch"), role, staffId: role === "counter" ? fd.get("staffId") : null, email, pwHash: await hashPw(emp, pw), created: new Date().toISOString() };
        Store.save();
        toast("Staff account created");
        enter(emp);
      }
    };
  }

  // start once every module has loaded
  window.addEventListener("DOMContentLoaded", route);
  if (document.readyState !== "loading") route();
})();
