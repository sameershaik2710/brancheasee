/* Small SVG chart kit: stacked columns, wait small-multiples, line chart, tooltip. */
(function (root) {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  const tip = () => document.getElementById("tip");
  function showTip(html, x, y) {
    const t = tip(); t.innerHTML = html; t.hidden = false;
    const w = t.offsetWidth, h = t.offsetHeight;
    let left = x + 14, top = y + 14;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (top + h > window.innerHeight - 8) top = y - h - 14;
    t.style.left = Math.max(8, left) + "px"; t.style.top = Math.max(8, top) + "px";
  }
  function hideTip() { tip().hidden = true; }
  function niceMax(v) {
    if (v <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }
  function ticks(max, n) {
    const step = niceMax(max / n);
    const out = [];
    for (let v = 0; v <= max + 1e-9; v += step) out.push(+v.toFixed(6));
    return out;
  }
  function roundTop(x, y, w, h, r) {
    r = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  const fmt = (v, d = 0) => Number(v).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d });

  /* stacked columns: cats (labels), series [{name,color,values}] */
  function columns(host, o) {
    host.innerHTML = "";
    const W = Math.max(280, host.clientWidth || 600), H = o.height || 200;
    const m = { l: 34, r: 8, t: 10, b: 24 };
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": o.label || "chart" }, host);
    const n = o.cats.length, iw = W - m.l - m.r, ih = H - m.t - m.b;
    const totals = o.cats.map((_, i) => o.series.reduce((s, se) => s + se.values[i], 0));
    const ymax = niceMax(Math.max(...totals, 1) * 1.05);
    const y = (v) => m.t + ih - (v / ymax) * ih;
    for (const t of ticks(ymax, 4)) {
      el("line", { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: "gridl" }, svg);
      const tx = el("text", { x: m.l - 6, y: y(t) + 3.5, "text-anchor": "end" }, svg); tx.textContent = fmt(t);
    }
    const band = iw / n, bw = Math.min(28, band * 0.62);
    for (let i = 0; i < n; i++) {
      const cx = m.l + band * i + band / 2;
      let acc = 0;
      const segs = o.series.map((se) => ({ se, v: se.values[i] })).filter((s) => s.v > 0.01);
      segs.forEach((s, k) => {
        const y0 = y(acc), y1 = y(acc + s.v);
        const hgt = Math.max(0, y0 - y1 - (k < segs.length - 1 ? 2 : 0));
        const top = k === segs.length - 1;
        const x = cx - bw / 2;
        if (top) el("path", { d: roundTop(x, y1, bw, Math.max(0, y0 - y1 - (k > 0 ? 2 : 0)), 4), fill: s.se.color }, svg);
        else el("rect", { x, y: y0 - hgt, width: bw, height: hgt, fill: s.se.color }, svg);
        acc += s.v;
      });
      const lab = el("text", { x: cx, y: H - 7, "text-anchor": "middle" }, svg); lab.textContent = o.cats[i];
      const hit = el("rect", { x: cx - band / 2, y: m.t, width: band, height: ih, fill: "transparent" }, svg);
      hit.addEventListener("mousemove", (ev) => {
        const rows = o.series.map((se) => `<div><span class="sw" style="background:${se.color}"></span>${se.name}: <b>${fmt(se.values[i])}</b></div>`).join("");
        showTip(`<div><b>${o.tipTitle ? o.tipTitle(i) : o.cats[i]}</b></div>${rows}<div>Total: <b>${fmt(totals[i])}</b></div>`, ev.clientX, ev.clientY);
      });
      hit.addEventListener("mouseleave", hideTip);
    }
    el("line", { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), stroke: "var(--axis)" }, svg);
  }

  /* line chart over x labels; series [{name,color,values,width,muted}] ; optional hline {value,label} */
  function lines(host, o) {
    host.innerHTML = "";
    const W = Math.max(220, host.clientWidth || 400), H = o.height || 150;
    const m = { l: o.ml || 30, r: 10, t: 12, b: 22 };
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": o.label || "chart" }, host);
    const n = o.x.length, iw = W - m.l - m.r, ih = H - m.t - m.b;
    let vmax = 0;
    for (const s of o.series) for (const v of s.values) if (v != null) vmax = Math.max(vmax, v);
    if (o.hline) vmax = Math.max(vmax, o.hline.value * 1.15);
    const ymax = niceMax(Math.max(o.minMax || 1, vmax * 1.08));
    const xp = (i) => m.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const y = (v) => m.t + ih - (v / ymax) * ih;
    for (const t of ticks(ymax, 3)) {
      el("line", { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: "gridl" }, svg);
      const tx = el("text", { x: m.l - 5, y: y(t) + 3.5, "text-anchor": "end" }, svg); tx.textContent = fmt(t);
    }
    const every = o.xEvery || Math.ceil(n / 6);
    for (let i = 0; i < n; i += every) {
      const tx = el("text", { x: xp(i), y: H - 6, "text-anchor": i === 0 ? "start" : "middle" }, svg); tx.textContent = o.x[i];
    }
    if (o.hline) {
      el("line", { x1: m.l, x2: W - m.r, y1: y(o.hline.value), y2: y(o.hline.value), stroke: "var(--status-crit)", "stroke-width": 1, opacity: 0.7 }, svg);
      const tx = el("text", { x: W - m.r, y: y(o.hline.value) - 4, "text-anchor": "end" }, svg); tx.textContent = o.hline.label;
    }
    for (const s of o.series) {
      let d = "", pen = false;
      s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += (pen ? "L" : "M") + xp(i).toFixed(1) + "," + y(v).toFixed(1); pen = true; });
      el("path", { d, fill: "none", stroke: s.color, "stroke-width": s.width || 2, "stroke-linejoin": "round", "stroke-linecap": "round", opacity: s.muted ? 0.9 : 1 }, svg);
      if (s.area) {
        const a = d + `L${xp(n - 1)},${y(0)}L${xp(0)},${y(0)}Z`;
        el("path", { d: a, fill: s.color, opacity: 0.1 }, svg);
      }
    }
    el("line", { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), stroke: "var(--axis)" }, svg);
    const cross = el("line", { x1: 0, x2: 0, y1: m.t, y2: m.t + ih, stroke: "var(--axis)", visibility: "hidden" }, svg);
    const dots = o.series.map((s) => el("circle", { r: 4, fill: s.color, stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" }, svg));
    const hit = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" }, svg);
    hit.addEventListener("mousemove", (ev) => {
      const r = svg.getBoundingClientRect();
      const px = (ev.clientX - r.left) * (W / r.width);
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / iw) * (n - 1))));
      cross.setAttribute("x1", xp(i)); cross.setAttribute("x2", xp(i)); cross.setAttribute("visibility", "visible");
      o.series.forEach((s, k) => {
        const v = s.values[i];
        if (v == null) { dots[k].setAttribute("visibility", "hidden"); return; }
        dots[k].setAttribute("cx", xp(i)); dots[k].setAttribute("cy", y(v)); dots[k].setAttribute("visibility", "visible");
      });
      const rows = o.series.map((s) => s.values[i] == null ? "" : `<div><span class="sw" style="background:${s.color}"></span>${s.name}: <b>${fmt(s.values[i], o.dec == null ? 1 : o.dec)}${o.unit || ""}</b></div>`).join("");
      showTip(`<div><b>${o.tipTitle ? o.tipTitle(i) : o.x[i]}</b></div>${rows}`, ev.clientX, ev.clientY);
    });
    hit.addEventListener("mouseleave", () => { hideTip(); cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); });
  }

  /* simple grouped horizontal bars in HTML are built by the app; vertical bars with labels */
  function bars(host, o) {
    host.innerHTML = "";
    const W = Math.max(240, host.clientWidth || 400), H = o.height || 160;
    const m = { l: 30, r: 8, t: 16, b: 24 };
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": o.label || "chart" }, host);
    const n = o.cats.length, iw = W - m.l - m.r, ih = H - m.t - m.b;
    const ymax = o.ymax || niceMax(Math.max(...o.values, o.minMax || 0) * 1.1);
    const y = (v) => m.t + ih - (v / ymax) * ih;
    for (const t of ticks(ymax, 3)) {
      el("line", { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: "gridl" }, svg);
      const tx = el("text", { x: m.l - 5, y: y(t) + 3.5, "text-anchor": "end" }, svg); tx.textContent = fmt(t, o.tickDec || 0);
    }
    const band = iw / n, bw = Math.min(26, band * 0.55);
    o.values.forEach((v, i) => {
      const cx = m.l + band * i + band / 2;
      el("path", { d: roundTop(cx - bw / 2, y(v), bw, y(0) - y(v), 4), fill: (o.colors && o.colors[i]) || o.color }, svg);
      const t = el("text", { x: cx, y: y(v) - 5, "text-anchor": "middle", style: "fill:var(--ink);font-weight:600" }, svg); t.textContent = o.fmt ? o.fmt(v) : fmt(v, 1);
      const l = el("text", { x: cx, y: H - 7, "text-anchor": "middle" }, svg); l.textContent = o.cats[i];
    });
    el("line", { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0), stroke: "var(--axis)" }, svg);
  }

  root.Charts = { columns, lines, bars, showTip, hideTip, fmt };
})(window);
