/* BranchEase - branch staff dashboard. Insight -> decision support -> workflow.
   Exposes window.StaffApp: mount(root, user) plus read helpers used by the customer app and the chatbot. */
window.StaffApp = (function () {
  "use strict";
  const D = window.DATA;
  Engine.configure(D.meta);
  const fmt = Charts.fmt;
  const POOLS = D.meta.pools, PL = D.meta.pool_label, SLA = D.meta.sla;
  const COLOR = { CASH: "var(--s-cash)", GENERAL: "var(--s-gen)", EXPERT: "var(--s-exp)" };
  const BR = Object.fromEntries(D.branches.map((b) => [b.id, b]));
  const HOURS = ["10:00", "11:00", "12:00", "13:00", "14:00", "15:00"];
  const binLab = (i) => { const m = i * 15; return `${10 + Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };
  const rs = (v) => "₹" + fmt(Math.round(v));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const DAYNAME = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-IN", { weekday: "long" });
  const REG = "Regional Office, Bengaluru East";

  const S = {
    day: D.meta.plan_days[0], branch: "B01", tab: "plan",
    approved: {}, dismissed: {}, done: {}, sent: {}, log: [], clock: 17 * 60 + 35,
    autopilot: false, callbacks: {}, liveAck: {},
    wi: null, kiosk: { lang: "en", svc: null, senior: false, digital: false, help: false, bin: 4 },
    user: null, readOnly: false, mounted: false,
  };
  try {
    const saved = JSON.parse(localStorage.getItem("blo-ui") || "{}");
    if (saved.tab) S.tab = saved.tab;
    if (saved.branch && BR[saved.branch]) S.branch = saved.branch;
  } catch (e) { /* storage unavailable */ }
  const TABS = [["plan", "Branch plan"], ["whatif", "What-if simulator"], ["network", "Network"], ["voice", "Customer voice"],
    ["kiosk", "Token kiosk"], ["actions", "Action log"], ["model", "Model & data"]];
  function persist() { try { localStorage.setItem("blo-ui", JSON.stringify({ tab: S.tab, branch: S.branch })); } catch (e) { /* ignore */ } }

  const K = (day, b) => day + "|" + b;
  const setOf = (store, day, b) => (store[K(day, b)] = store[K(day, b)] || new Set());
  const clockStr = () => `${String(Math.floor(S.clock / 60)).padStart(2, "0")}:${String(S.clock % 60).padStart(2, "0")}`;
  function addLog(text, who, day, b) { S.clock += 1; S.log.unshift({ t: clockStr(), text, who: who || "You", day: day || S.day, branch: b || S.branch }); }
  function toast(msg) { const t = document.getElementById("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 2600); }

  // ---------------------------------------------------------------- engine state
  let ver = 0;
  const cache = new Map();
  function baseDay(day, b) {
    const X = D.days[day][b];
    const staff = {};
    for (const sid of Object.keys(X.home_plan)) staff[sid] = X.staff[sid];
    return { lam: X.lam, within: D.meta.within, svc_mean: D.meta.svc_mean, staff };
  }
  function before(day, b) {
    const k = "B|" + K(day, b);
    if (!cache.has(k)) cache.set(k, Engine.evaluate(baseDay(day, b), D.days[day][b].home_plan, {}));
    return cache.get(k);
  }
  function stateFor(day, b) {
    const k = `${K(day, b)}|${ver}`;
    if (cache.has(k)) return cache.get(k);
    const X = D.days[day][b];
    const dayIn = baseDay(day, b);
    dayIn.staff = Object.assign({}, dayIn.staff);
    let plan = Engine.clonePlan(X.home_plan);
    const levers = { redirect: {}, reschedule: [], lunch: "standard" };
    const ap = setOf(S.approved, day, b);
    const borrowed = [];
    X.steps.forEach((st, i) => {
      if (!ap.has(i)) return;
      const e = st.effect;
      if (e.type === "redirect") levers.redirect[e.service] = e.fraction;
      else if (e.type === "reschedule") levers.reschedule.push(...e.moves);
      else if (e.type === "lunch") levers.lunch = e.policy;
      else if (e.type === "staff") e.moves.forEach((m) => { if (plan[m.staff]) plan[m.staff][m.block] = m.to; });
      else if (e.type === "float") {
        dayIn.staff[e.staff] = { name: e.name, role: e.role, home: e.pool, factor: e.factor };
        plan[e.staff] = { AM: "AWAY", PM: "AWAY" };
        e.blocks.forEach((bl) => { plan[e.staff][bl] = e.pool; });
        borrowed.push(e);
      }
    });
    const lent = [];
    for (const ob of D.branches) {
      if (ob.id === b) continue;
      D.days[day][ob.id].steps.forEach((st, i) => {
        if (st.effect.type === "float" && st.effect.from_branch === b && setOf(S.approved, day, ob.id).has(i)) lent.push(Object.assign({ to: ob.id }, st.effect));
      });
    }
    if (lent.length) {
      const fixed = new Set();
      lent.forEach((e) => { if (plan[e.staff]) { e.blocks.forEach((bl) => { plan[e.staff][bl] = "AWAY"; }); fixed.add(e.staff + "|AM"); fixed.add(e.staff + "|PM"); } });
      plan = Engine.optimize(dayIn, levers, plan, fixed);
    }
    const ev = Engine.evaluate(dayIn, plan, levers);
    const res = { dayIn, plan, levers, ev, lent, borrowed };
    cache.set(k, res);
    return res;
  }
  function kpiOf(ev) { return ev._branch; }
  function alertLevel(day, b) {
    const a = D.days[day][b].alerts;
    if (a.some((x) => x.severity === "critical")) return "crit";
    if (a.length) return "warn";
    return "";
  }

  // ---------------------------------------------------------------- actions
  function approve(day, b, i, who) {
    const X = D.days[day][b], st = X.steps[i];
    setOf(S.approved, day, b).add(i); setOf(S.dismissed, day, b).delete(i); ver++;
    addLog(`Approved: ${st.title}`, who || "You", day, b);
  }
  function unapprove(day, b, i) { setOf(S.approved, day, b).delete(i); ver++; addLog(`Undid: ${D.days[day][b].steps[i].title}`, "You", day, b); }
  function dismiss(day, b, i) { setOf(S.dismissed, day, b).add(i); setOf(S.approved, day, b).delete(i); ver++; addLog(`Dismissed: ${D.days[day][b].steps[i].title}`, "You", day, b); }
  function markDone(day, b, i, who) { setOf(S.done, day, b).add(i); addLog(`Scheduled: ${D.days[day][b].experience[i].title}`, who || "You", day, b); }
  function runAutopilot(day) {
    let n = 0, esc = 0;
    for (const br of D.branches) {
      const X = D.days[day][br.id];
      X.steps.forEach((st, i) => {
        if (setOf(S.approved, day, br.id).has(i) || setOf(S.dismissed, day, br.id).has(i)) return;
        if (st.autopilot) { approve(day, br.id, i, "Autopilot"); n++; }
        else { addLog(`No response by 18:00, escalated to ${REG}: ${st.title}`, "Autopilot", day, br.id); esc++; }
      });
      X.experience.forEach((ex, i) => { if (ex.autopilot && !setOf(S.done, day, br.id).has(i)) { markDone(day, br.id, i, "Autopilot"); n++; } });
    }
    return [n, esc];
  }
  function outbox(day, b) {
    const X = D.days[day][b], out = [];
    setOf(S.approved, day, b).forEach((i) => (X.steps[i].notify || []).forEach((m, j) => out.push(Object.assign({ key: `s${i}.${j}`, from: X.steps[i].title }, m))));
    setOf(S.done, day, b).forEach((i) => (X.experience[i].notify || []).forEach((m, j) => out.push(Object.assign({ key: `e${i}.${j}`, from: X.experience[i].title }, m))));
    return out;
  }
  function copyText(text, okMsg) {
    const fallback = () => {
      const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toast(okMsg); } catch (e) { toast("Select the text and copy it manually"); }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast(okMsg), fallback);
    else fallback();
  }

  // ---------------------------------------------------------------- header
  const ROLE_LABEL = { manager: "Branch manager", regional: "Regional office", counter: "Counter staff" };
  function renderHeader() {
    const u = S.user || {};
    document.getElementById("clock").innerHTML = `<div class="userchip"><span class="avatar" aria-hidden="true">${esc((u.name || "?").trim().charAt(0))}</span><span><b>${esc(u.name || "")}</b><br><span class="muted">${esc(ROLE_LABEL[u.role] || "")}${u.branch && BR[u.branch] ? " · " + esc(BR[u.branch].name) : ""}</span></span><button type="button" class="btn small" data-logout>Log out</button></div><div class="muted" style="font:500 11.5px var(--f-mono);margin-top:4px">Planning Wed 30 Sep · ${clockStr()}</div>`;
    const days = document.getElementById("days");
    days.innerHTML = `<span class="lbl">Day</span>` + D.meta.plan_days.map((d, i) =>
      `<button type="button" data-day="${d}" aria-pressed="${d === S.day}">${esc(D.meta.day_labels[d])}${i === 0 ? " · tomorrow" : ""}</button>`).join("");
    const brs = document.getElementById("branches");
    brs.innerHTML = `<span class="lbl">Branch</span>` + D.branches.map((b) => {
      const lv = alertLevel(S.day, b.id);
      const dot = lv ? `<span class="dot" style="background:var(--status-${lv === "crit" ? "crit" : "warn"})" title="${lv === "crit" ? "Critical alert" : "Warning"}"></span>` : "";
      return `<button type="button" data-branch="${b.id}" aria-pressed="${b.id === S.branch}">${esc(b.name)}${dot}</button>`;
    }).join("");
    const tabs = document.getElementById("tabs");
    tabs.innerHTML = TABS.map(([k, l]) => `<button type="button" role="tab" data-tab="${k}" aria-selected="${k === S.tab}">${l}</button>`).join("");
  }
  document.addEventListener("click", (ev) => {
    const t = ev.target.closest("[data-day],[data-branch],[data-tab]");
    if (!S.mounted || !t || !t.closest(".top")) return;
    if (t.dataset.day) { S.day = t.dataset.day; S.wi = null; }
    if (t.dataset.branch) { S.branch = t.dataset.branch; S.wi = null; }
    if (t.dataset.tab) { S.tab = t.dataset.tab; }
    persist(); render(); window.scrollTo({ top: 0 });
  });

  // ---------------------------------------------------------------- shared pieces
  function tilesHTML(cur, bef, X, st) {
    const k = kpiOf(cur), b = kpiOf(bef);
    const tile = (label, v, unit, was, better, dec = 1) => {
      const diff = v - was;
      const cls = Math.abs(diff) < 0.05 ? "" : ((diff < 0) === better ? "good" : "bad");
      const chg = Math.abs(diff) < 0.05 ? "no change yet" : `<span class="chg ${cls}">${diff < 0 ? "−" : "+"}${fmt(Math.abs(diff), dec)}${unit}</span> vs doing nothing`;
      return `<div class="tile"><div class="k">${label}</div><div class="v num">${fmt(v, dec)}<small>${unit.trim()}</small></div><div class="was">${chg}</div></div>`;
    };
    const total = Object.keys(X.home_plan).filter((s) => !s.startsWith("MGR")).length + X.absent.length;
    const on = Object.keys(st.plan).filter((s) => !s.startsWith("MGR") && (st.plan[s].AM !== "AWAY" || st.plan[s].PM !== "AWAY")).length;
    const away = X.absent.map((a) => `${esc(a.name)} (${esc((a.reason || a.status).toLowerCase())})`).join(", ");
    const inn = st.borrowed.length ? ` · ${st.borrowed.map((e) => esc(e.name)).join(", ")} borrowed` : "";
    const out = st.lent.length ? ` · ${st.lent.map((e) => esc(e.name) + " lent to " + esc(BR[e.to].name)).join(", ")}` : "";
    return `<div class="tiles">
      ${tile("Average wait", k.avg_wait, " min", b.avg_wait, true)}
      ${tile("Worst hour at any counter", k.peak_wait, " min", b.peak_wait, true)}
      ${tile("Customers likely to walk out", k.walkouts, "", b.walkouts, true, 0)}
      <div class="tile"><div class="k">Staff on counters</div><div class="v num">${on}<small>of ${total}</small></div>
        <div class="was">${away ? away + " away" : "Full strength"}${inn}${out}</div></div>
    </div>`;
  }

  function waitMultiples(host, evNow, evBefore, labels) {
    host.innerHTML = `<div class="legend"><span><i class="line" style="background:var(--s-before)"></i>${labels[0]}</span><span><i class="line" style="background:var(--ink-2)"></i>${labels[1]} (counter colour)</span><span><i class="line" style="background:var(--status-crit)"></i>Wait target</span></div><div class="multiples"></div>`;
    const grid = host.querySelector(".multiples");
    POOLS.forEach((p) => {
      const box = document.createElement("div");
      const pk = evNow[p].peak_wait, pb = evBefore[p].peak_wait;
      box.innerHTML = `<h4><i style="background:${COLOR[p]}"></i>${PL[p]}</h4><div class="m num">Worst hour ${fmt(pb, 0)} → <b style="color:var(--ink)">${fmt(pk, 0)} min</b> · target ${SLA[p]}</div><div class="chart"></div>`;
      grid.appendChild(box);
      const x = Array.from({ length: 24 }, (_, i) => binLab(i));
      requestAnimationFrame(() => Charts.lines(box.querySelector(".chart"), {
        x, height: 140, unit: " min", xEvery: 8, label: `${PL[p]} predicted wait`,
        tipTitle: (i) => `${PL[p]} · ${binLab(i)}–${binLab(i + 1)}`,
        hline: { value: SLA[p], label: `${SLA[p]} min` },
        series: [
          { name: labels[0], color: "var(--s-before)", values: evBefore[p].wait_bins, width: 1.5, muted: true },
          { name: labels[1], color: COLOR[p], values: evNow[p].wait_bins, width: 2, area: true },
        ],
      }));
    });
  }

  function planTable(day, b, st, showAbsent = true) {
    const X = D.days[day][b];
    const cell = (pool, home) => {
      if (pool === "AWAY") return `<span class="cell-pool away">Away</span>`;
      const moved = pool !== home;
      return `<span class="cell-pool ${moved ? "moved" : ""}"><i style="background:${COLOR[pool]}"></i>${PL[pool].split(" ")[0]}${moved ? " ←" : ""}</span>`;
    };
    const rows = Object.keys(st.plan).map((sid) => {
      const s = st.dayIn.staff[sid];
      const bor = st.borrowed.find((e) => e.staff === sid);
      const lent = st.lent.find((e) => e.staff === sid);
      const note = bor ? `<span class="chip acc">from ${esc(BR[bor.from_branch].name)}</span>` : lent ? `<span class="chip">lent to ${esc(BR[lent.to].name)}</span>` : "";
      return `<tr><td><div>${esc(s.name)} ${note}</div><div class="muted" style="font-size:12px">${esc(s.role)}</div></td>
        <td>${cell(st.plan[sid].AM, bor ? bor.pool : s.home)}</td><td>${cell(st.plan[sid].PM, bor ? bor.pool : s.home)}</td></tr>`;
    }).join("");
    const abs = !showAbsent ? "" : X.absent.map((a) => `<tr><td><div>${esc(a.name)}</div><div class="muted" style="font-size:12px">${esc(D.staff_dir[a.id] ? D.staff_dir[a.id].role : "")}</div></td>
      <td colspan="2"><span class="chip warn">${esc(a.reason || a.status)}</span></td></tr>`).join("");
    return `<div class="tbl-wrap"><table><thead><tr><th>Staff</th><th>10:00–13:00</th><th>13:00–16:00</th></tr></thead><tbody>${rows}${abs}</tbody></table></div>`;
  }

  function planText(day, b) {
    const st = stateFor(day, b), X = D.days[day][b];
    const lines = [`${BR[b].name} branch · plan for ${D.meta.day_labels[day]}`, `Forecast: ${Math.round(X.explain.total)} customers (normal ${DAYNAME(day)}: ${Math.round(X.explain.normal)})`, "", "Counters:"];
    for (const sid of Object.keys(st.plan)) {
      const p = st.plan[sid], s = st.dayIn.staff[sid];
      const f = (x) => x === "AWAY" ? "away" : PL[x];
      lines.push(`- ${s.name}: ${p.AM === p.PM ? f(p.AM) + " all day" : `${f(p.AM)} 10-13, ${f(p.PM)} 13-16`}`);
    }
    const ap = setOf(S.approved, day, b);
    lines.push("", "Approved actions:");
    X.steps.forEach((s2, i) => { if (ap.has(i)) lines.push(`- ${s2.title}`); });
    setOf(S.done, day, b).forEach((i) => lines.push(`- ${X.experience[i].title}`));
    const k = kpiOf(st.ev);
    lines.push("", `Expected: average wait ${k.avg_wait.toFixed(1)} min, worst hour ${k.peak_wait.toFixed(0)} min, about ${Math.round(k.walkouts)} walkouts.`);
    return lines.join("\n");
  }

  // ---------------------------------------------------------------- PLAN
  function renderPlan(v) {
    const day = S.day, b = S.branch, X = D.days[day][b], E = X.explain;
    const st = stateFor(day, b), bef = before(day, b);
    const pct = Math.round((E.total / E.normal - 1) * 100);
    const drv = E.drivers.filter((d) => Math.abs(d.value) >= 2);
    const maxAbs = Math.max(E.normal, ...drv.map((d) => Math.abs(d.value)));
    const barW = (v2) => `${(Math.abs(v2) / maxAbs) * 100}%`;
    const driversHTML = `<div class="drivers">
      <div class="drv base"><div class="t"><b>Normal ${DAYNAME(day)}</b> at ${esc(BR[b].name)}</div><div class="bar"><i style="left:0;width:${barW(E.normal)};background:var(--s-before)"></i></div><div class="v num">${fmt(E.normal)}</div></div>
      ${drv.map((d) => `<div class="drv"><div class="t">${esc(d.label)}</div><div class="bar"><i style="left:0;width:${barW(d.value)};background:${d.value > 0 ? "var(--s-gen)" : "var(--s-cash)"}"></i></div><div class="v num">${d.value > 0 ? "+" : "−"}${fmt(Math.abs(d.value))}</div></div>`).join("")}
      <div class="drv total"><div class="t"><b>Forecast</b></div><div></div><div class="v num">${fmt(E.total)}</div></div>
    </div>`;
    const who = (arr) => arr.reduce((a, x) => a + x, 0);
    const appts = who(X.appointments.LOAN) + who(X.appointments.ACCOUNT);
    const appTok = (window.Store ? Store.data.tokens : []).filter((t) => t.branch === b && t.day === day && t.status !== "cancelled").length;
    const u = S.user || {};
    let shift = "";
    if (u.role === "counter" && u.staffId && st.plan[u.staffId]) {
      const p = st.plan[u.staffId], home = st.dayIn.staff[u.staffId].home;
      const nm = (x) => x === "AWAY" ? "Away" : PL[x];
      const moved = p.AM !== home || p.PM !== home;
      shift = `<div class="card" style="margin-bottom:14px;border-color:${moved ? "var(--accent-line)" : "var(--line)"}"><div class="eyebrow">Your counters on ${esc(D.meta.day_labels[day])}</div>
        <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:6px;font-size:15px"><span>10:00–13:00: <b>${esc(nm(p.AM))}</b></span><span>13:00–16:00: <b>${esc(nm(p.PM))}</b></span>${moved ? '<span class="chip acc">Changed from your usual counter</span>' : '<span class="chip">Usual counter</span>'}</div>
        <div class="muted" style="font-size:12.5px;margin-top:6px">The plan below is read-only for counter staff. Your branch manager approves changes; you'll get a staff-app message.</div></div>`;
    }

    v.innerHTML = `${shift}
    <section class="section">
      <div class="sechead"><span class="layer">1 · Insight</span><h2>What ${esc(D.meta.day_labels[day])} looks like at ${esc(BR[b].name)}</h2>
        <p>Footfall forecast by counter and hour, why it differs from a normal day, and where queues will build if nothing changes.</p></div>
      <div class="grid g-7-5">
        <div class="card hero">
          <div class="eyebrow">${esc(BR[b].kind)} · manager ${esc(BR[b].manager)}</div>
          <div class="big"><span class="n num">${fmt(E.total)}</span><span class="u">customers expected</span>
            <span class="delta ${pct >= 0 ? "up" : "down"}">${pct >= 0 ? "+" : "−"}${Math.abs(pct)}% vs a normal ${DAYNAME(day)}</span></div>
          <div class="range">Likely range ${fmt(E.low)}–${fmt(E.high)} (from September forecast errors) · last 8 ${DAYNAME(day)}s averaged ${fmt(E.typical)}</div>
          ${driversHTML}
          <div class="muted" style="font-size:12px">Each line is that event's exact share of the forecast (Shapley values against a normal day), in customers.</div>
        </div>
        <div style="display:grid;gap:10px;align-content:start">
          ${tilesHTML(st.ev, bef, X, st)}
          <div class="card" style="padding:12px 14px">
            <div class="eyebrow" style="margin-bottom:6px">Who is coming</div>
            <div class="num" style="display:flex;gap:18px;flex-wrap:wrap;font-size:13px">
              <span><b>${fmt(who(X.seniors))}</b> aged 60+</span><span><b>${fmt(who(X.nondigital))}</b> not on digital banking</span><span><b>${fmt(appts)}</b> appointments booked</span>${appTok ? `<span><b>${appTok}</b> virtual ${appTok === 1 ? "token" : "tokens"} from the customer app</span>` : ""}
            </div>
          </div>
        </div>
      </div>
      <div class="grid g-2" style="margin-top:14px">
        <div class="card"><h3>Customers per hour, by counter</h3><p class="sub">Forecast before any redirection</p>
          <div class="legend">${POOLS.map((p) => `<span><i style="background:${COLOR[p]}"></i>${PL[p]}</span>`).join("")}</div>
          <div class="chart" id="c-cols"></div></div>
        <div class="card"><h3>Bottleneck alerts</h3><p class="sub">Where the wait target is breached if nothing changes</p>
          <div class="alerts">${X.alerts.length ? X.alerts.map((a) => `
            <div class="alert ${a.severity}"><div class="stripe"></div><div>
              <div class="ttl"><span class="chip ${a.severity === "critical" ? "crit" : "warn"}">${a.severity === "critical" ? "Critical" : "Warning"}</span>${esc(a.title)}</div>
              <ul>${a.causes.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></div></div>`).join("") :
            `<div class="empty">No counter is expected to go over its wait target.</div>`}</div></div>
      </div>
      <div class="card" style="margin-top:14px"><h3>Predicted wait at each counter, every 15 minutes</h3>
        <p class="sub">Recomputes as you approve actions below</p><div id="c-mult"></div></div>
    </section>

    <section class="section">
      <div class="sechead"><span class="layer">2 · Decision support</span><h2>Recommended plan</h2>
        <p>Each step's effect is measured on top of the steps above it. Approve what you agree with; the numbers above update immediately.</p></div>
      <div class="grid g-8-4">
        <div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;align-items:center">
            <button class="btn primary" type="button" id="ap-all" ${S.readOnly ? "hidden" : ""}>Approve all</button>
            <button class="btn" type="button" id="ap-low" ${S.readOnly ? "hidden" : ""}>Approve low-risk only</button>
            <span class="muted" style="font-size:12.5px" id="ap-count"></span>
          </div>
          <div class="actions" id="acts"></div>
        </div>
        <div style="display:grid;gap:14px;align-content:start">
          <div class="card"><h3>Counter plan</h3><p class="sub">Highlighted cells differ from each person's usual counter</p>
            ${planTable(day, b, st)}
            <div style="margin-top:10px"><button class="btn small" type="button" id="copy-plan">Copy plan for the morning huddle</button></div></div>
          <div class="card"><h3>Customer experience</h3><p class="sub">No effect on the queue numbers, but they address what customers complain about</p>
            <div class="actions" id="exps"></div></div>
        </div>
      </div>
    </section>

    <section class="section">
      <div class="sechead"><span class="layer">3 · Workflow</span><h2>Send it out</h2>
        <p>Approved actions become messages to staff, the token machine and customers. Autopilot applies low-risk actions if nobody responds.</p></div>
      <div class="grid g-2">
        <div class="card"><div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline">
            <div><h3>Outbox</h3><p class="sub">Staff app, token machine, SMS / WhatsApp (English + ಕನ್ನಡ)</p></div>
            <button class="btn small" type="button" id="send-all">Send all</button></div>
          <div id="outbox" style="display:grid;gap:8px"></div></div>
        <div class="card"><h3>Autopilot and escalation</h3>
          <p class="sub">If the branch manager has not acted by 18:00, low-risk actions (token-machine prompts, appointment offers, checklists) go out automatically; staff moves are escalated to the regional office.</p>
          <label class="switch"><input type="checkbox" id="auto" ${S.autopilot ? "checked" : ""} ${S.readOnly ? "disabled" : ""}> Autopilot for low-risk actions</label>
          <div style="margin:10px 0 12px"><button class="btn small" type="button" id="sim18" ${S.autopilot ? "" : "disabled"}>Simulate: no response by 18:00</button></div>
          <div class="eyebrow" style="margin-bottom:4px">Activity</div>
          <div class="log" id="log"></div></div>
      </div>
    </section>`;

    // charts
    requestAnimationFrame(() => {
      Charts.columns(document.getElementById("c-cols"), {
        cats: HOURS.map((h) => h.slice(0, 2)), height: 210, label: "Customers per hour by counter",
        tipTitle: (i) => `${HOURS[i]}–${HOURS[i + 1] || "16:00"}`,
        series: POOLS.map((p) => ({ name: PL[p], color: COLOR[p], values: [0, 1, 2, 3, 4, 5].map((h) => D.meta.services && Object.keys(X.lam).filter((s) => D.meta.services[s].pool === p).reduce((a, s) => a + X.lam[s][h], 0)) })),
      });
    });
    waitMultiples(document.getElementById("c-mult"), st.ev, bef, ["If nothing changes", "With approved actions"]);

    // action cards
    const acts = document.getElementById("acts");
    const ap = setOf(S.approved, day, b), dis = setOf(S.dismissed, day, b);
    const KIND = { redirect: "Self-service", reschedule: "Appointments", staff: "Staff re-deployment", lunch: "Lunch timing", float: "Borrow staff" };
    acts.innerHTML = X.steps.length ? X.steps.map((s, i) => {
      const im = s.impact, on = ap.has(i), off = dis.has(i);
      const moves = s.kind === "staff" ? `<div style="display:grid;gap:4px">${s.moves.map((m) => `<div style="font-size:13px"><b>${esc(m.name)}</b> · ${esc(PL[m.frm])} → <b>${esc(PL[m.to])}</b> · ${esc(m.when)}</div>`).join("")}</div>` : "";
      const donor = s.kind === "float" && s.donor_impact ? `<div class="muted" style="font-size:12.5px">${esc(BR[s.effect.from_branch].name)} after lending: average wait ${fmt(s.donor_impact.avg_wait_before, 1)} → ${fmt(s.donor_impact.avg_wait_after, 1)} min, worst hour ${fmt(s.donor_impact.peak_wait_after, 0)} min</div>` : "";
      const msgs = (s.notify || []).map((m) => `<div class="msg"><div class="to">${esc(m.to)} · ${esc(m.channel)}</div>${esc(m.text)}${m.text_local ? `<span class="kn">${esc(m.text_local)}</span>` : ""}</div>`).join("");
      return `<article class="act ${on ? "approved" : ""} ${off ? "dismissed" : ""}">
        <div class="row1"><div style="min-width:0;flex:1 1 260px"><div class="kind">${i + 1} · ${KIND[s.kind] || s.kind}</div><div class="ttl">${esc(s.title)}</div></div>
          <div class="btns">${S.readOnly ? (on ? `<span class="chip good">Approved</span>` : `<span class="chip">Awaiting manager</span>`) : on ? `<span class="chip good">Approved</span><button class="btn small" data-undo="${i}" type="button">Undo</button>` :
            `<button class="btn primary small" data-approve="${i}" type="button">Approve</button><button class="btn small" data-dismiss="${i}" type="button">${off ? "Dismissed" : "Dismiss"}</button>`}</div></div>
        <div class="imp"><span class="chip good">Avg wait ${fmt(im.avg_wait_before, 1)} → ${fmt(im.avg_wait_after, 1)} min</span>
          ${im.walkouts_avoided >= 0.5 ? `<span class="chip">${fmt(im.walkouts_avoided, 0)} fewer walkouts</span>` : ""}
          ${s.customers_moved ? `<span class="chip">${fmt(s.customers_moved, 0)} customers moved</span>` : ""}
          ${im.rupees > 0 ? `<span class="chip acc">${rs(im.rupees)} a day</span>` : ""}
          ${s.autopilot ? `<span class="chip">Low-risk · autopilot</span>` : `<span class="chip">Needs manager approval</span>`}</div>
        ${moves}<p class="why">${esc(s.why)}</p>${donor}
        <div class="meta"><span>Owner: ${esc(s.owner)}</span>${msgs ? `<details class="more"><summary>Messages it sends (${s.notify.length})</summary><div style="display:grid;gap:6px;margin-top:6px">${msgs}</div></details>` : ""}</div>
      </article>`;
    }).join("") : `<div class="empty">No queue actions needed for this day. The branch stays within its targets.</div>`;
    const nOn = [...ap].length;
    document.getElementById("ap-count").textContent = `${nOn} of ${X.steps.length} approved · full plan: average wait ${fmt(X.kpi_after.avg_wait, 1)} min, ${fmt(X.kpi_after.walkouts, 0)} walkouts`;
    acts.addEventListener("click", (e) => {
      const t = e.target.closest("button"); if (!t) return;
      if (t.dataset.approve) approve(day, b, +t.dataset.approve);
      else if (t.dataset.undo) unapprove(day, b, +t.dataset.undo);
      else if (t.dataset.dismiss) dismiss(day, b, +t.dataset.dismiss);
      else return;
      render();
    });
    document.getElementById("ap-all").onclick = () => { X.steps.forEach((_, i) => { if (!ap.has(i)) approve(day, b, i); }); X.experience.forEach((_, i) => { if (!setOf(S.done, day, b).has(i)) markDone(day, b, i); }); render(); toast("All actions approved"); };
    document.getElementById("ap-low").onclick = () => { X.steps.forEach((s, i) => { if (s.autopilot && !ap.has(i)) approve(day, b, i); }); X.experience.forEach((ex, i) => { if (ex.autopilot && !setOf(S.done, day, b).has(i)) markDone(day, b, i); }); render(); toast("Low-risk actions approved"); };
    document.getElementById("copy-plan").onclick = () => copyText(planText(day, b), "Plan copied");

    // experience
    const exps = document.getElementById("exps"), done = setOf(S.done, day, b);
    exps.innerHTML = X.experience.length ? X.experience.map((x, i) => `<article class="act ${done.has(i) ? "approved" : ""}">
      <div class="ttl" style="font-size:13.5px">${esc(x.title)}</div><p class="why">${esc(x.why)}</p>${x.detail ? `<p class="why">${esc(x.detail)}</p>` : ""}
      <div class="meta"><span>${esc(x.owner)}</span>${done.has(i) ? `<span class="chip good">Scheduled</span>` : S.readOnly ? "" : `<button class="btn small" data-exp="${i}" type="button">Schedule</button>`}</div></article>`).join("") :
      `<div class="empty">Nothing extra needed.</div>`;
    exps.addEventListener("click", (e) => { const t = e.target.closest("[data-exp]"); if (t) { markDone(day, b, +t.dataset.exp); render(); } });

    // outbox + autopilot + log
    const ob = outbox(day, b), sent = setOf(S.sent, day, b);
    document.getElementById("outbox").innerHTML = ob.length ? ob.map((m) => `<div class="msg"><div class="to">${esc(m.to)} · ${esc(m.channel)} ${sent.has(m.key) ? '<span class="chip good">Sent (demo)</span>' : '<span class="chip">Ready</span>'}</div>${esc(m.text)}${m.text_local ? `<span class="kn">${esc(m.text_local)}</span>` : ""}</div>`).join("") :
      `<div class="empty">Approve an action to see the messages it sends.</div>`;
    document.getElementById("send-all").onclick = () => { if (!ob.length) { toast("Nothing to send yet"); return; } ob.forEach((m) => sent.add(m.key)); addLog(`Sent ${ob.length} messages (staff app, token machine, customers)`, "You"); render(); toast(`${ob.length} messages marked as sent (demo, nothing leaves this page)`); };
    document.getElementById("auto").onchange = (e) => { S.autopilot = e.target.checked; addLog(`Autopilot ${S.autopilot ? "on" : "off"}`, "You"); render(); };
    document.getElementById("sim18").onclick = () => { S.clock = Math.max(S.clock, 18 * 60); const [n, e2] = runAutopilot(day); render(); toast(`Autopilot applied ${n} low-risk actions, escalated ${e2}`); };
    const lg = S.log.filter((l) => l.day === day && l.branch === b);
    document.getElementById("log").innerHTML = lg.length ? lg.map((l) => `<div class="e"><div class="t">${l.t}</div><div>${esc(l.text)} <span class="muted">· ${esc(l.who)}</span></div></div>`).join("") : `<div class="empty">No activity yet.</div>`;
  }

  // ---------------------------------------------------------------- WHAT-IF
  function renderWhatIf(v) {
    const day = S.day, b = S.branch, X = D.days[day][b], E = X.explain;
    if (!S.wi) {
      const on = {};
      Object.keys(X.home_plan).forEach((s) => { on[s] = true; });
      X.absent.forEach((a) => { on[a.id] = false; });
      S.wi = { demand: 0, adopt: 100, lunch: "standard", optimise: true, on };
    }
    const W = S.wi;
    const recRedirect = {};
    X.steps.forEach((s) => { if (s.effect.type === "redirect") recRedirect[s.effect.service] = s.effect.fraction; });
    const p90 = Math.round((E.high / E.total - 1) * 100);
    const staffAll = [...Object.keys(X.home_plan).filter((s) => !s.startsWith("MGR")), ...X.absent.map((a) => a.id)];
    const nameOf = (sid) => (X.staff[sid] || D.staff_dir[sid] || {}).name || sid;
    v.innerHTML = `
    <section class="section">
      <div class="sechead"><span class="layer">Digital twin</span><h2>What if ${esc(D.meta.day_labels[day])} goes differently at ${esc(BR[b].name)}?</h2>
        <p>Change demand, who turns up and how many customers use self-service. The engine re-plans counters in the browser in a fraction of a second.</p></div>
      <div class="grid g-4-8">
        <div class="card ctrl">
          <label class="f"><span class="top2"><span>Demand vs forecast</span><b class="num" id="wi-dv"></b></span>
            <input type="range" id="wi-d" min="-30" max="60" step="5" value="${W.demand}"></label>
          <div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn small" type="button" data-dem="0">As forecast</button><button class="btn small" type="button" data-dem="${p90}">Busy day (+${p90}%, 1 in 10)</button><button class="btn small" type="button" data-dem="-15">Quiet (−15%)</button></div>
          <label class="f"><span class="top2"><span>Self-service take-up (vs recommended)</span><b class="num" id="wi-av"></b></span>
            <input type="range" id="wi-a" min="0" max="150" step="10" value="${W.adopt}"></label>
          <div><div class="eyebrow" style="margin-bottom:6px">Who turns up</div><div class="staffpick">
            ${staffAll.map((sid) => `<label><input type="checkbox" data-st="${sid}" ${W.on[sid] ? "checked" : ""}> ${esc(nameOf(sid))} <span class="muted" style="font-size:12px">${esc(PL[(X.staff[sid] || D.staff_dir[sid]).home])}</span></label>`).join("")}
          </div></div>
          <div><div class="eyebrow" style="margin-bottom:6px">Lunch</div>
            <label class="radio"><input type="radio" name="wi-l" value="standard" ${W.lunch === "standard" ? "checked" : ""}> Usual two waves</label>
            <label class="radio"><input type="radio" name="wi-l" value="one_at_a_time" ${W.lunch !== "standard" ? "checked" : ""}> One at a time</label></div>
          <label class="switch"><input type="checkbox" id="wi-o" ${W.optimise ? "checked" : ""}> Let the engine re-plan counters</label>
        </div>
        <div style="display:grid;gap:14px;min-width:0">
          <div id="wi-tiles"></div>
          <div class="card"><h3>Predicted wait in this scenario</h3><p class="sub">Grey: forecast day with nothing changed</p><div id="wi-mult"></div></div>
          <div class="card"><h3>Counter plan in this scenario</h3><div id="wi-plan"></div></div>
        </div>
      </div>
    </section>`;
    const recompute = () => {
      const staff = {}, plan0 = {};
      Object.keys(W.on).forEach((sid) => {
        if (!W.on[sid]) return;
        const s = X.staff[sid] || D.staff_dir[sid];
        staff[sid] = s; plan0[sid] = { AM: s.home, PM: s.home };
      });
      Object.keys(X.home_plan).filter((s) => s.startsWith("MGR")).forEach((sid) => { staff[sid] = X.staff[sid]; plan0[sid] = X.home_plan[sid]; });
      for (const p of POOLS) {
        if (!Object.values(staff).some((s) => s.home === p)) {
          const mid = "MGR-" + b; staff[mid] = { name: BR[b].manager + " (manager)", role: "Branch manager", home: p, factor: { [p]: 1.15 } }; plan0[mid] = { AM: p, PM: p };
        }
      }
      const m = 1 + W.demand / 100;
      const lam = {}; Object.keys(X.lam).forEach((s) => { lam[s] = X.lam[s].map((x) => x * m); });
      const dayIn = { lam, within: D.meta.within, svc_mean: D.meta.svc_mean, staff };
      const red = {}; Object.keys(recRedirect).forEach((s) => { red[s] = Math.min(0.95, recRedirect[s] * W.adopt / 100); });
      const levers = { redirect: red, reschedule: [], lunch: W.lunch };
      const plan = W.optimise ? Engine.optimize(dayIn, levers, plan0) : plan0;
      const ev = Engine.evaluate(dayIn, plan, levers);
      const bef = before(day, b);
      document.getElementById("wi-dv").textContent = `${W.demand > 0 ? "+" : ""}${W.demand}% · ${fmt(E.total * m)} customers`;
      document.getElementById("wi-av").textContent = `${W.adopt}%`;
      document.getElementById("wi-tiles").innerHTML = tilesHTML(ev, bef, X, { plan, dayIn, borrowed: [], lent: [] }).replace(/vs doing nothing/g, "vs forecast day, no changes");
      waitMultiples(document.getElementById("wi-mult"), ev, bef, ["Forecast day, nothing changed", "This scenario"]);
      const st = { plan, dayIn, borrowed: [], lent: [] };
      document.getElementById("wi-plan").innerHTML = planTable(day, b, st, false);
    };
    let tmr;
    const later = () => { clearTimeout(tmr); tmr = setTimeout(recompute, 60); };
    v.querySelector("#wi-d").oninput = (e) => { W.demand = +e.target.value; later(); };
    v.querySelector("#wi-a").oninput = (e) => { W.adopt = +e.target.value; later(); };
    v.querySelector("#wi-o").onchange = (e) => { W.optimise = e.target.checked; recompute(); };
    v.querySelectorAll('input[name="wi-l"]').forEach((r) => { r.onchange = (e) => { W.lunch = e.target.value; recompute(); }; });
    v.querySelectorAll("[data-st]").forEach((c) => { c.onchange = (e) => { W.on[e.target.dataset.st] = e.target.checked; recompute(); }; });
    v.querySelectorAll("[data-dem]").forEach((btn) => { btn.onclick = () => { W.demand = +btn.dataset.dem; v.querySelector("#wi-d").value = W.demand; recompute(); }; });
    requestAnimationFrame(recompute);
  }

  // ---------------------------------------------------------------- NETWORK
  function renderNetwork(v) {
    const day = S.day;
    const rows = D.branches.map((br) => {
      const X = D.days[day][br.id], st = stateFor(day, br.id), bef = before(day, br.id);
      return { br, X, st, bef, now: kpiOf(st.ev), was: kpiOf(bef) };
    });
    const tot = (f) => rows.reduce((a, r) => a + f(r), 0);
    const moves = D.network[day] || [];
    const crit = rows.filter((r) => r.X.alerts.some((a) => a.severity === "critical")).length;
    v.innerHTML = `
    <section class="section">
      <div class="sechead"><span class="layer">Network view</span><h2>All five branches on ${esc(D.meta.day_labels[day])}</h2>
        <p>Regional office view: where pressure is, what each branch's approved plan achieves, and where staff can be lent.</p></div>
      <div class="tiles" style="grid-template-columns:repeat(4,minmax(0,1fr))">
        <div class="tile"><div class="k">Customers expected</div><div class="v num">${fmt(tot((r) => r.X.explain.total))}</div><div class="was">normal day ${fmt(tot((r) => r.X.explain.normal))}</div></div>
        <div class="tile"><div class="k">Branches with a critical alert</div><div class="v num">${crit}<small>of 5</small></div><div class="was">${rows.reduce((a, r) => a + r.X.alerts.length, 0)} alerts in total</div></div>
        <div class="tile"><div class="k">Walkouts, approved plans</div><div class="v num">${fmt(tot((r) => r.now.walkouts))}</div><div class="was">${fmt(tot((r) => r.was.walkouts))} if nothing changes</div></div>
        <div class="tile"><div class="k">Staff lent between branches</div><div class="v num">${moves.length}</div><div class="was">${moves.length ? moves.map((m) => esc(m.name)).join(", ") : "none needed"}</div></div>
      </div>
      <div class="card" style="margin-top:14px"><h3>Branches</h3><p class="sub">Live: reflects actions approved on the branch plans</p>
        <div class="tbl-wrap"><table><thead><tr><th>Branch</th><th class="r">Customers</th><th class="r">vs normal</th><th>Alerts</th><th class="r">Avg wait</th><th class="r">Worst hour</th><th class="r">Walkouts</th><th>Rating (Sep)</th><th></th></tr></thead><tbody>
        ${rows.map((r) => {
          const pct = Math.round((r.X.explain.total / r.X.explain.normal - 1) * 100);
          const al = r.X.alerts, c = al.filter((a) => a.severity === "critical").length;
          const fbk = D.feedback.branches[r.br.id];
          return `<tr><td><b>${esc(r.br.name)}</b><div class="muted" style="font-size:12px">${esc(r.br.kind)}</div></td>
          <td class="r num">${fmt(r.X.explain.total)}</td><td class="r num">${pct >= 0 ? "+" : "−"}${Math.abs(pct)}%</td>
          <td>${c ? `<span class="chip crit">${c} critical</span> ` : ""}${al.length - c ? `<span class="chip warn">${al.length - c} warning</span>` : ""}${!al.length ? `<span class="chip good">None</span>` : ""}</td>
          <td class="r num">${fmt(r.was.avg_wait, 1)} → <b>${fmt(r.now.avg_wait, 1)}</b></td><td class="r num">${fmt(r.was.peak_wait, 0)} → <b>${fmt(r.now.peak_wait, 0)}</b></td>
          <td class="r num">${fmt(r.was.walkouts, 0)} → <b>${fmt(r.now.walkouts, 0)}</b></td>
          <td class="num">${fmt(fbk.avg_rating, 2)} <span class="stars">★</span></td>
          <td><button class="btn small" type="button" data-open="${r.br.id}">Open plan</button></td></tr>`;
        }).join("")}</tbody></table></div></div>
      <div class="grid g-2" style="margin-top:14px">
        <div class="card"><h3>Worst counter wait by hour</h3><p class="sub">Minutes at the counter furthest over its target, with approved actions. Darker means further over target.</p>
          <div class="tbl-wrap"><table class="heat"><thead><tr><th>Branch</th>${HOURS.map((h) => `<th style="text-align:center">${h.slice(0, 2)}</th>`).join("")}</tr></thead><tbody>
          ${rows.map((r) => `<tr><td class="name">${esc(r.br.name)}</td>${[0, 1, 2, 3, 4, 5].map((h) => {
            let worst = 0, ratio = 0, wp = "CASH";
            POOLS.forEach((p) => { const e = r.st.ev[p]; let a = 0, w = 0; for (let x = h * 4; x < h * 4 + 4; x++) { a += e.arr_bins[x]; w += e.arr_bins[x] * e.wait_bins[x]; } if (a > 0.5 && w / a / SLA[p] > ratio) { ratio = w / a / SLA[p]; worst = w / a; wp = p; } });
            const lvl = ratio < 0.25 ? 0 : ratio < 0.5 ? 1 : ratio < 0.75 ? 2 : ratio < 1 ? 3 : ratio < 1.5 ? 4 : 5;
            return `<td style="background:var(--heat-${lvl});color:var(--heat-t-${lvl})" title="${esc(r.br.name)} ${HOURS[h]}: ${PL[wp]} ${worst.toFixed(0)} min (target ${SLA[wp]})">${worst.toFixed(0)}</td>`;
          }).join("")}</tr>`).join("")}</tbody></table></div>
          <div class="muted" style="font-size:12px;margin-top:6px">The same numbers power the customer app's branch crowd meter ("Jayanagar: about 20 min now, quieter after 14:00").</div></div>
        <div class="card"><h3>Staff lending</h3><p class="sub">Cross-trained colleagues from branches with spare capacity (up to 25 km)</p>
          <div style="display:grid;gap:8px">${moves.length ? moves.map((m) => {
            const R = D.days[day][m.to_branch], i = R.steps.findIndex((s) => s.effect.type === "float" && s.effect.staff === m.staff);
            const on = setOf(S.approved, day, m.to_branch).has(i), s = R.steps[i];
            return `<div class="msg" style="display:grid;gap:6px"><div><b>${esc(m.name)}</b> · ${esc(BR[m.from_branch].name)} → <b>${esc(BR[m.to_branch].name)}</b> · ${esc(PL[m.pool])} · ${m.blocks.length === 2 ? "all day" : "10:00–13:00"} · ${fmt(m.km, 0)} km</div>
              <div class="muted">${esc(s.why)}</div><div>${on ? `<span class="chip good">Approved</span>` : `<button class="btn small primary" type="button" data-lend="${m.to_branch}|${i}">Approve lending</button>`}</div></div>`;
          }).join("") : `<div class="empty">No lending needed on this day.</div>`}</div></div>
      </div>
      <div class="card" style="margin-top:14px"><h3>Demand is shifting between branches</h3><p class="sub">Daily customers, last 16 weeks</p>
        <div class="grid g-3" id="spark"></div></div>
    </section>`;
    v.querySelectorAll("[data-open]").forEach((btn) => { btn.onclick = () => { S.branch = btn.dataset.open; S.tab = "plan"; persist(); render(); window.scrollTo({ top: 0 }); }; });
    v.querySelectorAll("[data-lend]").forEach((btn) => { btn.onclick = () => { const [rb, i] = btn.dataset.lend.split("|"); approve(day, rb, +i); render(); toast("Lending approved: both branch plans updated"); }; });
    const sp = document.getElementById("spark");
    D.branches.forEach((br) => {
      const h = D.history[br.id];
      const box = document.createElement("div");
      box.innerHTML = `<div style="font-weight:600;font-size:13px">${esc(br.name)}</div><div class="muted" style="font-size:12px;min-height:34px">${br.shifts.length ? esc(br.shifts.join("; ")) : "Stable demand"}</div><div class="chart"></div>`;
      sp.appendChild(box);
      requestAnimationFrame(() => Charts.lines(box.querySelector(".chart"), { x: h.dates.map((d) => d.slice(5)), height: 110, dec: 0, xEvery: 30, label: br.name + " daily customers",
        series: [{ name: "Customers", color: "var(--s-cash)", values: h.customers, width: 1.5, area: true }] }));
    });
  }

  // ---------------------------------------------------------------- CUSTOMER VOICE
  function renderVoice(v) {
    const b = S.branch, F = D.feedback, B = F.branches[b];
    const themes = Object.entries(B.themes);
    const mx = Math.max(1, ...themes.map((t) => t[1]));
    const cbs = F.callbacks.filter((c) => c.branch === b);
    const appFb = (window.Store ? Store.data.feedback : []).filter((f) => f.rating <= 2).map((f) => ({ branch: f.branch, time: f.time, token: f.token || "app", counter: "–", service: f.service || "Customer app", rating: f.rating, wait: null, senior: f.senior, hni: false, comment: f.comment, fromApp: true }));
    const live = appFb.concat(F.live_today).sort((x, y) => (y.branch === b) - (x.branch === b));
    v.innerHTML = `
    <section class="section">
      <div class="sechead"><span class="layer">Feedback AI</span><h2>What customers at ${esc(BR[b].name)} are saying</h2>
        <p>Smiley buttons, WhatsApp and voice callbacks, in English, Kannada and Hindi. Themes are linked to the visit (service, counter, wait), so complaints point to causes.</p></div>
      <div class="tiles" style="grid-template-columns:repeat(4,minmax(0,1fr))">
        <div class="tile"><div class="k">Average rating, September</div><div class="v num">${fmt(B.avg_rating, 2)}<small>of 5</small></div><div class="was">${fmt(B.n)} ratings</div></div>
        <div class="tile"><div class="k">Negative (1–2 stars)</div><div class="v num">${fmt(B.negative_share * 100, 1)}<small>%</small></div><div class="was">${fmt(B.comments)} written or spoken comments</div></div>
        <div class="tile"><div class="k">In-branch alerts today</div><div class="v num">${live.length}</div><div class="was">network-wide: low ratings while the customer was still there</div></div>
        <div class="tile"><div class="k">Callbacks to make</div><div class="v num">${cbs.length}</div><div class="was">last 3 days, highest priority first</div></div>
      </div>
      <div class="grid g-2" style="margin-top:14px">
        <div class="card"><h3>Complaint themes, last 30 days</h3><p class="sub">Tap a theme to read what customers wrote</p>
          ${themes.map(([k, n]) => `<details class="more" style="border-bottom:1px solid var(--grid);padding:4px 0"><summary><div class="themebar"><span style="color:var(--ink)">${esc(F.theme_labels[k] || k)}</span><span class="bar"><i style="width:${(n / mx) * 100}%"></i></span><span class="num" style="text-align:right;color:var(--ink)">${n}</span></div></summary>
            ${(B.examples[k] || []).map((e) => `<div class="quote">"${esc(e.text)}" <span class="stars">${"★".repeat(e.rating)}</span> <span class="muted" style="font-size:12px">${esc(e.date)} · ${esc(e.service)}</span></div>`).join("")}</details>`).join("")}
          <div class="muted" style="font-size:12px;margin-top:8px">Also ${fmt(B.praise)} comments of praise. Multilingual keyword model (${fmt(F.lexicon_accuracy * 100, 0)}% agreement on the synthetic comments; real comments would add an LLM-assisted labelling pass).</div></div>
        <div class="card"><h3>Every extra wait costs stars</h3><p class="sub">Average rating by how long the customer waited (all branches)</p><div class="chart" id="c-rw"></div></div>
      </div>
      <div class="grid g-2" style="margin-top:14px">
        <div class="card"><h3>Slow-process detector</h3><p class="sub">Services much slower than the rest of their category (last 3 months)</p>
          ${F.slow_processes.map((s) => `<div class="msg" style="margin-bottom:8px"><b>${esc(s.subtype)}</b> takes ${fmt(s.median_min, 1)} min vs ${fmt(s.category_median, 1)} min typical for ${esc(s.service)} (${fmt(s.ratio, 1)}×). About ${fmt(s.volume_per_day, 0)} a day across branches, ${fmt(s.counter_hours_per_month, 0)} extra counter-hours a month.
            ${s.subtype === "Demand Draft" ? `<div class="ink2" style="margin-top:4px">Suggestion: accept DD requests on the app or WhatsApp and print them in a batch at 15:00; customers collect without queuing. This is a process fix, not a staffing one.</div>` : ""}
            ${s.subtype === "Account Opening" ? `<div class="ink2" style="margin-top:4px">Suggestion: pre-fill the form through video KYC or a tablet at the entrance before the customer reaches the counter.</div>` : ""}</div>`).join("")}</div>
        <div class="card"><h3>Repeat visits for missing documents</h3><p class="sub">Share of visits that end with "come back with the document"</p>
          <div class="tbl-wrap"><table><thead><tr><th>Service</th><th class="r">Fail rate</th><th class="r">Wasted visits / month</th></tr></thead><tbody>
          ${F.repeat_visits.map((r) => `<tr><td>${esc(r.subtype)}</td><td class="r num">${fmt(r.fail_rate * 100, 1)}%</td><td class="r num">${fmt(r.failed_visits_per_month, 0)}</td></tr>`).join("")}</tbody></table></div>
          <div class="ink2" style="font-size:13px;margin-top:8px">The branch plan sends a document checklist on WhatsApp / SMS to every appointment the evening before, and the token kiosk shows it to walk-ins.</div></div>
      </div>
      <div class="grid g-2" style="margin-top:14px">
        <div class="card"><h3>Recover the customer before they leave</h3><p class="sub">Today, low ratings given at the counter alert the floor manager at once</p>
          <div style="display:grid;gap:8px">${live.length ? live.map((c, i) => {
            const k = b + i, ack = S.liveAck[k];
            return `<div class="msg"><div class="to">${esc(BR[c.branch].name)} · ${esc(c.time)} · token ${esc(c.token)} · counter ${esc(c.counter)}</div><b>${"★".repeat(c.rating)}</b> after ${c.wait != null ? fmt(c.wait, 0) + " min wait" : "their visit"} · ${esc(c.service)}${c.senior ? " · senior citizen" : ""}${c.hni ? " · high-value customer" : ""}${c.fromApp ? ' <span class="chip acc">from the customer app</span>' : ""}${c.comment ? `<div class="quote">"${esc(c.comment)}"</div>` : ""}
              <div style="margin-top:6px">${ack ? `<span class="chip good">${esc(ack)}</span>` : `<button class="btn small" type="button" data-live="${k}">Send floor officer</button>`}</div></div>`;
          }).join("") : `<div class="empty">No low ratings at the counter today.</div>`}</div></div>
        <div class="card"><h3>Callback queue</h3><p class="sub">High-value customers, walkouts and seniors first</p>
          <div style="display:grid;gap:8px;max-height:420px;overflow-y:auto">${cbs.length ? cbs.map((c, i) => {
            const k = b + "cb" + i, st = S.callbacks[k];
            return `<div class="msg"><div class="to">${esc(c.date)} · ${esc(c.token || "")} · ${esc(c.channel)} ${c.hni ? '<span class="chip acc">High value</span>' : ""} ${c.walkout ? '<span class="chip crit">Walked out</span>' : ""} ${c.senior ? '<span class="chip">Senior</span>' : ""}</div>
              <b>${"★".repeat(c.rating)}</b> ${esc(c.service)}${c.wait != null ? ` · waited ${fmt(c.wait, 0)} min` : ""}${c.comment ? `<div class="quote">"${esc(c.comment)}"</div>` : ""}
              <div style="margin-top:4px">${st ? `<span class="chip good">${esc(st)}</span>` : `<button class="btn small" type="button" data-cb="${k}">Assign callback</button>`}</div></div>`;
          }).join("") : `<div class="empty">No negative feedback in the last three days.</div>`}</div></div>
      </div>
    </section>`;
    requestAnimationFrame(() => Charts.bars(document.getElementById("c-rw"), {
      cats: F.rating_by_wait.map((r) => r.bucket + " min"), values: F.rating_by_wait.map((r) => r.rating), height: 200, ymax: 5, tickDec: 0,
      color: "var(--s-cash)", fmt: (x) => x.toFixed(1), label: "Rating by wait",
    }));
    v.querySelectorAll("[data-live]").forEach((btn) => { btn.onclick = () => { S.liveAck[btn.dataset.live] = "Floor officer on the way"; addLog("Floor officer sent to a customer who rated 1–2 stars at the counter", "You", S.day, b); render(); }; });
    v.querySelectorAll("[data-cb]").forEach((btn) => { btn.onclick = () => { S.callbacks[btn.dataset.cb] = `Assigned to ${BR[b].manager}, call by 11:00`; addLog("Callback assigned for a dissatisfied customer", "You", S.day, b); render(); }; });
  }

  // ---------------------------------------------------------------- KIOSK
  const KSVC = [
    { id: "CASH", en: "Cash", kn: "ನಗದು", hi: "नकद", icon: '<rect x="3" y="7" width="18" height="11" rx="2"/><circle cx="12" cy="12.5" r="2.5"/>' },
    { id: "PASSBOOK", en: "Passbook", kn: "ಪಾಸ್‌ಬುಕ್", hi: "पासबुक", icon: '<path d="M6 3h11a1 1 0 0 1 1 1v16H7a2 2 0 0 1-2-2V4a1 1 0 0 1 1-1Z"/><path d="M9 7h6M9 11h6"/>' },
    { id: "ACCOUNT", en: "Account / KYC", kn: "ಖಾತೆ / ಕೆವೈಸಿ", hi: "खाता / केवाईसी", icon: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1-4 4-6 7-6s6 2 7 6"/>' },
    { id: "REMIT", en: "DD / transfer", kn: "ಡಿಡಿ / ವರ್ಗಾವಣೆ", hi: "डीडी / ट्रांसफर", icon: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>' },
    { id: "PENSION", en: "Pension", kn: "ಪಿಂಚಣಿ", hi: "पेंशन", icon: '<path d="M12 21s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.5-7 10-7 10Z"/>' },
    { id: "LOAN", en: "Loan / FD", kn: "ಸಾಲ / ಎಫ್‌ಡಿ", hi: "ऋण / एफडी", icon: '<path d="M3 10 12 4l9 6"/><path d="M5 10v9h14v-9"/><path d="M10 19v-5h4v5"/>' },
  ];
  const CNT = { CASH: { en: "cash counter", kn: "ನಗದು ಕೌಂಟರ್", hi: "नकद काउंटर" }, GENERAL: { en: "general counter", kn: "ಸಾಮಾನ್ಯ ಕೌಂಟರ್", hi: "सामान्य काउंटर" }, EXPERT: { en: "loans & advisory desk", kn: "ಸಾಲ ವಿಭಾಗ", hi: "ऋण डेस्क" } };
  function renderKiosk(v) {
    const day = S.day, b = S.branch, Q = S.kiosk, st = stateFor(day, b);
    const L = Q.lang;
    const pick = (o) => o[L] || o.en;
    let out = `<div class="empty">Choose a service to see what the kiosk says.</div>`;
    if (Q.svc) {
      const pool = D.meta.services[Q.svc].pool, red = D.meta.redirect[Q.svc];
      const w = st.ev[pool].wait_bins[Q.bin];
      const canSelf = red.share > 0 && (!red.needs_digital || Q.digital);
      const prio = Q.senior || Q.help;
      const tok = `${"CGL"[POOLS.indexOf(pool)]}-${String(20 + Q.bin * 3 + (Q.svc.length % 5)).padStart(3, "0")}`;
      const wait = Math.max(1, Math.round(prio ? w * 0.35 : w));
      const say = { en: `Please go to the ${CNT[pool].en}. Your token is ${tok}. Expected wait about ${wait} minutes.`,
        kn: `ದಯವಿಟ್ಟು ${CNT[pool].kn}ಗೆ ಹೋಗಿ. ನಿಮ್ಮ ಟೋಕನ್ ${tok}. ಸುಮಾರು ${wait} ನಿಮಿಷ ಕಾಯಬೇಕಾಗಬಹುದು.`,
        hi: `कृपया ${CNT[pool].hi} पर जाएँ। आपका टोकन ${tok} है। लगभग ${wait} मिनट प्रतीक्षा।` };
      const docs = { ACCOUNT: "Aadhaar, PAN card and one photo", LOAN: "Aadhaar, PAN, income proof or land records, 6 months' statement", PENSION: "PPO number, Aadhaar and passbook" }[Q.svc];
      out = `<div class="tokenout">
        ${canSelf && w > 5 ? `<div class="msg" style="background:var(--accent-soft);border-color:var(--accent-line)"><b>Skip the queue:</b> ${esc(red.channel)}. ${Q.digital ? "It takes about 2 minutes." : "A colleague or the voice kiosk will help you."}</div>` : ""}
        <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><div class="tokenno" style="color:${COLOR[pool]}">${tok}</div>
          <div><div><span class="cell-pool"><i style="background:${COLOR[pool]}"></i>${PL[pool]}</span> ${prio ? '<span class="chip acc">Priority lane</span>' : ""}</div>
          <div class="muted" style="margin-top:4px">Predicted wait at ${binLab(Q.bin)}: <b style="color:var(--ink)">${wait} min</b>${prio ? " (priority)" : ""}</div></div></div>
        <div class="msg"><div class="to">Kiosk speaks (${L === "kn" ? "ಕನ್ನಡ" : L === "hi" ? "हिंदी" : "English"})</div><span class="${L === "kn" ? "kn" : ""}" style="font-size:14px">${esc(say[L])}</span></div>
        ${docs ? `<div class="msg"><div class="to">Document check before you queue</div>Please have: ${esc(docs)}. Missing something? The kiosk books a slot instead of a wasted wait.</div>` : ""}
        ${!Q.digital ? `<div class="muted" style="font-size:12.5px">No smartphone? The kiosk calls the customer's basic phone when their turn is 10 minutes away, so they can sit or step out.</div>` : ""}
        ${Q.help ? `<div class="muted" style="font-size:12.5px">The kiosk has alerted the nearest free staff member to assist.</div>` : ""}
      </div>`;
    }
    v.innerHTML = `
    <section class="section">
      <div class="sechead"><span class="layer">Customer redirection</span><h2>Token kiosk at ${esc(BR[b].name)}</h2>
        <p>Pictures and voice instead of reading. The kiosk uses the same forecast and plan: it offers self-service only to customers who can use it, sends priority customers to a faster lane and quotes a realistic wait.</p></div>
      <div class="grid g-2">
        <div class="card" style="display:grid;gap:14px">
          <div class="seg" role="group" aria-label="Language">${[["en", "English"], ["kn", "ಕನ್ನಡ"], ["hi", "हिंदी"]].map(([k, l]) => `<button type="button" data-lang="${k}" aria-pressed="${L === k}" class="${k === "kn" ? "kn" : ""}">${l}</button>`).join("")}</div>
          <div class="kiosk">${KSVC.map((s) => `<button type="button" data-svc="${s.id}" aria-pressed="${Q.svc === s.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${s.icon}</svg><span class="${L === "kn" ? "kn" : ""}">${esc(pick(s))}</span>${L !== "en" ? `<span class="kn">${esc(s.en)}</span>` : ""}</button>`).join("")}</div>
          <div style="display:flex;gap:16px;flex-wrap:wrap">
            <label class="switch"><input type="checkbox" data-q="senior" ${Q.senior ? "checked" : ""}> Aged 75+</label>
            <label class="switch"><input type="checkbox" data-q="help" ${Q.help ? "checked" : ""}> Needs assistance</label>
            <label class="switch"><input type="checkbox" data-q="digital" ${Q.digital ? "checked" : ""}> Uses mobile banking</label></div>
          <label class="f" style="display:grid;gap:6px;font-size:13px"><span style="display:flex;justify-content:space-between"><span>Arrival time (${esc(D.meta.day_labels[day])})</span><b class="num">${binLab(Q.bin)}</b></span>
            <input type="range" id="k-bin" min="0" max="23" value="${Q.bin}"></label>
        </div>
        <div>${out}</div>
      </div>
    </section>`;
    v.querySelectorAll("[data-lang]").forEach((btn) => { btn.onclick = () => { Q.lang = btn.dataset.lang; render(); }; });
    v.querySelectorAll("[data-svc]").forEach((btn) => { btn.onclick = () => { Q.svc = btn.dataset.svc; render(); }; });
    v.querySelectorAll("[data-q]").forEach((c) => { c.onchange = () => { Q[c.dataset.q] = c.checked; render(); }; });
    v.querySelector("#k-bin").oninput = (e) => { Q.bin = +e.target.value; clearTimeout(renderKiosk._t); renderKiosk._t = setTimeout(render, 80); };
  }

  // ---------------------------------------------------------------- ACTIONS
  function renderActions(v) {
    const items = [];
    for (const d of D.meta.plan_days) for (const br of D.branches) {
      const X = D.days[d][br.id];
      setOf(S.approved, d, br.id).forEach((i) => items.push({ d, br, t: X.steps[i].title, kind: "Approved", imp: X.steps[i].impact }));
      setOf(S.done, d, br.id).forEach((i) => items.push({ d, br, t: X.experience[i].title, kind: "Scheduled" }));
    }
    v.innerHTML = `
    <section class="section">
      <div class="sechead"><span class="layer">Workflow</span><h2>Action log</h2><p>Everything approved, scheduled, sent or escalated in this session, across branches and days.</p></div>
      <div class="grid g-2">
        <div class="card"><h3>Approved and scheduled (${items.length})</h3><div style="display:grid;gap:6px;margin-top:8px">
          ${items.length ? items.map((x) => `<div class="msg"><div class="to">${esc(D.meta.day_labels[x.d])} · ${esc(x.br.name)} · ${x.kind}</div>${esc(x.t)}${x.imp ? ` <span class="muted">(${fmt(x.imp.avg_wait_before, 1)} → ${fmt(x.imp.avg_wait_after, 1)} min)</span>` : ""}</div>`).join("") : `<div class="empty">Nothing approved yet. Open a branch plan to start.</div>`}</div></div>
        <div class="card"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><h3>Activity</h3>
          <div style="display:flex;gap:6px"><button class="btn small" type="button" id="copy-log">Copy log</button><button class="btn small" type="button" id="reset">Reset demo</button></div></div>
          <div class="log" style="max-height:560px;margin-top:8px">${S.log.length ? S.log.map((l) => `<div class="e"><div class="t">${l.t}</div><div>${esc(l.text)} <span class="muted">· ${esc(BR[l.branch].name)} · ${esc(l.who)}</span></div></div>`).join("") : `<div class="empty">No activity yet.</div>`}</div></div>
      </div>
    </section>`;
    v.querySelector("#copy-log").onclick = () => copyText(S.log.map((l) => `${l.t} ${BR[l.branch].name}: ${l.text} (${l.who})`).join("\n") || "No activity", "Log copied");
    v.querySelector("#reset").onclick = () => { S.approved = {}; S.dismissed = {}; S.done = {}; S.sent = {}; S.log = []; S.callbacks = {}; S.liveAck = {}; S.autopilot = false; S.clock = 17 * 60 + 35; ver++; render(); toast("Demo reset"); };
  }

  // ---------------------------------------------------------------- MODEL & DATA
  function renderModel(v) {
    const M = D.model.metrics, BT = D.backtest.summary, C = D.model.calibration, Q = D.data_quality;
    const pctChg = (a, b) => Math.round((b / a - 1) * 100);
    const row = (label, o) => {
      const vals = [o.model, o.seasonal_naive, o.avg_last_4_weeks].filter((x) => x != null);
      const mx = Math.max(...vals);
      const cell = (x, col) => x == null ? "<td></td>" : `<td><div style="display:flex;align-items:center;gap:8px"><div style="flex:1;height:9px;background:var(--surface-2);border-radius:3px;overflow:hidden;min-width:50px"><i style="display:block;height:100%;width:${(x / mx) * 100}%;background:${col}"></i></div><span class="num" style="width:44px;text-align:right">${fmt(x * 100, 1)}%</span></div></td>`;
      return `<tr><td>${label}</td>${cell(o.model, "var(--s-cash)")}${cell(o.seasonal_naive, "var(--s-before)")}${cell(o.avg_last_4_weeks, "var(--s-before)")}</tr>`;
    };
    const imp = Object.entries(M.driver_importance || {});
    const impLab = { base: "Branch, service, hour, weekday", recent: "Recent demand (lags)", month_start: "Month-start", holiday: "Holidays and closures", life_cert: "Life-certificate season", year_end: "Year-end", festival: "Festivals", crop: "Crop season", fee: "Fee season", appointments: "Appointments booked" };
    const imx = Math.max(...imp.map((x) => x[1]));
    v.innerHTML = `
    <section class="section">
      <div class="sechead"><span class="layer">Evidence</span><h2>Does it work? Tested on a month the model never saw</h2>
        <p>September 2026 was held out. For each branch-day we planned from the forecast alone, then replayed the same ${fmt(BT.customers)} customers (arrival times, service times, patience) through a minute-by-minute simulation, with and without the plan. Staff lending is left out, so this is conservative.</p></div>
      <div class="tiles" style="grid-template-columns:repeat(4,minmax(0,1fr))">
        <div class="tile"><div class="k">Walkouts</div><div class="v num">${fmt(BT.walkouts.full_plan)}<small>was ${fmt(BT.walkouts.before)}</small></div><div class="was"><span class="chg good">${pctChg(BT.walkouts.before, BT.walkouts.full_plan)}%</span> · staffing alone ${pctChg(BT.walkouts.before, BT.walkouts.staffing_only)}%</div></div>
        <div class="tile"><div class="k">Average wait (served)</div><div class="v num">${fmt(BT.avg_wait.full_plan, 1)}<small>was ${fmt(BT.avg_wait.before, 1)} min</small></div><div class="was"><span class="chg good">${pctChg(BT.avg_wait.before, BT.avg_wait.full_plan)}%</span> while serving more customers</div></div>
        <div class="tile"><div class="k">Waits over target</div><div class="v num">${fmt(BT.sla_breach_share.full_plan * 100, 1)}<small>% · was ${fmt(BT.sla_breach_share.before * 100, 1)}%</small></div><div class="was">share of served customers</div></div>
        <div class="tile"><div class="k">3 busiest days per branch</div><div class="v num">${fmt(BT.busiest_days.walkouts_after)}<small>walkouts · was ${fmt(BT.busiest_days.walkouts_before)}</small></div><div class="was"><span class="chg good">${pctChg(BT.busiest_days.walkouts_before, BT.busiest_days.walkouts_after)}%</span> on the days that matter most</div></div>
      </div>
      <div class="card" style="margin-top:14px"><h3>Walkouts per day across the network, September</h3>
        <div class="legend"><span><i class="line" style="background:var(--s-before)"></i>Status quo</span><span><i class="line" style="background:var(--s-cash)"></i>With the plan</span></div><div class="chart" id="c-bt"></div></div>
    </section>
    <section class="section">
      <div class="sechead"><span class="layer">Forecast model</span><h2>LightGBM footfall forecast</h2>
        <p>Predicts customers per branch, service and hour up to 7 days ahead from the Indian banking calendar, recent demand and booked appointments. Error is WAPE (lower is better) on September.</p></div>
      <div class="grid g-2">
        <div class="card"><h3>Forecast error vs simple rules</h3>
          <div class="tbl-wrap"><table><thead><tr><th></th><th>This model</th><th>Same day last week</th><th>Average of last 4 weeks</th></tr></thead><tbody>
            ${row("Daily total per branch", M.daily_wape)}${row("Busy days (20% above normal)", M.peak_day_wape)}${row("Per counter per hour", M.pool_hour_wape)}${row("Per service per hour", M.hourly_wape)}</tbody></table></div>
          <div class="muted" style="font-size:12px;margin-top:8px">80% of daily totals fall between ${fmt(M.daily_interval.p10 * 100, 0)}% and ${fmt(M.daily_interval.p90 * 100, 0)}% of the forecast; the plan shows this range.</div></div>
        <div class="card"><h3>What drives the forecast</h3><p class="sub">Share of TreeSHAP attribution on September</p>
          ${imp.map(([k, x]) => `<div class="themebar"><span>${esc(impLab[k] || k)}</span><span class="bar"><i style="width:${(x / imx) * 100}%;background:var(--s-cash)"></i></span><span class="num" style="text-align:right">${fmt(x * 100, 0)}%</span></div>`).join("")}</div>
      </div>
      <div class="card" style="margin-top:14px"><h3>Forecast vs actual, ${esc(BR[S.branch].name)}, September</h3>
        <div class="legend"><span><i class="line" style="background:var(--s-actual)"></i>Actual</span><span><i class="line" style="background:var(--s-model)"></i>Forecast</span><span><i class="line" style="background:var(--s-before)"></i>Same day last week</span></div><div class="chart" id="c-fa"></div></div>
    </section>
    <section class="section">
      <div class="sechead"><span class="layer">Queue model</span><h2>Fast queue model, checked against the simulation</h2></div>
      <div class="grid g-2">
        <div class="card"><p class="why ink2" style="margin:0 0 10px">Counters are modelled in 15-minute steps: backlog + Erlang-C waiting (Allen–Cunneen correction, damped because branch queues never reach steady state) + gamma-distributed patience for walkouts. It runs in milliseconds, so the optimiser can test every skill-feasible counter assignment and the what-if simulator can recompute live.</p>
          <div class="tbl-wrap"><table><tbody>
            <tr><td>Mean absolute error of daily counter wait</td><td class="r num">${fmt(C.wait_mae_min, 1)} min</td></tr>
            <tr><td>Correlation with simulated waits</td><td class="r num">${fmt(C.wait_corr, 2)}</td></tr>
            <tr><td>Walkouts, September: simulated vs model</td><td class="r num">${fmt(C.walkout_total_obs)} vs ${fmt(C.walkout_total_model)}</td></tr>
            <tr><td>Walkout correlation (counter-days)</td><td class="r num">${fmt(C.walkout_corr, 2)}</td></tr></tbody></table></div></div>
        <div class="card"><h3>Data pipeline</h3><p class="sub">Synthetic token logs, rosters, appointments and feedback for 5 branches, April 2025 to September 2026</p>
          <div class="tbl-wrap"><table><tbody>
            <tr><td>Token records received</td><td class="r num">${fmt(Q.raw_rows)}</td></tr>
            <tr><td>Duplicate exports removed</td><td class="r num">${fmt(Q.duplicates_removed)}</td></tr>
            <tr><td>Timestamps in a second format, parsed</td><td class="r num">${fmt(Q.timestamps_alt_format_fixed)}</td></tr>
            <tr><td>Counter clock behind token machine, fixed</td><td class="r num">${fmt(Q.clock_skew_fixed)}</td></tr>
            <tr><td>Unclosed tokens, service time imputed</td><td class="r num">${fmt(Q.unclosed_tokens_imputed)}</td></tr>
            <tr><td>Service labels grouped</td><td class="r num">${Q.raw_service_labels} → ${Q.service_subtypes} → ${Q.service_categories}</td></tr>
            <tr><td>Customers anonymised (salted hash; mobile, CIF, birth year dropped)</td><td class="r num">${fmt(Q.customers_anonymised)}</td></tr>
            <tr><td>Feedback records / with comments</td><td class="r num">${fmt(Q.feedback_records)} / ${fmt(Q.feedback_with_text)}</td></tr>
            <tr><td>Appointments (no-show rate)</td><td class="r num">${fmt(Q.appointments)} (${fmt(Q.no_show_rate * 100, 0)}%)</td></tr></tbody></table></div></div>
      </div>
      <div class="card" style="margin-top:14px"><h3>Assumptions you can challenge</h3>
        <div class="grid g-3" style="font-size:13px">
          <div><div class="eyebrow" style="margin-bottom:6px">Wait targets</div>${POOLS.map((p) => `<div>${PL[p]}: <b>${SLA[p]} min</b></div>`).join("")}</div>
          <div><div class="eyebrow" style="margin-bottom:6px">Rupee impact (illustrative)</div>
            <div>Counter transaction ${rs(D.meta.cost.branch_txn)} vs digital ${rs(D.meta.cost.digital_txn)}</div><div>Walkout: regular ${rs(D.meta.cost.walkout_regular)}, high-value ${rs(D.meta.cost.walkout_hv)}</div><div>Overtime ${rs(D.meta.cost.overtime_hour)} / hour; lending a colleague ${rs(D.meta.cost.floating_trip)}</div></div>
          <div><div class="eyebrow" style="margin-bottom:6px">Self-service take-up when nudged</div>${Object.entries(D.meta.redirect).filter(([, r]) => r.share > 0).map(([s, r]) => `<div>${esc(D.meta.services[s].label)}: ${fmt(r.share * r.accept * 100, 0)}%${r.needs_digital ? " of digital users" : ""}</div>`).join("")}</div>
        </div></div>
    </section>`;
    requestAnimationFrame(() => {
      const byDate = {};
      D.backtest.daily.forEach((r) => { byDate[r.date] = byDate[r.date] || { b: 0, a: 0 }; byDate[r.date].b += r.walk_before; byDate[r.date].a += r.walk_after; });
      const ds = Object.keys(byDate).sort();
      Charts.lines(document.getElementById("c-bt"), { x: ds.map((d) => d.slice(8)), height: 190, dec: 0, xEvery: 3, label: "Walkouts per day", tipTitle: (i) => ds[i],
        series: [{ name: "Status quo", color: "var(--s-before)", values: ds.map((d) => byDate[d].b), width: 2 }, { name: "With the plan", color: "var(--s-cash)", values: ds.map((d) => byDate[d].a), width: 2, area: true }] });
      const h = D.model.holdout.filter((r) => r.branch === S.branch).sort((a, b2) => a.date.localeCompare(b2.date));
      Charts.lines(document.getElementById("c-fa"), { x: h.map((r) => r.date.slice(8)), height: 200, dec: 0, xEvery: 3, label: "Forecast vs actual", tipTitle: (i) => h[i].date,
        series: [{ name: "Same day last week", color: "var(--s-before)", values: h.map((r) => r.naive), width: 1.5 }, { name: "Actual", color: "var(--s-actual)", values: h.map((r) => r.y), width: 2 }, { name: "Forecast", color: "var(--s-model)", values: h.map((r) => r.pred), width: 2 }] });
    });
  }

  // ---------------------------------------------------------------- render
  function render() {
    if (!S.mounted || !document.getElementById("view")) return;
    renderHeader();
    const v = document.getElementById("view");
    Charts.hideTip();
    ({ plan: renderPlan, whatif: renderWhatIf, network: renderNetwork, voice: renderVoice, kiosk: renderKiosk, actions: renderActions, model: renderModel }[S.tab] || renderPlan)(v);
    const f = document.createElement("div");
    f.className = "foot";
    f.innerHTML = `BranchEase prototype for Banking PS 5 · all branches, staff, customers and figures are synthetic (fictional bank). Forecast: LightGBM + Shapley explanations · queue model + exhaustive staff optimiser · multilingual feedback themes.`;
    v.appendChild(f);
  }
  let rz;
  window.addEventListener("resize", () => { if (!S.mounted) return; clearTimeout(rz); rz = setTimeout(render, 150); });

  function mount(root, user) {
    S.user = user;
    S.readOnly = user.role === "counter";
    if (user.branch && BR[user.branch]) S.branch = user.branch;
    S.tab = user.role === "regional" ? "network" : "plan";
    S.wi = null;
    root.innerHTML = `
    <header class="top">
      <div class="wrap">
        <div class="brandrow">
          <a class="brand" href="#home" style="color:inherit;text-decoration:none">
            <div class="mark" aria-hidden="true">T-07</div>
            <div><h1>BranchEase <span class="rolepill">Branch staff</span></h1><p>Forecast, plan and run tomorrow's branch</p></div>
          </a>
          <div class="clock" id="clock"></div>
        </div>
        <div class="controls">
          <div class="seg" id="days" role="group" aria-label="Plan day"></div>
          <div class="seg" id="branches" role="group" aria-label="Branch"></div>
        </div>
        <nav class="tabs" id="tabs" role="tablist" aria-label="Views"></nav>
      </div>
    </header>
    <main class="wrap" id="view"></main>`;
    S.mounted = true;
    render();
    if (window.Chat) Chat.mount({ mode: "staff", user });
  }
  function unmount() { S.mounted = false; }

  // helpers for the chatbot and the customer app
  function hourlyWait(ev, pool) {
    const e = ev[pool], out = [];
    for (let h = 0; h < 6; h++) {
      let a = 0, w = 0;
      for (let x = h * 4; x < h * 4 + 4; x++) { a += e.arr_bins[x]; w += e.arr_bins[x] * e.wait_bins[x]; }
      out.push(a > 0.2 ? w / a : e.wait_bins[h * 4]);
    }
    return out;
  }
  function summary(day, b) {
    const X = D.days[day][b], st = stateFor(day, b), bef = before(day, b);
    return { X, st, now: st.ev._branch, was: bef._branch, ev: st.ev, bef, approved: [...setOf(S.approved, day, b)], dismissed: [...setOf(S.dismissed, day, b)] };
  }
  function approveLowRisk(day, b, who) {
    const X = D.days[day][b], ap = setOf(S.approved, day, b), dis = setOf(S.dismissed, day, b);
    let n = 0;
    X.steps.forEach((st, i) => { if (st.autopilot && !ap.has(i) && !dis.has(i)) { approve(day, b, i, who || "Sahayak (chat)"); n++; } });
    X.experience.forEach((ex, i) => { if (ex.autopilot && !setOf(S.done, day, b).has(i)) { markDone(day, b, i, who || "Sahayak (chat)"); n++; } });
    render();
    return n;
  }
  function approveAll(day, b, who) {
    const X = D.days[day][b], ap = setOf(S.approved, day, b);
    let n = 0;
    X.steps.forEach((_, i) => { if (!ap.has(i)) { approve(day, b, i, who || "Sahayak (chat)"); n++; } });
    render();
    return n;
  }
  function whatIf(day, b, opts) {
    const X = D.days[day][b];
    const m = 1 + (opts.demandPct || 0) / 100;
    const staff = {}, plan0 = {};
    Object.keys(X.home_plan).forEach((sid) => { if (!(opts.absent || []).includes(sid)) { staff[sid] = X.staff[sid]; plan0[sid] = { AM: X.staff[sid].home, PM: X.staff[sid].home }; } });
    (opts.extra || []).forEach((sid) => { const d2 = D.staff_dir[sid]; if (d2 && !staff[sid]) { staff[sid] = d2; plan0[sid] = { AM: d2.home, PM: d2.home }; } });
    for (const p of POOLS) if (!Object.values(staff).some((x) => x.home === p)) { const mid = "MGR-" + b; staff[mid] = { name: BR[b].manager, role: "Branch manager", home: p, factor: { [p]: 1.15 } }; plan0[mid] = { AM: p, PM: p }; }
    const lam = {}; Object.keys(X.lam).forEach((s2) => { lam[s2] = X.lam[s2].map((x) => x * m); });
    const dayIn = { lam, within: D.meta.within, svc_mean: D.meta.svc_mean, staff };
    const red = {};
    if (opts.withPlan) X.steps.forEach((s2) => { if (s2.effect.type === "redirect") red[s2.effect.service] = s2.effect.fraction; });
    const levers = { redirect: red, reschedule: [], lunch: "standard" };
    const plan = opts.withPlan ? Engine.optimize(dayIn, levers, plan0) : plan0;
    return Engine.evaluate(dayIn, plan, levers);
  }
  function go(tab, branch, day) { if (branch) S.branch = branch; if (day) S.day = day; if (tab) S.tab = tab; S.wi = null; persist(); render(); window.scrollTo({ top: 0 }); }
  function current() { return { day: S.day, branch: S.branch, tab: S.tab, user: S.user }; }
  function log(text, who, day, b) { addLog(text, who, day, b); }

  return { mount, unmount, render, stateFor, before, summary, hourlyWait, approveLowRisk, approveAll, whatIf, go, current, log };
})();
