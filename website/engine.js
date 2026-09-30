/* Decision engine (browser port of src/engine.py - keep the two in step).
   Queue model per counter pool in 15-minute bins + exhaustive staff optimiser. */
(function (root) {
  "use strict";
  const POOLS = ["CASH", "GENERAL", "EXPERT"];
  const SERVICES = ["CASH", "PASSBOOK", "ACCOUNT", "REMIT", "PENSION", "LOAN"];
  const POOL_OF = { CASH: "CASH", PASSBOOK: "GENERAL", ACCOUNT: "GENERAL", REMIT: "GENERAL", PENSION: "GENERAL", LOAN: "EXPERT" };
  const BIN = 15;
  let P = { patience: { CASH: 30, GENERAL: 33, EXPERT: 51 }, rho_cap: 0.85, cv_factor: 0.65, t_window: 120, nb_day: 24, nb_max: 40, am_bins: 12 };
  let SLA = { CASH: 15, GENERAL: 20, EXPERT: 30 };
  let COST = null;

  function configure(meta) {
    P = meta.engine; SLA = meta.sla; COST = meta.cost;
  }

  function erfc(x) {
    const t = 1.0 / (1.0 + 0.3275911 * x);
    const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    return y * Math.exp(-x * x);
  }
  function walkProb(w, mean) {
    if (w <= 0) return 0;
    const x = w / (mean / 2.5);
    const q = erfc(Math.sqrt(x)) + (1.5 * Math.sqrt(x) + Math.pow(x, 1.5)) * Math.exp(-x) / (0.75 * Math.sqrt(Math.PI));
    return Math.min(1, Math.max(0, 1 - q));
  }
  function erlangWait(c, A, s) {
    if (c <= 0) return 0;
    A = Math.min(A, P.rho_cap * c);
    if (A <= 0) return 0;
    let term = 1, total = 1;
    for (let k = 1; k < c; k++) { term *= A / k; total += term; }
    const top = term * A / c * c / (c - A);
    const pw = top / (total + top);
    const rho = A / c;
    const tau = s / (c * Math.pow(1 - Math.sqrt(rho), 2));
    return P.cv_factor * pw * s / (c - A) * (1 - Math.exp(-P.t_window / tau));
  }

  function binArrivals(lam, within, levers) {
    const red = levers.redirect || {};
    const out = {};
    for (const s of SERVICES) {
      const hourly = lam[s].slice();
      for (const r of levers.reschedule || []) {
        if (r.service === s) {
          const mv = Math.min(r.count, hourly[r.from_hour]);
          hourly[r.from_hour] -= mv; hourly[r.to_hour] += mv;
        }
      }
      const keep = 1 - (red[s] || 0);
      const arr = new Array(P.nb_max).fill(0);
      for (let h = 0; h < 6; h++) for (let q = 0; q < 4; q++) arr[h * 4 + q] = hourly[h] * keep * within[h][q];
      out[s] = arr;
    }
    return out;
  }

  function lunchIntervals(plan, policy) {
    const byPool = {};
    for (const sid of Object.keys(plan)) (byPool[plan[sid].PM] = byPool[plan[sid].PM] || []).push(sid);
    const out = {};
    for (const pool of Object.keys(byPool)) {
      const ids = byPool[pool].slice().sort();
      if (ids.length === 1) out[ids[0]] = [210, 240];
      else if (policy === "one_at_a_time") ids.forEach((sid, j) => { out[sid] = [180 + 30 * j, 210 + 30 * j]; });
      else ids.forEach((sid, j) => { out[sid] = j % 2 === 0 ? [195, 225] : [225, 255]; });
    }
    return out;
  }

  /* day = {lam, within, svc_mean, staff:{id:{factor:{pool:f}}}} ; plan = {id:{AM,PM}} */
  function evaluate(day, plan, levers) {
    levers = levers || {};
    const NB = P.nb_max, ND = P.nb_day;
    const arr = binArrivals(day.lam, day.within, levers);
    const lunch = lunchIntervals(plan, levers.lunch || "standard");
    const res = {};
    for (const pool of POOLS) {
      const svcs = SERVICES.filter((s) => POOL_OF[s] === pool);
      const a = new Array(NB).fill(0);
      for (let b = 0; b < NB; b++) for (const s of svcs) a[b] += arr[s][b];
      const tot = {}; let totSum = 0;
      for (const s of svcs) { tot[s] = arr[s].reduce((x, y) => x + y, 0); totSum += tot[s]; }
      let dayMix;
      if (totSum > 0) { let n = 0; for (const s of svcs) n += tot[s] * day.svc_mean[s]; dayMix = n / Math.max(1e-9, totSum); }
      else { let n = 0; for (const s of svcs) n += day.svc_mean[s]; dayMix = n / svcs.length; }
      const waits = new Array(NB).fill(0), walks = new Array(NB).fill(0), servedW = new Array(NB).fill(0);
      const servers = new Array(NB).fill(0), mu = new Array(NB).fill(0);
      for (let b = 0; b < NB; b++) {
        let lamB = 0, num = 0;
        for (const s of svcs) { lamB += arr[s][b]; num += arr[s][b] * day.svc_mean[s]; }
        const sB = lamB > 1e-9 ? num / lamB : dayMix;
        const t0 = b * BIN, block = b < P.am_bins ? "AM" : "PM";
        let r = 0, c = 0;
        for (const sid of Object.keys(plan)) {
          if (plan[sid][block] !== pool) continue;
          const lw = lunch[sid];
          if (lw && lw[0] <= t0 && t0 < lw[1]) continue;
          const f = day.staff[sid].factor[pool] !== undefined ? day.staff[sid].factor[pool] : 1.2;
          r += 1 / (sB * f); c += 1;
        }
        servers[b] = c; mu[b] = r;
      }
      let B = 0, lastBusy = 0;
      for (let b = 0; b < NB; b++) {
        const ab = a[b], c = servers[b], r = mu[b];
        let W, cap;
        if (c === 0) {
          let k = b;
          while (k < NB && servers[k] === 0) k++;
          const rNext = k < NB ? mu[k] : 1e-6;
          W = (ab > 0 || B > 0) ? (k - b) * BIN - BIN / 2 + B / Math.max(rNext, 1e-6) : 0;
          cap = 0;
        } else {
          const sEff = c / r;
          const A = (ab / BIN) * sEff;
          cap = r * BIN;
          const overflow = Math.max(0, ab - cap) / 2;
          W = B / r + erlangWait(c, A, sEff) + overflow / r;
        }
        const p = walkProb(W, P.patience[pool]);
        const eff = ab * (1 - p);
        waits[b] = W; walks[b] = ab * p; servedW[b] = eff;
        B = Math.max(0, B + eff - cap);
        if (B > 0.05 || ab > 0.05) lastBusy = b;
      }
      let totA = 0, wsum = 0, ssum = 0, sw = 0, wk = 0;
      for (let b = 0; b < NB; b++) { totA += a[b]; wsum += a[b] * waits[b]; ssum += servedW[b] * waits[b]; sw += servedW[b]; wk += walks[b]; }
      const hourly = [];
      for (let h = 0; h < 6; h++) {
        let ah = 0, aw = 0;
        for (let x = h * 4; x < h * 4 + 4; x++) { ah += a[x]; aw += a[x] * waits[x]; }
        if (ah > 1.0) hourly.push(aw / ah);
      }
      const peak = hourly.length ? Math.max(...hourly) : 0;
      const overtime = Math.max(0, (lastBusy + 1 - ND) * BIN);
      const breach = [];
      for (let b = 0; b < ND; b++) if (waits[b] > SLA[pool] && a[b] > 0.3) breach.push(b);
      res[pool] = {
        arrivals: totA, walkouts: wk, wait_minutes: wsum, avg_wait: totA ? wsum / totA : 0,
        avg_wait_served: ssum / Math.max(1e-9, sw), peak_wait: peak, overtime_min: overtime, breach_bins: breach,
        wait_bins: waits.slice(0, ND), arr_bins: a.slice(0, ND), servers_bins: servers.slice(0, ND),
      };
    }
    let tot = 0, wo = 0, wm = 0, pk = 0, ot = 0, br = 0;
    for (const p of POOLS) {
      tot += res[p].arrivals; wo += res[p].walkouts; wm += res[p].wait_minutes;
      pk = Math.max(pk, res[p].peak_wait); ot = Math.max(ot, res[p].overtime_min); br += res[p].breach_bins.length;
    }
    res._branch = { arrivals: tot, walkouts: wo, wait_minutes: wm, avg_wait: tot ? wm / tot : 0, peak_wait: pk, overtime_min: ot, breaches: br };
    return res;
  }

  function objective(ev, plan, home) {
    let moves = 0;
    for (const s of Object.keys(plan)) moves += (plan[s].AM !== home[s] ? 1 : 0) + (plan[s].PM !== home[s] ? 1 : 0);
    let ot = 0;
    for (const p of POOLS) ot += ev[p].overtime_min;
    return ev._branch.wait_minutes + 30 * ev._branch.walkouts + 2 * ot + 8 * moves;
  }

  function homePlan(day) {
    const plan = {};
    for (const sid of Object.keys(day.staff)) plan[sid] = { AM: day.staff[sid].home, PM: day.staff[sid].home };
    return plan;
  }

  function* product(opts) {
    const n = opts.length, idx = new Array(n).fill(0);
    if (n === 0) { yield []; return; }
    while (true) {
      yield idx.map((i, k) => opts[k][i]);
      let k = n - 1;
      while (k >= 0) { idx[k]++; if (idx[k] < opts[k].length) break; idx[k] = 0; k--; }
      if (k < 0) return;
    }
  }

  function clonePlan(p) { const o = {}; for (const k of Object.keys(p)) o[k] = { AM: p[k].AM, PM: p[k].PM }; return o; }

  /* fixed: Set of "sid|AM" / "sid|PM" that must not change */
  function optimize(day, levers, start, fixed) {
    levers = levers || {}; fixed = fixed || new Set();
    let plan = clonePlan(start || homePlan(day));
    const home = {};
    for (const sid of Object.keys(plan)) home[sid] = day.staff[sid].home;
    const ids = Object.keys(plan);
    let bestObj = objective(evaluate(day, plan, levers), plan, home);
    for (let pass = 0; pass < 2; pass++) {
      for (const block of ["AM", "PM"]) {
        const opts = ids.map((sid) => fixed.has(sid + "|" + block) ? [plan[sid][block]] : Object.keys(day.staff[sid].factor));
        for (const combo of product(opts)) {
          const trial = clonePlan(plan);
          ids.forEach((sid, i) => { trial[sid][block] = combo[i]; });
          const ev = evaluate(day, trial, levers);
          let bad = false;
          for (const p of POOLS) if (ev[p].arrivals > 0.5 && ids.every((x) => trial[x][block] !== p)) { bad = true; break; }
          if (bad) continue;
          const o = objective(ev, trial, home);
          if (o < bestObj - 1e-6) { bestObj = o; plan = trial; }
        }
      }
    }
    return plan;
  }

  function walkoutValue(w, hv) { return w * (hv * COST.walkout_hv + (1 - hv) * COST.walkout_regular); }
  function rupees(before, after, hv, moved) {
    const wo = before._branch.walkouts - after._branch.walkouts;
    let otB = 0, otA = 0;
    for (const p of POOLS) {
      otB += before[p].overtime_min * Math.max(1, before[p].servers_bins[before[p].servers_bins.length - 1]);
      otA += after[p].overtime_min * Math.max(1, after[p].servers_bins[after[p].servers_bins.length - 1]);
    }
    return Math.round(walkoutValue(wo, hv) + (otB - otA) / 60 * COST.overtime_hour + (moved || 0) * (COST.branch_txn - COST.digital_txn));
  }

  const api = { configure, evaluate, optimize, homePlan, clonePlan, objective, rupees, walkProb, erlangWait, POOLS, SERVICES, POOL_OF };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Engine = api;
})(typeof window !== "undefined" ? window : globalThis);
