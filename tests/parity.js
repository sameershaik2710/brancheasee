// Parity check: the browser engine must reproduce the Python engine's numbers.
const fs = require("fs");
const vm = require("vm");
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + "/../website/data.js", "utf8"), ctx);
const DATA = ctx.window.DATA;
const E = require("../website/engine.js");
E.configure(DATA.meta);
let n = 0, maxd = 0, planMismatch = 0;
for (const d of DATA.meta.plan_days) {
  for (const b of DATA.branches) {
    const D = DATA.days[d][b.id];
    const day = { lam: D.lam, within: DATA.meta.within, svc_mean: DATA.meta.svc_mean, staff: D.staff };
    // before: home plan of staff present at the start (exclude borrowed staff)
    const homeIds = Object.keys(D.home_plan);
    const dayHome = { ...day, staff: Object.fromEntries(homeIds.map((k) => [k, D.staff[k]])) };
    const evB = E.evaluate(dayHome, D.home_plan, {});
    const evA = E.evaluate(day, D.plan, D.levers);
    for (const [ev, k] of [[evB, D.kpi_before], [evA, D.kpi_after]]) {
      const diffs = [Math.abs(ev._branch.avg_wait - k.avg_wait), Math.abs(ev._branch.peak_wait - k.peak_wait), Math.abs(ev._branch.walkouts - k.walkouts)];
      maxd = Math.max(maxd, ...diffs); n++;
      if (Math.max(...diffs) > 0.06) console.log("MISMATCH", d, b.id, ev._branch, k);
    }
    // optimiser parity on the step levers (before staff step)
    const st = D.steps.find((s) => s.kind === "staff");
    if (st) {
      const lev = { redirect: {}, reschedule: [], lunch: "standard" };
      for (const s of D.steps) {
        if (s.kind === "staff") break;
        if (s.effect.type === "redirect") lev.redirect[s.effect.service] = s.effect.fraction;
        if (s.effect.type === "reschedule") lev.reschedule.push(...s.effect.moves);
      }
      const opt = E.optimize(dayHome, lev);
      for (const m of st.effect.moves) if (opt[m.staff][m.block] !== m.to) { planMismatch++; console.log("PLAN MISMATCH", d, b.id, m); }
    }
  }
}
console.log(`checked ${n} KPI sets, max abs diff ${maxd.toFixed(4)}, optimiser mismatches ${planMismatch}`);
