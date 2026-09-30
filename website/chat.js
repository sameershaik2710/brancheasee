/* Sahayak chatbot. Rule-based intents answered from the forecast and plan (works offline, EN / KN / HI,
   including Kannada or Hindi typed in English letters). When the page runs inside a Claude viewer that grants
   the `sample` capability, questions the rules don't cover go to Claude with the same data as context. */
window.Chat = (function () {
  "use strict";
  const D = window.DATA;
  const fmt = Charts.fmt;
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const BR = Object.fromEntries(D.branches.map((b) => [b.id, b]));
  const PL = D.meta.pool_label, SLA = D.meta.sla;
  const HOURS = [10, 11, 12, 13, 14, 15];
  const hh = (h) => `${String(h).padStart(2, "0")}:00`;

  const st = { mode: null, user: null, open: false, msgs: [], turns: [], ai: null, busy: false, ctl: null, acts: {}, seq: 0 };

  // ------------------------------------------------------------ language
  const KN_WORDS = /\b(ide|ideya|idya|beku|madbeku|maadbeku|yavaga|eshtu|hege|illa|nimisha|sarathi|jana|barbeku|hogbeku|namaskara|dhanyavada|shakhe)\b/;
  const HI_WORDS = /\b(kitna|kitni|kab|kya|hai|chahiye|kaise|bheed|karna|karni|jana|jaana|mujhe|namaste|shukriya|dhanyavaad|bataiye|batao|kaun)\b/;
  function detectLang(text, fallback) {
    if (/[ಀ-೿]/.test(text)) return "kn";
    if (/[ऀ-ॿ]/.test(text)) return "hi";
    const t = text.toLowerCase();
    if (KN_WORDS.test(t)) return "kn";
    if (HI_WORDS.test(t)) return "hi";
    return fallback || "en";
  }
  const L = {
    en: {
      hi: "Hello{name}! I'm Sahayak. Ask me how busy the branch will be, the best time to go, what to bring, or book a token.",
      svcQ: "Which service is it for?",
      over: "<b>{svc}</b> at {branch} on {day}: the {counter} is quietest around <b>{best}</b> (about {bw} min) and busiest around {peak} (about {pw} min).",
      skipY: "You may not need to visit: {how}.", skipN: "This one needs a visit to the branch.",
      bring: "Bring: {docs}.", booked: "Done. Token <b>{tok}</b> for {day}. Arrive at {arr}; you should be called around {call}. We'll SMS you 10 minutes before.",
      bookQ: "Shall I book a token for {svc} at the quietest time, {best}?",
      closed: "The branch is open 10:00–16:00, Monday to Saturday, except Sundays and the 2nd and 4th Saturdays. Coming closures: {list}.",
      near: "At {hour} for the {counter}: {list}.", thanks: "You're welcome! Anything else?",
      human: "I've asked the branch helpdesk to call you back on your registered number within working hours. (Demo: no call will be made.)",
      fb: "Sorry to hear that. You can rate your visit on the page; a rating of 1 or 2 stars alerts the branch manager immediately. Shall I alert the manager now?",
      alerted: "The branch manager has been alerted and will call you back.",
      miss: "Sorry, I didn't get that. Try asking: \"How long is the wait for cash tomorrow?\" or \"What do I need for KYC?\"",
      day: "Busiest counter on {day} at {branch}: {counter}, about {pw} min around {peak}. Quietest time overall: {best}.",
    },
    kn: {
      hi: "ನಮಸ್ಕಾರ{name}! ನಾನು ಸಹಾಯಕ. ಶಾಖೆಯಲ್ಲಿ ಎಷ್ಟು ಜನಸಂದಣಿ ಇರುತ್ತದೆ, ಯಾವಾಗ ಹೋಗುವುದು ಉತ್ತಮ, ಯಾವ ದಾಖಲೆ ತರಬೇಕು ಎಂದು ಕೇಳಿ, ಅಥವಾ ಟೋಕನ್ ಬುಕ್ ಮಾಡಿ.",
      svcQ: "ಯಾವ ಸೇವೆಗಾಗಿ?",
      over: "<b>{svc}</b>: {day} {branch} ಶಾಖೆಯ {counter}ನಲ್ಲಿ <b>{best}</b>ಕ್ಕೆ ಕಡಿಮೆ ಜನ (ಸುಮಾರು {bw} ನಿಮಿಷ), {peak}ಕ್ಕೆ ಹೆಚ್ಚು ಜನ (ಸುಮಾರು {pw} ನಿಮಿಷ).",
      skipY: "ನೀವು ಶಾಖೆಗೆ ಬರಬೇಕಿಲ್ಲದಿರಬಹುದು: {how}.", skipN: "ಈ ಕೆಲಸಕ್ಕೆ ಶಾಖೆಗೆ ಬರಬೇಕು.",
      bring: "ತನ್ನಿ: {docs}.", booked: "ಆಯಿತು. {day} ದಿನಕ್ಕೆ ಟೋಕನ್ <b>{tok}</b>. {arr}ಕ್ಕೆ ಬನ್ನಿ; ಸುಮಾರು {call}ಕ್ಕೆ ಕರೆಯಲಾಗುತ್ತದೆ. 10 ನಿಮಿಷ ಮೊದಲು SMS ಬರುತ್ತದೆ.",
      bookQ: "{svc}ಗೆ ಕಡಿಮೆ ಜನರಿರುವ ಸಮಯ {best}ಕ್ಕೆ ಟೋಕನ್ ಬುಕ್ ಮಾಡಲೇ?",
      closed: "ಶಾಖೆ ಸೋಮವಾರದಿಂದ ಶನಿವಾರ 10:00–16:00 ತೆರೆದಿರುತ್ತದೆ (ಭಾನುವಾರ ಮತ್ತು 2ನೇ, 4ನೇ ಶನಿವಾರ ರಜೆ). ಮುಂದಿನ ರಜೆಗಳು: {list}.",
      near: "{hour}ಕ್ಕೆ {counter}: {list}.", thanks: "ಸ್ವಾಗತ! ಇನ್ನೇನಾದರೂ ಬೇಕೆ?",
      human: "ಶಾಖೆಯ ಸಹಾಯವಾಣಿ ನಿಮಗೆ ಕರೆ ಮಾಡಲು ತಿಳಿಸಿದ್ದೇನೆ. (ಡೆಮೊ: ಕರೆ ಬರುವುದಿಲ್ಲ.)",
      fb: "ಕ್ಷಮಿಸಿ. ಪುಟದಲ್ಲಿ ನಿಮ್ಮ ಭೇಟಿಗೆ ರೇಟಿಂಗ್ ನೀಡಬಹುದು; 1 ಅಥವಾ 2 ನಕ್ಷತ್ರ ನೀಡಿದರೆ ಶಾಖಾ ವ್ಯವಸ್ಥಾಪಕರಿಗೆ ತಕ್ಷಣ ತಿಳಿಯುತ್ತದೆ. ಈಗಲೇ ತಿಳಿಸಲೇ?",
      alerted: "ಶಾಖಾ ವ್ಯವಸ್ಥಾಪಕರಿಗೆ ತಿಳಿಸಲಾಗಿದೆ, ಅವರು ಕರೆ ಮಾಡುತ್ತಾರೆ.",
      miss: "ಕ್ಷಮಿಸಿ, ಅರ್ಥವಾಗಲಿಲ್ಲ. ಹೀಗೆ ಕೇಳಿ: \"ನಾಳೆ ನಗದು ಕೌಂಟರ್‌ನಲ್ಲಿ ಎಷ್ಟು ಹೊತ್ತು ಕಾಯಬೇಕು?\"",
      day: "{day} {branch}: ಹೆಚ್ಚು ಜನ {counter}ನಲ್ಲಿ, {peak}ಕ್ಕೆ ಸುಮಾರು {pw} ನಿಮಿಷ. ಕಡಿಮೆ ಜನರಿರುವ ಸಮಯ: {best}.",
    },
    hi: {
      hi: "नमस्ते{name}! मैं सहायक हूँ। पूछिए शाखा में कितनी भीड़ होगी, कब जाना ठीक है, क्या साथ लाना है, या टोकन बुक करें।",
      svcQ: "किस सेवा के लिए?",
      over: "<b>{svc}</b>: {day} को {branch} शाखा के {counter} पर <b>{best}</b> के आसपास सबसे कम भीड़ (लगभग {bw} मिनट) और {peak} के आसपास सबसे ज़्यादा (लगभग {pw} मिनट)।",
      skipY: "शायद शाखा आने की ज़रूरत नहीं: {how}।", skipN: "इस काम के लिए शाखा आना होगा।",
      bring: "साथ लाएँ: {docs}।", booked: "हो गया। {day} के लिए टोकन <b>{tok}</b>। {arr} पर आएँ; लगभग {call} पर बुलाया जाएगा। 10 मिनट पहले SMS आएगा।",
      bookQ: "क्या {svc} के लिए सबसे कम भीड़ वाले समय {best} पर टोकन बुक कर दूँ?",
      closed: "शाखा सोमवार से शनिवार 10:00–16:00 खुली रहती है (रविवार और दूसरे व चौथे शनिवार बंद)। आने वाली छुट्टियाँ: {list}।",
      near: "{hour} पर {counter}: {list}।", thanks: "आपका स्वागत है! और कुछ?",
      human: "मैंने शाखा हेल्पडेस्क को आपको कॉल करने के लिए कहा है। (डेमो: कॉल नहीं आएगी।)",
      fb: "हमें खेद है। पेज पर अपनी विज़िट को रेटिंग दें; 1 या 2 स्टार पर शाखा प्रबंधक को तुरंत सूचना मिलती है। क्या अभी सूचना दूँ?",
      alerted: "शाखा प्रबंधक को सूचना दे दी गई है, वे आपको कॉल करेंगे।",
      miss: "माफ़ कीजिए, समझ नहीं आया। ऐसे पूछें: \"कल नकद काउंटर पर कितना इंतज़ार होगा?\"",
      day: "{day} को {branch}: सबसे ज़्यादा भीड़ {counter} पर, {peak} के आसपास लगभग {pw} मिनट। सबसे कम भीड़ का समय: {best}।",
    },
  };
  const tr = (lang, k, v) => { let s = (L[lang] && L[lang][k]) || L.en[k]; for (const x in v || {}) s = s.split("{" + x + "}").join(v[x]); return s; };

  const SVC_RE = {
    PENSION: /pension|life certificate|life cert|jeevan pra|pinchan|ಪಿಂಚಣಿ|ಜೀವನ|पेंशन|जीवन प्रमाण/,
    PASSBOOK: /passbook|pass book|\bpb\b|balance|ಪಾಸ್|ಬಾಕಿ|पासबुक|बैलेंस/,
    ACCOUNT: /kyc|account open|new account|mobile number|mobile no|address|nominee|aadhaar|ಕೆವೈಸಿ|ಖಾತೆ|केवाईसी|खाता|पता/,
    REMIT: /\bdd\b|demand draft|neft|rtgs|transfer|cheque|\bchq\b|ಡಿಡಿ|ಚೆಕ್|डीडी|चेक|ट्रांसफर/,
    LOAN: /loan|\bfd\b|fixed deposit|gold loan|home loan|\bkcc\b|advice|\bnri\b|ಸಾಲ|ऋण|लोन/,
    CASH: /cash|withdraw|deposit|nagadu|nakad|paisa|paise|ನಗದು|ಹಣ|नकद|पैसा/,
  };
  function findService(t) { for (const k of Object.keys(SVC_RE)) if (SVC_RE[k].test(t)) return k; return null; }
  function findBranch(t) { const b = D.branches.find((x) => t.includes(x.name.toLowerCase())); return b ? b.id : null; }
  function findDay(t) {
    const days = D.meta.plan_days;
    if (/tomorrow|naale|kal\b|ನಾಳೆ|कल/.test(t)) return days[0];
    const names = { mon: 1, tue: 2, wed: 3, thu: 4, sat: 6 };
    for (const d of days) {
      const dt = new Date(d + "T00:00:00"), wd = dt.getDay();
      const nm = Object.keys(names).find((k) => names[k] === wd);
      if (nm && new RegExp("\\b" + nm).test(t)) return d;
      if (new RegExp("\\b" + dt.getDate() + "\\s*(oct|october)?\\b").test(t) && /oct|october|\b\d{1,2}\s*(st|nd|rd|th)\b/.test(t)) return d;
    }
    return null;
  }

  // ------------------------------------------------------------ rendering
  const root = () => document.getElementById("chatroot");
  function render() {
    const r = root();
    if (!r) return;
    if (!st.mode) { r.innerHTML = ""; return; }
    const staff = st.mode === "staff";
    r.innerHTML = `
      <button type="button" class="chatfab" id="chatfab" aria-label="${st.open ? "Close chat" : "Open Sahayak chat"}" aria-expanded="${st.open}">
        ${st.open ? '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>'
        : '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M4 5h16v11H9l-5 4Z"/><path d="M8 10h8M8 13h5" stroke-linecap="round"/></svg>'}
        ${st.open ? "" : '<span class="fablabel">Sahayak</span>'}
      </button>
      ${st.open ? `<section class="chatpanel" role="dialog" aria-label="Sahayak chat">
        <div class="chathead"><div class="avatar" aria-hidden="true">S</div><div style="flex:1;min-width:0"><b>Sahayak</b> ${st.ai ? '<span class="chip acc" style="font-size:10.5px">AI on</span>' : ""}<div class="muted" style="font-size:12px">${staff ? "Ask about tomorrow's plan, alerts, what-ifs" : "Waits, tokens, documents · English, ಕನ್ನಡ, हिंदी"}</div></div>
          <button type="button" class="btn small" id="chatclose" aria-label="Close chat">Close</button></div>
        <div class="chatlog" id="chatlog" aria-live="polite">${st.msgs.map((m, i) => `<div class="bub ${m.from}">${m.html}</div>${m.chips && i === st.msgs.length - 1 ? `<div class="chips2">${m.chips.map((c) => `<button type="button" data-act="${c.id}">${esc(c.label)}</button>`).join("")}</div>` : ""}`).join("")}
          ${st.busy ? `<div class="bub bot thinking">Thinking… <button type="button" class="linkbtn" id="chatstop">Stop</button></div>` : ""}</div>
        <form class="chatform" id="chatform"><input id="chatin" autocomplete="off" placeholder="${staff ? "e.g. why is tomorrow busy?" : "e.g. naale cash ge eshtu rush ide?"}" aria-label="Message"><button class="btn primary" type="submit">Send</button></form>
      </section>` : ""}`;
    r.querySelector("#chatfab").onclick = () => { st.open = !st.open; render(); if (st.open) focusIn(); };
    if (!st.open) return;
    r.querySelector("#chatclose").onclick = () => { st.open = false; render(); };
    const log = r.querySelector("#chatlog"); log.scrollTop = log.scrollHeight;
    r.querySelectorAll("[data-act]").forEach((b) => { b.onclick = () => { const a = st.acts[b.dataset.act]; if (a) { me(esc(a.label)); a.fn(); } }; });
    r.querySelector("#chatform").onsubmit = (e) => { e.preventDefault(); const v = r.querySelector("#chatin").value.trim(); if (!v || st.busy) return; me(esc(v)); handle(v); };
    const stop = r.querySelector("#chatstop");
    if (stop) stop.onclick = () => st.ctl && st.ctl.abort();
  }
  function focusIn() { const i = document.getElementById("chatin"); if (i) i.focus(); }
  function chip(label, fn) { const id = "a" + (++st.seq); st.acts[id] = { label, fn }; return { id, label }; }
  function bot(html, chips) { st.msgs.push({ from: "bot", html, chips }); render(); }
  function me(html) { st.msgs.push({ from: "me", html }); render(); }

  // ------------------------------------------------------------ customer brain
  function cApi() { return CustomerApp.api(); }
  function serviceOverview(svc, lang, dayOverride, branchOverride) {
    const A = cApi(), c = A.ctx();
    const day = dayOverride || c.day, b = branchOverride || c.branch;
    const pool = D.meta.services[svc].pool;
    const ws = A.waits(day, b, pool);
    const bi = A.bestHour(ws);
    let pi = 0; ws.forEach((w, i) => { if (w > ws[pi]) pi = i; });
    const red = D.meta.redirect[svc];
    const lines = [tr(lang, "over", { svc: esc(A.svcName(svc, lang)), branch: esc(BR[b].name), day: esc(D.meta.day_labels[day]), counter: esc(A.t(pool, null, lang)), best: hh(HOURS[bi]), bw: A.mins(ws[bi]), peak: hh(HOURS[pi]), pw: A.mins(ws[pi]) })];
    if (red.share > 0 && (!red.needs_digital || c.user.digital)) lines.push(tr(lang, "skipY", { how: esc(red.short) }));
    else if (red.share === 0) lines.push(tr(lang, "skipN"));
    lines.push(tr(lang, "bring", { docs: esc(A.DOCS[svc].join(", ")) }));
    if (A.priority()) lines.push(lang === "kn" ? "ನಿಮಗೆ ಆದ್ಯತೆಯ ಸಾಲು ಸಿಗುತ್ತದೆ, ಕಾಯುವ ಸಮಯ ಕಡಿಮೆ." : lang === "hi" ? "आपको प्राथमिकता कतार मिलेगी, इंतज़ार कम होगा।" : "You get the priority lane, so your wait is shorter.");
    return { html: lines.join("<br><br>"), best: bi, day, b };
  }
  function customerTurn(text) {
    const A = cApi(), c = A.ctx();
    const t = text.toLowerCase();
    const lang = detectLang(text, c.lang);
    const svc = findService(t);
    const day = findDay(t) || c.day;
    const b = findBranch(t) || c.branch;
    const svcChips = () => A.SVCS.map((s) => chip(s[lang] || s.en, () => { A.setService(s.id); const o = serviceOverview(s.id, lang); bot(o.html, bookChips(s.id, o.best, lang)); }));
    if (/^(hi|hello|hey|namaskara|namaskar|namaste|ನಮಸ್ಕಾರ|नमस्ते)\b/.test(t) && t.length < 25) return bot(tr(lang, "hi", { name: ", " + esc(c.user.name.split(" ")[0]) }), svcChips()), true;
    if (/thank|dhanyavad|shukriya|ಧನ್ಯವಾದ|धन्यवाद/.test(t)) return bot(tr(lang, "thanks")), true;
    if (/\b(kannada|ಕನ್ನಡ)\b/.test(t) && t.length < 30) { A.setLang("kn"); return bot(tr("kn", "hi", { name: "" })), true; }
    if (/\b(hindi|हिंदी)\b/.test(t) && t.length < 30) { A.setLang("hi"); return bot(tr("hi", "hi", { name: "" })), true; }
    if (/\benglish\b/.test(t) && t.length < 30) { A.setLang("en"); return bot(tr("en", "hi", { name: "" })), true; }
    if (/human|agent|person|call me|talk to (someone|staff|manager)|manager|helpdesk/.test(t)) return bot(tr(lang, "human")), true;
    if (/complain|feedback|rude|bad service|problem|shikayat|ದೂರು|शिकायत/.test(t)) return bot(tr(lang, "fb"), [chip(lang === "kn" ? "ಹೌದು, ತಿಳಿಸಿ" : lang === "hi" ? "हाँ, सूचना दें" : "Yes, alert the manager", () => {
      Store.data.feedback.push({ branch: c.branch, rating: 1, comment: "Complaint raised through the Sahayak chat: " + text.slice(0, 200), service: svc ? A.svcName(svc) : "", senior: c.user.age !== "18-59", time: new Date().toTimeString().slice(0, 5), at: new Date().toISOString() });
      Store.save(); if (window.StaffApp) StaffApp.log("Customer complaint raised through the chat: manager alerted", "Sahayak (customer chat)", StaffApp.current().day, c.branch);
      bot(tr(lang, "alerted"));
    })]), true;
    if (/open|closed|close|holiday|timing|hours|band|chutti|raje|ರಜೆ|छुट्टी|बंद/.test(t)) {
      const list = D.meta.closures.slice(0, 5).map((x) => `${new Date(x.date + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })} (${x.reason})`).join(", ");
      return bot(tr(lang, "closed", { list: esc(list) })), true;
    }
    if (/token|book|appointment|slot|virtual|from home/.test(t)) {
      if (!svc) return bot(tr(lang, "svcQ"), svcChips()), true;
      const pool = D.meta.services[svc].pool, ws = A.waits(day, b, pool), bi = A.bestHour(ws);
      if (svc === "LOAN") { A.setService(svc); return bot((lang === "en" ? "Loans need an appointment. I've opened the loans section on the page; pick a quiet slot there." : lang === "kn" ? "ಸಾಲಕ್ಕೆ ಅಪಾಯಿಂಟ್‌ಮೆಂಟ್ ಬೇಕು. ಪುಟದಲ್ಲಿ ಕಡಿಮೆ ಜನರಿರುವ ಸಮಯ ಆಯ್ಕೆಮಾಡಿ." : "ऋण के लिए अपॉइंटमेंट चाहिए। पेज पर कम भीड़ वाला समय चुनें।")), true; }
      return bot(tr(lang, "bookQ", { svc: esc(A.svcName(svc, lang)), best: hh(HOURS[bi]) }), bookChips(svc, bi, lang)), true;
    }
    if (/document|bring|papers|proof|dakhale|dastavez|kagaz|ದಾಖಲೆ|दस्तावेज़|क्या लाना/.test(t)) {
      if (!svc) return bot(tr(lang, "svcQ"), svcChips()), true;
      return bot(tr(lang, "bring", { docs: esc(A.DOCS[svc].join(", ")) })), true;
    }
    if (/nearby|other branch|another branch|less (crowd|busy)|\bnear\b|bere shakhe|dusri shakha/.test(t)) {
      const pool = svc ? D.meta.services[svc].pool : "CASH";
      const hIdx = c.hour != null ? c.hour : 1;
      const rows = [b, ...A.neighbours(b).map((n) => n.id)].map((id) => `${esc(BR[id].name)} ~${A.mins(A.waits(day, id, pool)[hIdx])} min`).join(", ");
      return bot(tr(lang, "near", { hour: hh(HOURS[hIdx]), counter: esc(A.t(pool, null, lang)), list: rows })), true;
    }
    if (svc) { A.setService(svc); const o = serviceOverview(svc, lang, day, b); return bot(o.html, bookChips(svc, o.best, lang)), true; }
    if (/wait|crowd|rush|busy|queue|line|bheed|how long|kitna|eshtu|jana|best time|when|quiet|yavaga|\bkab\b|ಯಾವಾಗ|ಎಷ್ಟು|कितना|कब|भीड़|ಜನ/.test(t)) {
      let worst = { w: -1 }, bestIdx = 0;
      const agg = HOURS.map(() => 0);
      ["CASH", "GENERAL", "EXPERT"].forEach((p) => { const ws = A.waits(day, b, p); ws.forEach((w, i) => { agg[i] = Math.max(agg[i], w / SLA[p]); if (w / SLA[p] > worst.w / (SLA[worst.p] || 1)) worst = { w, p, i }; }); });
      agg.forEach((v, i) => { if (v < agg[bestIdx]) bestIdx = i; });
      return bot(tr(lang, "day", { day: esc(D.meta.day_labels[day]), branch: esc(BR[b].name), counter: esc(A.t(worst.p, null, lang)), pw: A.mins(worst.w), peak: hh(HOURS[worst.i]), best: `${hh(HOURS[bestIdx])}–${hh(HOURS[bestIdx] + 1)}` }) + "<br><br>" + tr(lang, "svcQ"), svcChips()), true;
    }
    if (/help|what can you|madad|sahaya|ಸಹಾಯ|मदद/.test(t)) return bot(tr(lang, "hi", { name: "" }), svcChips()), true;
    return false;
  }
  function bookChips(svc, bi, lang) {
    const A = cApi();
    if (svc === "LOAN") return [];
    return [chip((lang === "kn" ? "ಟೋಕನ್ ಬುಕ್ ಮಾಡಿ " : lang === "hi" ? "टोकन बुक करें " : "Book token for ") + hh(HOURS[bi]), () => {
      const tk = A.book(svc, bi);
      bot(tr(lang, "booked", { tok: esc(tk.token), day: esc(D.meta.day_labels[tk.day]), arr: tk.arrive, call: tk.call }));
    })];
  }

  // ------------------------------------------------------------ staff brain
  function staffTurn(text) {
    const t = text.toLowerCase();
    const cur = StaffApp.current();
    const day = findDay(t) || cur.day, b = findBranch(t) || cur.branch;
    const S = StaffApp.summary(day, b), X = S.X, E = X.explain;
    const nm = BR[b].name, dl = D.meta.day_labels[day];
    const role = (cur.user || {}).role;
    const nav = [chip("Open the plan", () => StaffApp.go("plan", b, day)), chip("What-if simulator", () => StaffApp.go("whatif", b, day))];
    if (/^(hi|hello|hey|namaskara|namaste)\b/.test(t) || /\bhelp\b|what can you/.test(t))
      return bot(`Hello ${esc((cur.user || {}).name || "")}. I can explain the forecast, list alerts, summarise the plan, run a what-if ("what if demand is 20% higher?", "what if Ravi is on leave?"), compare branches, and approve low-risk actions for you.`,
        [chip("Why is tomorrow busy?", () => staffTurn("why busy")), chip("Show alerts", () => staffTurn("alerts")), chip("What should I do?", () => staffTurn("recommend"))]), true;
    if (/approve/.test(t)) {
      if (role === "counter") return bot("Only the branch manager or regional office can approve actions. I can show you the plan instead.", nav), true;
      const all = /all|everything|full/.test(t) && !/low|safe/.test(t);
      const n = all ? X.steps.filter((_, i) => !S.approved.includes(i)).length : X.steps.filter((s2, i) => s2.autopilot && !S.approved.includes(i) && !S.dismissed.includes(i)).length + X.experience.filter((x) => x.autopilot).length;
      return bot(`${all ? "Approve all" : "Approve the low-risk"} actions for ${esc(nm)} on ${esc(dl)}? That is ${n} ${n === 1 ? "item" : "items"}${all ? ", including staff moves" : " (token-machine prompts, appointment offers, checklists)"}.`,
        [chip("Yes, approve", () => { const k = all ? StaffApp.approveAll(day, b) : StaffApp.approveLowRisk(day, b); const s2 = StaffApp.summary(day, b); bot(`Approved ${k}. Average wait is now ${fmt(s2.now.avg_wait, 1)} min (was ${fmt(s2.was.avg_wait, 1)}), about ${Math.round(s2.now.walkouts)} walkouts expected (was ${Math.round(s2.was.walkouts)}).`); }), chip("Not now", () => bot("Okay, nothing approved."))]), true;
    }
    if (/what if|what-if|if .*(absent|leave|off|sick)|demand|busier|quieter|\d+\s*%/.test(t)) {
      const pm = t.match(/([+-]?\d+)\s*%/);
      let pct = pm ? +pm[1] : 0;
      if (pm && /(less|lower|quieter|fewer|down|drop)/.test(t) && pct > 0) pct = -pct;
      const absent = Object.entries(D.staff_dir).filter(([id, s2]) => s2.branch === b && t.includes(s2.name.split(" ")[0].toLowerCase())).map(([id]) => id);
      if (!pm && !absent.length) return bot(`Tell me what to change, for example "what if demand is 20% higher" or "what if ${esc(D.staff_dir[Object.keys(X.home_plan).find((k) => !k.startsWith("MGR"))].name.split(" ")[0])} is on leave".`), true;
      const noPlan = StaffApp.whatIf(day, b, { demandPct: pct, absent, withPlan: false })._branch;
      const withPlan = StaffApp.whatIf(day, b, { demandPct: pct, absent, withPlan: true })._branch;
      const desc = [pct ? `demand ${pct > 0 ? "+" : ""}${pct}%` : "", absent.length ? absent.map((id) => D.staff_dir[id].name).join(", ") + " away" : ""].filter(Boolean).join(" and ");
      return bot(`What-if for ${esc(nm)}, ${esc(dl)} (${esc(desc)}):<br>• Doing nothing: average wait ${fmt(noPlan.avg_wait, 1)} min, worst hour ${fmt(noPlan.peak_wait, 0)} min, about ${Math.round(noPlan.walkouts)} walkouts.<br>• With self-service guidance and re-planned counters: ${fmt(withPlan.avg_wait, 1)} min, worst hour ${fmt(withPlan.peak_wait, 0)} min, about ${Math.round(withPlan.walkouts)} walkouts.<br><br>Today's plan as forecast: ${fmt(S.was.avg_wait, 1)} min doing nothing.`, [chip("Open what-if simulator", () => StaffApp.go("whatif", b, day))]), true;
    }
    if (/why|reason|explain|driver|kyun|yake/.test(t) || (/busy/.test(t) && !/which/.test(t))) {
      const pct = Math.round((E.total / E.normal - 1) * 100);
      const drv = E.drivers.filter((d2) => Math.abs(d2.value) >= 2).map((d2) => `• ${esc(d2.label)}: ${d2.value > 0 ? "+" : "−"}${Math.round(Math.abs(d2.value))}`).join("<br>");
      return bot(`${esc(nm)} expects <b>${Math.round(E.total)}</b> customers on ${esc(dl)}, ${pct >= 0 ? "+" : "−"}${Math.abs(pct)}% vs a normal day (${Math.round(E.normal)}). Why:<br>${drv || "• No special calendar events."}<br><br>Likely range ${E.low}–${E.high}.`, [chip("Show alerts", () => staffTurn(`alerts ${nm}`)), chip("What should I do?", () => staffTurn(`recommend ${nm}`))]), true;
    }
    if (/alert|bottleneck|worst|problem|which counter|queue/.test(t)) {
      if (!X.alerts.length) return bot(`No counter at ${esc(nm)} is expected to go over its wait target on ${esc(dl)}.`), true;
      return bot(`${X.alerts.length} ${X.alerts.length === 1 ? "alert" : "alerts"} at ${esc(nm)} on ${esc(dl)}:<br>${X.alerts.map((a) => `• <b>${esc(a.title)}</b> (${a.severity}). ${esc(a.causes[0])}`).join("<br>")}`, [chip("What should I do?", () => staffTurn(`recommend ${nm}`))]), true;
    }
    if (/recommend|suggest|what should|\bplan\b|action|to do|fix/.test(t)) {
      if (!X.steps.length) return bot(`No queue actions are needed at ${esc(nm)} on ${esc(dl)}.`), true;
      const lines = X.steps.map((s2, i) => `${i + 1}. ${esc(s2.title)} (${fmt(s2.impact.avg_wait_before, 1)} → ${fmt(s2.impact.avg_wait_after, 1)} min)${S.approved.includes(i) ? " ✓" : ""}`).join("<br>");
      const ch = role === "counter" ? nav : [chip("Approve low-risk ones", () => staffTurn(`approve low risk ${nm}`)), chip("Approve all", () => staffTurn(`approve all ${nm}`)), nav[0]];
      return bot(`Recommended plan for ${esc(nm)}, ${esc(dl)}:<br>${lines}<br><br>Full plan: average wait ${fmt(X.kpi_before.avg_wait, 1)} → ${fmt(X.kpi_after.avg_wait, 1)} min, walkouts ${Math.round(X.kpi_before.walkouts)} → ${Math.round(X.kpi_after.walkouts)}.`, ch), true;
    }
    if (/walk ?out|average|kpi|how (many|long)|wait/.test(t)) {
      return bot(`${esc(nm)}, ${esc(dl)}, with the actions approved so far: average wait <b>${fmt(S.now.avg_wait, 1)} min</b> (doing nothing: ${fmt(S.was.avg_wait, 1)}), worst hour ${fmt(S.now.peak_wait, 0)} min, about ${Math.round(S.now.walkouts)} walkouts (doing nothing: ${Math.round(S.was.walkouts)}).`), true;
    }
    if (/leave|absent|who is|on duty|roster|staff|lent|borrow/.test(t) && !/network|compare/.test(t)) {
      const away = X.absent.map((a) => `${esc(a.name)} (${esc(a.reason || a.status)})`).join(", ") || "nobody";
      const lent = (D.network[day] || []).filter((m) => m.to_branch === b || m.from_branch === b).map((m) => `${esc(m.name)}: ${esc(BR[m.from_branch].name)} → ${esc(BR[m.to_branch].name)} (${m.blocks.length === 2 ? "all day" : "morning"})`).join("; ");
      return bot(`${esc(nm)} on ${esc(dl)}: ${Object.keys(X.home_plan).filter((k) => !k.startsWith("MGR")).length} staff on duty; away: ${away}.${lent ? "<br>Suggested lending: " + lent + "." : ""}`), true;
    }
    if (/network|compare|all branches|other branches|region/.test(t)) {
      const rows = D.branches.map((br) => { const s2 = StaffApp.summary(day, br.id); const a = D.days[day][br.id].alerts; return `• ${esc(br.name)}: ${Math.round(D.days[day][br.id].explain.total)} customers, ${a.length} ${a.length === 1 ? "alert" : "alerts"}, avg wait ${fmt(s2.now.avg_wait, 1)} min`; }).join("<br>");
      return bot(`Network on ${esc(dl)}:<br>${rows}`, [chip("Open network view", () => StaffApp.go("network", null, day))]), true;
    }
    if (/feedback|complain|rating|customers (say|saying)|theme/.test(t)) {
      const F = D.feedback.branches[b];
      const top = Object.entries(F.themes).slice(0, 3).map(([k, n]) => `${esc(D.feedback.theme_labels[k] || k)} (${n})`).join(", ");
      const app = Store.data.feedback.filter((f) => f.branch === b && f.rating <= 2).length;
      return bot(`${esc(nm)} feedback in September: average ${fmt(F.avg_rating, 2)} of 5, ${fmt(F.negative_share * 100, 1)}% negative. Top complaints: ${top}.${app ? `<br>${app} low ${app === 1 ? "rating" : "ratings"} from the customer app today.` : ""}`, [chip("Open customer voice", () => StaffApp.go("voice", b, day))]), true;
    }
    if (/accura|model|error|backtest|proof|validat|test/.test(t)) {
      const M = D.model.metrics, BT = D.backtest.summary;
      return bot(`Forecast error on held-out September: ${fmt(M.daily_wape.model * 100, 1)}% per branch-day (vs ${fmt(M.daily_wape.seasonal_naive * 100, 1)}% for "same day last week"). Replaying the same customers with the plan: walkouts ${fmt(BT.walkouts.before)} → ${fmt(BT.walkouts.full_plan)}, waits over target ${fmt(BT.sla_breach_share.before * 100, 1)}% → ${fmt(BT.sla_breach_share.full_plan * 100, 1)}%.`, [chip("Open model & data", () => StaffApp.go("model"))]), true;
    }
    return false;
  }

  // ------------------------------------------------------------ AI fallback
  function aiContext() {
    if (st.mode === "customer") {
      const A = cApi(), c = A.ctx();
      const services = {};
      A.SVCS.forEach((s) => {
        const pool = D.meta.services[s.id].pool, r = D.meta.redirect[s.id];
        services[s.id] = { name: s.en, counter: PL[pool], can_skip_visit: r.share > 0 ? r.short + (r.needs_digital ? " (needs mobile/internet banking)" : "") : "no", documents: A.DOCS[s.id],
          expected_wait_minutes_by_hour_10_to_15: Object.fromEntries([c.branch, ...A.neighbours(c.branch).map((n) => n.id)].map((b) => [BR[b].name, A.waits(c.day, b, pool).map((w) => Math.round(w))])) };
      });
      return { app: "BranchEase customer app for Demo Bank (fictional)", today: D.meta.today, selected_day: D.meta.day_labels[c.day], customer: { first_name: c.user.name.split(" ")[0], home_branch: BR[c.branch].name, uses_mobile_banking: c.user.digital, priority_lane: A.priority() },
        branch_hours: D.meta.hours, upcoming_closures: D.meta.closures.slice(0, 6), services };
    }
    const cur = StaffApp.current(), S = StaffApp.summary(cur.day, cur.branch), X = S.X;
    return { app: "BranchEase staff dashboard (fictional bank)", user_role: (cur.user || {}).role, day: D.meta.day_labels[cur.day], branch: BR[cur.branch].name,
      forecast: { total: Math.round(X.explain.total), normal_day: Math.round(X.explain.normal), drivers: X.explain.drivers.map((d2) => `${d2.label}: ${Math.round(d2.value)}`) },
      alerts: X.alerts.map((a) => ({ title: a.title, causes: a.causes })), plan: X.steps.map((s2, i) => ({ step: s2.title, avg_wait: `${s2.impact.avg_wait_before} -> ${s2.impact.avg_wait_after}`, approved: S.approved.includes(i), owner: s2.owner })),
      now: { avg_wait: +S.now.avg_wait.toFixed(1), walkouts: Math.round(S.now.walkouts) }, doing_nothing: { avg_wait: +S.was.avg_wait.toFixed(1), walkouts: Math.round(S.was.walkouts) },
      staff_away: X.absent.map((a) => `${a.name} (${a.reason || a.status})`),
      network: D.branches.map((br) => ({ branch: br.name, customers: Math.round(D.days[cur.day][br.id].explain.total), alerts: D.days[cur.day][br.id].alerts.length })),
      feedback_top_complaints: Object.keys(D.feedback.branches[cur.branch].themes).slice(0, 4).map((k) => D.feedback.theme_labels[k]) };
  }
  async function askAI(text) {
    const lang = st.mode === "customer" ? detectLang(text, cApi().ctx().lang) : "en";
    const langName = { en: "English", kn: "Kannada (ಕನ್ನಡ script)", hi: "Hindi (Devanagari script)" }[lang];
    const rules = `You are Sahayak, the assistant inside BranchEase, a hackathon demo for a fictional bank. Answer using ONLY the JSON data below; if it does not cover the question, say so briefly and suggest what the user can do in the app. Be warm, practical and short (under 90 words, plain text, no markdown). Reply in ${langName}. Never ask for account numbers, OTPs, PINs or passwords.\n\nDATA:\n${JSON.stringify(aiContext())}`;
    st.turns.push({ role: "user", content: text });
    const turns = [{ role: "user", content: rules }, ...st.turns.slice(-8)];
    st.busy = true; st.ctl = new AbortController(); render();
    const idx = st.msgs.length;
    try {
      await st.ai(turns, { modelTier: "quick", cache: false, signal: st.ctl.signal, onText: ({ text: tx }) => { st.busy = false; st.msgs[idx] = { from: "bot", html: esc(tx) }; render(); } });
      st.turns.push({ role: "assistant", content: st.msgs[idx] ? st.msgs[idx].html : "" });
    } catch (e) {
      st.busy = false;
      if (e && e.code === "cancelled") { if (!st.msgs[idx]) bot("Stopped."); }
      else if (e && ["not_granted", "sampling_disabled", "not_declared", "capability_disabled", "capability_removed"].includes(e.code)) { st.ai = null; fallback(text); }
      else if (e && e.code === "rate_limited") bot("I'm getting a lot of questions right now. Please try again in a minute.");
      else fallback(text);
    } finally { st.busy = false; render(); }
  }
  function fallback(text) {
    if (st.mode === "customer") { const lang = detectLang(text, cApi().ctx().lang); bot(tr(lang, "miss"), cApi().SVCS.slice(0, 3).map((s) => chip(s[lang] || s.en, () => customerTurn(s.en)))); }
    else bot(`I can help with: why a day is busy, alerts, the recommended plan, what-ifs, staff on leave, the network, feedback and model accuracy. Try "what if demand is 20% higher?"`, [chip("Why is tomorrow busy?", () => staffTurn("why busy")), chip("Show alerts", () => staffTurn("alerts"))]);
  }
  function handle(text) {
    const done = st.mode === "customer" ? customerTurn(text) : staffTurn(text);
    if (done) return;
    if (st.ai) askAI(text); else fallback(text);
  }

  // ------------------------------------------------------------ lifecycle
  function mount({ mode, user }) {
    st.mode = mode; st.user = user; st.msgs = []; st.turns = []; st.acts = {}; st.open = false; st.busy = false;
    if (mode === "customer") {
      const lang = user.lang || "en";
      const A = cApi();
      st.msgs.push({ from: "bot", html: tr(lang, "hi", { name: ", " + esc(user.name.split(" ")[0]) }), chips: A.SVCS.slice(0, 4).map((s) => chip(s[lang] || s.en, () => customerTurn(s.en))) });
    } else {
      st.msgs.push({ from: "bot", html: `Hello ${esc(user.name)}. Ask me about ${esc(D.meta.day_labels[D.meta.plan_days[0]])}: why it's busy, where queues will build, what to do, or a what-if.`,
        chips: [chip("Why is tomorrow busy?", () => staffTurn("why busy")), chip("Show alerts", () => staffTurn("alerts")), chip("What should I do?", () => staffTurn("recommend"))] });
    }
    render();
    try {
      if (window.claude && typeof window.claude.use === "function") window.claude.use("sample").then((s) => { if (s && st.mode) { st.ai = s; render(); } }).catch(() => {});
    } catch (e) { /* no viewer runtime */ }
  }
  function unmount() { st.mode = null; st.open = false; if (st.ctl) try { st.ctl.abort(); } catch (e) { /* ignore */ } render(); }
  function open() { st.open = true; render(); focusIn(); }
  function refresh() { render(); }
  return { mount, unmount, open, refresh };
})();
