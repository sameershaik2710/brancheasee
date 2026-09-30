/* BranchEase customer app: plan a visit, crowd meter, skip the trip, virtual token, appointments, feedback. EN / KN / HI. */
window.CustomerApp = (function () {
  "use strict";
  const D = window.DATA;
  const fmt = Charts.fmt;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const BR = Object.fromEntries(D.branches.map((b) => [b.id, b]));
  const SLA = D.meta.sla;
  const HOURS = [10, 11, 12, 13, 14, 15];

  const T = {
    en: {
      hello: "Hello, {name}", yourBranch: "Your branch", change: "Change branch", day: "Day",
      summary: "{day} at {branch}: expect a {lvl} day. Best time to go: {best}.",
      q: "quiet", m: "moderate", b: "busy", Q: "Quiet", M: "Moderate", B: "Busy",
      whatNeed: "What do you need to do?", pick: "Pick a service to see the wait, what to bring and whether you need to visit at all.",
      skip: "You may not need to visit", skipNo: "This one needs a visit",
      crowd: "Expected wait at the {counter}", tap: "Tap an hour to choose when you'll arrive.", min: "min",
      best: "Best time", nearby: "Nearby branches at {hour}", bring: "Bring these", token: "Get a token from home for {hour}",
      appt: "Book an appointment instead", mine: "My tokens and appointments", none: "Nothing booked yet. Pick a service above.",
      rate: "How was your last visit?", rateSub: "Tap a face. A low rating alerts the branch manager straight away.",
      comment: "Tell us more (optional)", send: "Send", thanks: "Thank you. Your feedback reached the branch.",
      sorry: "Sorry about that. The branch manager has been alerted and will call you back.",
      help: "Need extra help?", cancel: "Cancel", sms: "We'll send an SMS 10 minutes before your turn.",
      priority: "Priority lane", callAt: "Expected to be called around", counter: "Counter",
      CASH: "cash counter", GENERAL: "general counter", EXPERT: "loans and advisory desk",
      closed: "Branch closed on", ask: "Ask Sahayak",
    },
    kn: {
      hello: "ನಮಸ್ಕಾರ, {name}", yourBranch: "ನಿಮ್ಮ ಶಾಖೆ", change: "ಶಾಖೆ ಬದಲಿಸಿ", day: "ದಿನ",
      summary: "{day} {branch} ಶಾಖೆಯಲ್ಲಿ {lvl} ಇರಲಿದೆ. ಹೋಗಲು ಉತ್ತಮ ಸಮಯ: {best}.",
      q: "ಕಡಿಮೆ ಜನಸಂದಣಿ", m: "ಸಾಧಾರಣ ಜನಸಂದಣಿ", b: "ಹೆಚ್ಚು ಜನಸಂದಣಿ", Q: "ಕಡಿಮೆ", M: "ಸಾಧಾರಣ", B: "ಹೆಚ್ಚು",
      whatNeed: "ನಿಮಗೆ ಯಾವ ಕೆಲಸ ಆಗಬೇಕು?", pick: "ಸೇವೆಯನ್ನು ಆಯ್ಕೆಮಾಡಿ: ಕಾಯುವ ಸಮಯ, ತರಬೇಕಾದ ದಾಖಲೆಗಳು ಮತ್ತು ಶಾಖೆಗೆ ಬರಬೇಕೇ ಎಂದು ನೋಡಿ.",
      skip: "ನೀವು ಶಾಖೆಗೆ ಬರಬೇಕಿಲ್ಲದಿರಬಹುದು", skipNo: "ಈ ಕೆಲಸಕ್ಕೆ ಶಾಖೆಗೆ ಬರಬೇಕು",
      crowd: "{counter} ನಲ್ಲಿ ನಿರೀಕ್ಷಿತ ಕಾಯುವ ಸಮಯ", tap: "ನೀವು ಬರುವ ಸಮಯವನ್ನು ಆಯ್ಕೆಮಾಡಿ.", min: "ನಿಮಿಷ",
      best: "ಉತ್ತಮ ಸಮಯ", nearby: "{hour}ಕ್ಕೆ ಹತ್ತಿರದ ಶಾಖೆಗಳು", bring: "ಇವುಗಳನ್ನು ತನ್ನಿ", token: "{hour}ಕ್ಕೆ ಮನೆಯಿಂದಲೇ ಟೋಕನ್ ಪಡೆಯಿರಿ",
      appt: "ಬದಲಿಗೆ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಬುಕ್ ಮಾಡಿ", mine: "ನನ್ನ ಟೋಕನ್ ಮತ್ತು ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್‌ಗಳು", none: "ಇನ್ನೂ ಏನೂ ಬುಕ್ ಆಗಿಲ್ಲ. ಮೇಲೆ ಸೇವೆಯನ್ನು ಆಯ್ಕೆಮಾಡಿ.",
      rate: "ನಿಮ್ಮ ಕೊನೆಯ ಭೇಟಿ ಹೇಗಿತ್ತು?", rateSub: "ಒಂದು ಮುಖವನ್ನು ಒತ್ತಿ. ಕಡಿಮೆ ರೇಟಿಂಗ್ ತಕ್ಷಣ ಶಾಖಾ ವ್ಯವಸ್ಥಾಪಕರಿಗೆ ತಿಳಿಯುತ್ತದೆ.",
      comment: "ಇನ್ನಷ್ಟು ತಿಳಿಸಿ (ಐಚ್ಛಿಕ)", send: "ಕಳುಹಿಸಿ", thanks: "ಧನ್ಯವಾದಗಳು. ನಿಮ್ಮ ಅಭಿಪ್ರಾಯ ಶಾಖೆಗೆ ತಲುಪಿದೆ.",
      sorry: "ಕ್ಷಮಿಸಿ. ಶಾಖಾ ವ್ಯವಸ್ಥಾಪಕರಿಗೆ ತಿಳಿಸಲಾಗಿದೆ, ಅವರು ನಿಮಗೆ ಕರೆ ಮಾಡುತ್ತಾರೆ.",
      help: "ಹೆಚ್ಚಿನ ಸಹಾಯ ಬೇಕೆ?", cancel: "ರದ್ದುಮಾಡಿ", sms: "ನಿಮ್ಮ ಸರದಿಗೆ 10 ನಿಮಿಷ ಮೊದಲು SMS ಕಳುಹಿಸುತ್ತೇವೆ.",
      priority: "ಆದ್ಯತೆಯ ಸಾಲು", callAt: "ಸುಮಾರು ಈ ಸಮಯಕ್ಕೆ ಕರೆಯಲಾಗುತ್ತದೆ", counter: "ಕೌಂಟರ್",
      CASH: "ನಗದು ಕೌಂಟರ್", GENERAL: "ಸಾಮಾನ್ಯ ಕೌಂಟರ್", EXPERT: "ಸಾಲ ಮತ್ತು ಸಲಹಾ ವಿಭಾಗ",
      closed: "ಶಾಖೆ ಮುಚ್ಚಿರುತ್ತದೆ:", ask: "ಸಹಾಯಕನನ್ನು ಕೇಳಿ",
    },
    hi: {
      hello: "नमस्ते, {name}", yourBranch: "आपकी शाखा", change: "शाखा बदलें", day: "दिन",
      summary: "{day} को {branch} शाखा में {lvl} रहेगी। जाने का सबसे अच्छा समय: {best}।",
      q: "कम भीड़", m: "सामान्य भीड़", b: "ज़्यादा भीड़", Q: "कम", M: "सामान्य", B: "ज़्यादा",
      whatNeed: "आपको क्या काम है?", pick: "सेवा चुनें: प्रतीक्षा समय, कौन से दस्तावेज़ लाने हैं, और क्या शाखा आना ज़रूरी है।",
      skip: "शायद शाखा आने की ज़रूरत नहीं", skipNo: "इस काम के लिए शाखा आना होगा",
      crowd: "{counter} पर अनुमानित प्रतीक्षा", tap: "आने का समय चुनें।", min: "मिनट",
      best: "सबसे अच्छा समय", nearby: "{hour} पर पास की शाखाएँ", bring: "ये साथ लाएँ", token: "{hour} के लिए घर से टोकन लें",
      appt: "इसकी जगह अपॉइंटमेंट बुक करें", mine: "मेरे टोकन और अपॉइंटमेंट", none: "अभी कुछ बुक नहीं है। ऊपर सेवा चुनें।",
      rate: "आपकी पिछली विज़िट कैसी रही?", rateSub: "एक चेहरा चुनें। कम रेटिंग पर शाखा प्रबंधक को तुरंत सूचना मिलती है।",
      comment: "और बताएँ (वैकल्पिक)", send: "भेजें", thanks: "धन्यवाद। आपकी राय शाखा तक पहुँच गई।",
      sorry: "हमें खेद है। शाखा प्रबंधक को सूचना दी गई है, वे आपको कॉल करेंगे।",
      help: "अतिरिक्त मदद चाहिए?", cancel: "रद्द करें", sms: "आपकी बारी से 10 मिनट पहले SMS भेजेंगे।",
      priority: "प्राथमिकता कतार", callAt: "लगभग इस समय बुलाया जाएगा", counter: "काउंटर",
      CASH: "नकद काउंटर", GENERAL: "सामान्य काउंटर", EXPERT: "ऋण और सलाह डेस्क",
      closed: "शाखा बंद रहेगी:", ask: "सहायक से पूछें",
    },
  };
  const SVCS = [
    { id: "CASH", en: "Cash deposit / withdrawal", kn: "ನಗದು ಜಮೆ / ಹಿಂಪಡೆಯುವಿಕೆ", hi: "नकद जमा / निकासी", icon: '<rect x="3" y="7" width="18" height="11" rx="2"/><circle cx="12" cy="12.5" r="2.5"/>' },
    { id: "PASSBOOK", en: "Passbook update / balance", kn: "ಪಾಸ್‌ಬುಕ್ / ಬಾಕಿ", hi: "पासबुक / बैलेंस", icon: '<path d="M6 3h11a1 1 0 0 1 1 1v16H7a2 2 0 0 1-2-2V4a1 1 0 0 1 1-1Z"/><path d="M9 7h6M9 11h6"/>' },
    { id: "ACCOUNT", en: "KYC, mobile or address update", kn: "ಕೆವೈಸಿ / ಮೊಬೈಲ್ / ವಿಳಾಸ", hi: "केवाईसी / मोबाइल / पता", icon: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1-4 4-6 7-6s6 2 7 6"/>' },
    { id: "REMIT", en: "DD, NEFT or cheque", kn: "ಡಿಡಿ / ನೆಫ್ಟ್ / ಚೆಕ್", hi: "डीडी / एनईएफ़टी / चेक", icon: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>' },
    { id: "PENSION", en: "Pension / life certificate", kn: "ಪಿಂಚಣಿ / ಜೀವನ ಪ್ರಮಾಣಪತ್ರ", hi: "पेंशन / जीवन प्रमाणपत्र", icon: '<path d="M12 21s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.5-7 10-7 10Z"/>' },
    { id: "LOAN", en: "Loan, FD or advice", kn: "ಸಾಲ / ಎಫ್‌ಡಿ / ಸಲಹೆ", hi: "ऋण / एफडी / सलाह", icon: '<path d="M3 10 12 4l9 6"/><path d="M5 10v9h14v-9"/><path d="M10 19v-5h4v5"/>' },
  ];
  const DOCS = {
    CASH: ["Passbook or debit card", "Filled deposit / withdrawal slip (the kiosk can print one)"],
    PASSBOOK: ["Passbook"],
    ACCOUNT: ["Aadhaar card", "PAN card", "One passport-size photo", "Passbook"],
    REMIT: ["Passbook or cheque book", "Beneficiary name, account number and IFSC", "PAN card for amounts of ₹50,000 or more"],
    PENSION: ["Pension payment order (PPO) number", "Aadhaar card", "Passbook"],
    LOAN: ["Aadhaar and PAN", "Last 3 salary slips or land records", "6 months' bank statement"],
  };

  const C = { user: null, lang: "en", day: D.meta.plan_days[0], branch: "B01", svc: null, hour: null, rating: 0, fbSent: null, mounted: false, apptOpen: false };
  const t = (k, v) => { let s = (T[C.lang] && T[C.lang][k]) || T.en[k] || k; if (v) for (const x in v) s = s.split("{" + x + "}").join(v[x]); return s; };
  const svcName = (id, lang) => { const s = SVCS.find((x) => x.id === id); return s ? (s[lang || C.lang] || s.en) : id; };
  const tIn = (lang, k, v) => { const keep = C.lang; C.lang = lang || keep; const r = t(k, v); C.lang = keep; return r; };
  const mins = (w) => (w < 1 ? "<1" : String(Math.round(w)));
  const hh = (h) => `${String(h).padStart(2, "0")}:00`;
  const priority = () => C.user && (C.user.age !== "18-59" || C.user.help);

  function waits(day, b, pool) { return StaffApp.hourlyWait(StaffApp.stateFor(day, b).ev, pool); }
  function level(w, pool) { const r = w / SLA[pool]; return r < 0.5 ? "q" : r < 1 ? "m" : "b"; }
  function bestHour(ws) { let bi = 0; ws.forEach((w, i) => { if (w < ws[bi] - 0.5) bi = i; }); return bi; }
  function dayOverview(day, b) {
    let worst = 0, wpool = "CASH";
    const hours = HOURS.map((_, i) => 0);
    ["CASH", "GENERAL", "EXPERT"].forEach((p) => { const ws = waits(day, b, p); ws.forEach((w, i) => { hours[i] = Math.max(hours[i], w / SLA[p]); }); const m = Math.max(...ws); if (m / SLA[p] > worst / SLA[wpool]) { worst = m; wpool = p; } });
    const bi = bestHour(hours);
    const r = worst / SLA[wpool];
    return { lvl: r < 0.5 ? "q" : r < 1 ? "m" : "b", best: `${hh(HOURS[bi])}–${hh(HOURS[bi] + 1)}` };
  }
  function neighbours(b) { return BR[b].neighbors.filter((n) => n.km <= 25); }

  function mount(root, user) {
    C.user = user; C.lang = user.lang || "en"; C.branch = user.branch || "B01"; C.mounted = true;
    C.svc = null; C.hour = null; C.fbSent = null; C.rating = 0; C.apptOpen = false;
    root.innerHTML = `<div id="cview"></div>`;
    render();
    if (window.Chat) Chat.mount({ mode: "customer", user });
  }
  function unmount() { C.mounted = false; }
  function ctx() { return { day: C.day, branch: C.branch, svc: C.svc, lang: C.lang, hour: C.hour, user: C.user }; }

  function tokenFor(day, b, svc, hourIdx) {
    const pool = D.meta.services[svc].pool;
    const X = D.days[day][b];
    let before = 0;
    Object.keys(X.lam).forEach((s) => { if (D.meta.services[s].pool === pool) for (let h = 0; h < hourIdx; h++) before += X.lam[s][h]; });
    const mine = Store.data.tokens.filter((x) => x.branch === b && x.day === day && x.pool === pool).length;
    const no = Math.round(before) + 3 + mine;
    const w = waits(day, b, pool)[hourIdx] * (priority() ? 0.35 : 1);
    const arrive = HOURS[hourIdx] * 60 + 10;
    const call = arrive + Math.max(2, Math.round(w));
    return { id: "T" + Date.now(), kind: "token", day, branch: b, svc, pool, token: `${"CGL"["CASH GENERAL EXPERT".split(" ").indexOf(pool)]}-${String(no).padStart(3, "0")}`,
      arrive: `${String(Math.floor(arrive / 60)).padStart(2, "0")}:${String(arrive % 60).padStart(2, "0")}`,
      call: `${String(Math.floor(call / 60)).padStart(2, "0")}:${String(call % 60).padStart(2, "0")}`, wait: Math.round(w), priority: !!priority(), status: "booked", mobile: C.user.mobile };
  }

  function render() {
    const v = document.getElementById("cview");
    if (!C.mounted || !v) return;
    Charts.hideTip();
    const u = C.user, b = C.branch, day = C.day;
    const ov = dayOverview(day, b);
    const mine = Store.data.tokens.filter((x) => x.mobile === u.mobile && x.status !== "cancelled");
    const closures = D.meta.closures.filter((c) => c.reason !== "Sunday").slice(0, 3);
    let detail = "";
    if (C.svc) {
      const pool = D.meta.services[C.svc].pool, red = D.meta.redirect[C.svc];
      const ws = waits(day, b, pool);
      const bi = bestHour(ws);
      if (C.hour == null) C.hour = bi;
      const mx = Math.max(...ws, SLA[pool] * 1.1);
      const canSkip = red.share > 0 && (!red.needs_digital || u.digital);
      const skipText = red.share === 0 ? "Loans and advice need a conversation with an officer. Book an appointment to skip the queue."
        : red.needs_digital && !u.digital ? `This can be done on ${red.short}, but that needs mobile or internet banking. A family member can help, or book a quiet slot below.`
          : `Most ${red.noun} requests can be done at ${red.short}. ${C.svc === "PASSBOOK" ? "The kiosk is at the entrance; no token needed, and staff will help." : C.svc === "PENSION" ? "Customers aged 80+ can ask for doorstep banking (below)." : "It takes a couple of minutes."}`;
      const near = neighbours(b).map((n) => { const w = waits(day, n.id, pool)[C.hour]; return { n, w }; });
      const hereW = ws[C.hour];
      const apptOK = ["LOAN", "ACCOUNT", "PENSION"].includes(C.svc);
      detail = `
      <div class="grid g-7-5" style="margin-top:14px">
        <div style="display:grid;gap:14px;align-content:start">
          <div class="card ${canSkip ? "skipcard" : ""}"><div class="eyebrow">${canSkip ? t("skip") : t("skipNo")}</div><p class="why" style="margin:6px 0 0;font-size:14px;color:var(--ink)">${esc(skipText)}</p></div>
          <div class="card"><h3>${t("crowd", { counter: t(pool) })}</h3><p class="sub">${esc(BR[b].name)} · ${esc(D.meta.day_labels[day])} · ${t("tap")}</p>
            <div class="hourbars" role="group" aria-label="Expected wait by hour">
              ${ws.map((w, i) => { const lv = level(w, pool); return `<button type="button" class="hb ${i === bi ? "best" : ""}" data-hour="${i}" aria-pressed="${i === C.hour}" title="${hh(HOURS[i])}: about ${mins(w)} ${t("min")}">
                <span class="hv num">${mins(w)} ${t("min")}</span><span class="col lvl-${lv}" style="height:${Math.max(6, (w / mx) * 110)}px"></span><span class="hl">${hh(HOURS[i]).slice(0, 2)}</span>${i === bi ? `<span class="chip good" style="font-size:10.5px;padding:0 6px">${t("best")}</span>` : ""}</button>`; }).join("")}
            </div>
            <div class="legend" style="margin-top:10px"><span><i class="lvl-q"></i>${t("Q")}</span><span><i class="lvl-m"></i>${t("M")}</span><span><i class="lvl-b"></i>${t("B")}</span>${priority() ? `<span class="chip acc">${t("priority")}: about a third of this wait</span>` : ""}</div>
          </div>
          <div class="card"><h3>${t("nearby", { hour: hh(HOURS[C.hour]) })}</h3>
            <div class="tbl-wrap"><table><tbody>
              <tr><td><b>${esc(BR[b].name)}</b> <span class="muted">(${t("yourBranch").toLowerCase()})</span></td><td class="r num">${mins(hereW)} ${t("min")}</td><td><span class="chip ${level(hereW, pool) === "b" ? "crit" : level(hereW, pool) === "m" ? "warn" : "good"}">${t(level(hereW, pool).toUpperCase())}</span></td></tr>
              ${near.map(({ n, w }) => `<tr><td>${esc(BR[n.id].name)} <span class="muted">${fmt(n.km, 0)} km</span></td><td class="r num">${mins(w)} ${t("min")}</td><td><span class="chip ${level(w, pool) === "b" ? "crit" : level(w, pool) === "m" ? "warn" : "good"}">${t(level(w, pool).toUpperCase())}</span></td></tr>`).join("")}
            </tbody></table></div></div>
        </div>
        <div style="display:grid;gap:14px;align-content:start">
          <div class="card"><h3>${t("bring")}</h3><ul class="ticks">${DOCS[C.svc].map((d) => `<li>${esc(d)}</li>`).join("")}</ul></div>
          <div class="card" style="display:grid;gap:10px">
            ${C.svc !== "LOAN" ? `<button class="btn primary block" type="button" id="gettoken">${t("token", { hour: hh(HOURS[C.hour]) })}</button>` : ""}
            ${apptOK ? `<button class="btn ${C.svc === "LOAN" ? "primary" : ""} block" type="button" id="openappt">${t("appt")}</button>` : ""}
            <div id="apptbox"></div>
            <div class="muted" style="font-size:12.5px">${t("sms")}</div>
          </div>
        </div>
      </div>`;
    }
    const faces = [1, 2, 3, 4, 5].map((r) => `<button type="button" class="face" data-rate="${r}" aria-pressed="${C.rating === r}" aria-label="${r} of 5">${faceSvg(r)}<span>${["Very bad", "Bad", "Okay", "Good", "Great"][r - 1]}</span></button>`).join("");
    v.innerHTML = `
    <header class="ctop"><div class="wrap brandrow">
      <a class="brand" href="#home" style="color:inherit;text-decoration:none"><div class="mark" aria-hidden="true">T-07</div><div><h1>BranchEase <span class="rolepill">Customer</span></h1><p>${esc(D.meta.bank)}</p></div></a>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <div class="seg" role="group" aria-label="Language">${[["en", "English"], ["kn", "ಕನ್ನಡ"], ["hi", "हिंदी"]].map(([k, l]) => `<button type="button" data-lang="${k}" aria-pressed="${C.lang === k}">${l}</button>`).join("")}</div>
        <div class="userchip"><span class="avatar" aria-hidden="true">${esc(u.name.charAt(0))}</span><span><b>${esc(u.name)}</b><br><span class="muted">${esc(u.mobile.slice(0, 2))}XXXXXX${esc(u.mobile.slice(-2))}</span></span><button type="button" class="btn small" data-logout>Log out</button></div>
      </div></div></header>
    <main class="wrap" style="padding-block:18px 90px">
      <section class="card greet">
        <div style="display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap;align-items:flex-start">
          <div style="min-width:0;flex:1 1 320px"><h2>${esc(t("hello", { name: u.name.split(" ")[0] }))}</h2>
            <p class="bigline">${esc(t("summary", { day: D.meta.day_labels[day], branch: BR[b].name, lvl: t(ov.lvl), best: ov.best }))}</p>
            ${closures.length ? `<p class="muted" style="margin:6px 0 0;font-size:13px">${t("closed")} ${closures.map((c) => `${new Date(c.date + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })} (${esc(c.reason)})`).join(", ")}</p>` : ""}</div>
          <div style="display:grid;gap:8px;min-width:0">
            <label class="field" style="font-size:12.5px">${t("yourBranch")}<select id="cbranch">${D.branches.map((x) => `<option value="${x.id}" ${x.id === b ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select></label>
            <div class="seg" role="group" aria-label="${t("day")}">${D.meta.plan_days.map((d) => `<button type="button" data-cday="${d}" aria-pressed="${d === day}">${esc(D.meta.day_labels[d])}</button>`).join("")}</div>
          </div>
        </div>
      </section>

      <section class="section">
        <div class="sechead"><h2>${t("whatNeed")}</h2><p>${t("pick")}</p></div>
        <div class="kiosk svcgrid">${SVCS.map((s) => `<button type="button" data-svc="${s.id}" aria-pressed="${C.svc === s.id}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${s.icon}</svg><span class="${C.lang === "kn" ? "kn" : ""}">${esc(s[C.lang] || s.en)}</span>${C.lang !== "en" ? `<span class="kn">${esc(s.en)}</span>` : ""}</button>`).join("")}</div>
        ${detail}
      </section>

      <section class="section">
        <div class="grid g-2">
          <div class="card"><h3>${t("mine")}</h3>
            <div style="display:grid;gap:10px;margin-top:8px">${mine.length ? mine.slice().reverse().map((x) => ticket(x)).join("") : `<div class="empty">${t("none")}</div>`}</div></div>
          <div style="display:grid;gap:14px;align-content:start">
            <div class="card"><h3>${t("rate")}</h3><p class="sub">${t("rateSub")}</p>
              ${C.fbSent ? `<div class="msg" style="background:${C.fbSent <= 2 ? "var(--warn-bg)" : "var(--good-bg)"}">${C.fbSent <= 2 ? t("sorry") : t("thanks")}</div>` : `
              <div class="faces" role="group" aria-label="Rating">${faces}</div>
              <label class="field" style="margin-top:10px">${t("comment")}<textarea id="fbtext" rows="2" placeholder="e.g. waited long at the cash counter"></textarea></label>
              <button class="btn primary" type="button" id="fbsend" style="margin-top:8px" ${C.rating ? "" : "disabled"}>${t("send")}</button>`}
            </div>
            <div class="card"><h3>${t("help")}</h3>
              <div style="display:grid;gap:8px;margin-top:6px;font-size:13.5px">
                <div>${priority() ? `<span class="chip good">On</span> ${t("priority")}: your tokens go to the priority lane automatically.` : `<span class="chip">Off</span> ${t("priority")}: for customers aged 60+ or who need assistance.`}</div>
                <div><button class="btn small" type="button" id="doorstep" ${u.age === "80+" || u.help ? "" : "disabled"}>Request doorstep banking</button> <span class="muted" style="font-size:12.5px">For customers aged 80+ or with a disability</span></div>
                <div><button class="btn small" type="button" id="askbot">${t("ask")}</button> <span class="muted" style="font-size:12.5px">Chat in English, ಕನ್ನಡ or हिंदी</span></div>
              </div></div>
          </div>
        </div>
      </section>
      <div class="foot">Demo: ${esc(D.meta.bank)} and all figures are synthetic. Waits come from the same forecast and branch plan the staff dashboard uses, so a plan the manager approves changes what you see here.</div>
    </main>`;

    // events
    v.querySelectorAll("[data-lang]").forEach((x) => { x.onclick = () => { C.lang = x.dataset.lang; render(); if (window.Chat) Chat.refresh(); }; });
    v.querySelector("#cbranch").onchange = (e) => { C.branch = e.target.value; C.hour = null; render(); };
    v.querySelectorAll("[data-cday]").forEach((x) => { x.onclick = () => { C.day = x.dataset.cday; C.hour = null; render(); }; });
    v.querySelectorAll("[data-svc]").forEach((x) => { x.onclick = () => { C.svc = x.dataset.svc; C.hour = null; C.apptOpen = false; render(); document.querySelector(".hourbars")?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }; });
    v.querySelectorAll("[data-hour]").forEach((x) => { x.onclick = () => { C.hour = +x.dataset.hour; render(); }; });
    const gt = v.querySelector("#gettoken");
    if (gt) gt.onclick = () => bookToken(C.svc, C.hour);
    const oa = v.querySelector("#openappt");
    if (oa) oa.onclick = () => { C.apptOpen = !C.apptOpen; render(); };
    if (C.apptOpen && C.svc) renderAppt(v.querySelector("#apptbox"));
    v.querySelectorAll("[data-cancel]").forEach((x) => { x.onclick = () => { const it = Store.data.tokens.find((k) => k.id === x.dataset.cancel); if (it) { it.status = "cancelled"; Store.save(); UI.toast("Cancelled"); render(); } }; });
    v.querySelectorAll("[data-rate]").forEach((x) => { x.onclick = () => { C.rating = +x.dataset.rate; render(); }; });
    const fs = v.querySelector("#fbsend");
    if (fs) fs.onclick = () => {
      const txt = (v.querySelector("#fbtext").value || "").trim().slice(0, 400);
      const now = new Date();
      Store.data.feedback.push({ branch: C.branch, rating: C.rating, comment: txt, service: C.svc ? svcName(C.svc) : "", senior: C.user.age !== "18-59", time: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`, at: now.toISOString() });
      Store.save();
      if (C.rating <= 2 && window.StaffApp) StaffApp.log(`Low rating (${C.rating}★) from a customer in the app: floor manager alerted`, "Customer app", StaffApp.current().day, C.branch);
      C.fbSent = C.rating; render();
    };
    const ds = v.querySelector("#doorstep");
    if (ds) ds.onclick = () => { Store.data.requests.push({ type: "doorstep", branch: C.branch, mobile: C.user.mobile, at: new Date().toISOString() }); Store.save(); if (window.StaffApp) StaffApp.log("Doorstep banking requested by a customer (80+ / assistance)", "Customer app", StaffApp.current().day, C.branch); UI.toast("Request sent. The branch will call you to fix a time."); ds.disabled = true; };
    v.querySelector("#askbot").onclick = () => { if (window.Chat) Chat.open(); };
  }

  function ticket(x) {
    const when = D.meta.day_labels[x.day] || x.day;
    if (x.kind === "appt") return `<div class="ticket"><div class="tno mono">${esc(x.slot)}</div><div style="min-width:0"><div><b>${esc(svcName(x.svc))}</b> · appointment</div><div class="muted" style="font-size:12.5px">${esc(BR[x.branch].name)} · ${esc(when)} · ${t(x.pool)} · served first, expected wait under 5 ${t("min")}</div><div style="margin-top:6px"><button class="btn small" type="button" data-cancel="${x.id}">${t("cancel")}</button></div></div></div>`;
    return `<div class="ticket"><div class="tno mono" style="color:var(--s-${x.pool === "CASH" ? "cash" : x.pool === "GENERAL" ? "gen" : "exp"})">${esc(x.token)}</div><div style="min-width:0"><div><b>${esc(svcName(x.svc))}</b>${x.priority ? ` <span class="chip acc">${t("priority")}</span>` : ""}</div><div class="muted" style="font-size:12.5px">${esc(BR[x.branch].name)} · ${esc(when)} · ${t(x.pool)} · arrive ${esc(x.arrive)} · ${t("callAt")} ${esc(x.call)}</div><div style="margin-top:6px"><button class="btn small" type="button" data-cancel="${x.id}">${t("cancel")}</button></div></div></div>`;
  }

  function bookToken(svc, hourIdx) {
    const tk = tokenFor(C.day, C.branch, svc, hourIdx);
    Store.data.tokens.push(tk); Store.save();
    UI.toast(`Token ${tk.token} booked for ${D.meta.day_labels[C.day]}`);
    render();
    return tk;
  }
  function renderAppt(box) {
    const pool = D.meta.services[C.svc].pool;
    const ws = waits(C.day, C.branch, pool);
    const slots = [];
    for (let h = 0; h < 6; h++) for (const m of [0, 30]) slots.push({ label: `${String(HOURS[h]).padStart(2, "0")}:${m ? "30" : "00"}`, w: ws[h], h });
    const minW = Math.min(...slots.map((s) => s.w));
    box.innerHTML = `<div class="eyebrow" style="margin:4px 0 6px">Choose a slot · ${esc(D.meta.day_labels[C.day])}</div><div class="slots">${slots.map((s) => `<button type="button" class="slot ${s.w <= minW + 1 ? "rec" : ""}" data-slot="${s.label}|${s.h}">${s.label}<small>${s.w <= minW + 1 ? "quiet" : level(s.w, pool) === "b" ? "busy" : "ok"}</small></button>`).join("")}</div>`;
    box.querySelectorAll("[data-slot]").forEach((x) => { x.onclick = () => {
      const [label, h] = x.dataset.slot.split("|");
      Store.data.tokens.push({ id: "A" + Date.now(), kind: "appt", day: C.day, branch: C.branch, svc: C.svc, pool, slot: label, hour: +h, status: "booked", mobile: C.user.mobile });
      Store.save(); C.apptOpen = false; UI.toast(`Appointment booked at ${label}`); render();
    }; });
  }
  function faceSvg(r) {
    const mouth = { 1: "M8 16c1.2-1.6 2.5-2.2 4-2.2s2.8.6 4 2.2", 2: "M8.5 15.5c1-.8 2.1-1.1 3.5-1.1s2.5.3 3.5 1.1", 3: "M8.5 15h7", 4: "M8.5 14.5c1 .8 2.1 1.1 3.5 1.1s2.5-.3 3.5-1.1", 5: "M8 14c1.2 1.8 2.5 2.4 4 2.4s2.8-.6 4-2.4" }[r];
    return `<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="9" cy="10" r=".9" fill="currentColor"/><circle cx="15" cy="10" r=".9" fill="currentColor"/><path d="${mouth}"/></svg>`;
  }

  // for the chatbot
  function api() {
    return { ctx, waits, level, bestHour, svcName, DOCS, SVCS, t: (k, v, lang) => tIn(lang, k, v), neighbours, hh, HOURS, mins,
      setService: (s) => { C.svc = s; C.hour = null; render(); },
      setLang: (l) => { C.lang = l; render(); },
      book: (svc, hourIdx) => bookToken(svc, hourIdx == null ? bestHour(waits(C.day, C.branch, D.meta.services[svc].pool)) : hourIdx),
      priority };
  }
  return { mount, unmount, render, ctx, api };
})();
