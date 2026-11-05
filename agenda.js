/* Agenda et rappels : tout reste sur l'appareil (localStorage), rien n'est envoyé nulle part. */
(function () {
  "use strict";
  var KEY = "pdj.agenda", SEEN = "pdj.agenda.seen", SNZ = "pdj.agenda.snooze";
  var LEADS = [[0, "À l'heure de l'événement"], [5, "5 minutes avant"], [10, "10 minutes avant"], [15, "15 minutes avant"],
    [30, "30 minutes avant"], [60, "1 heure avant"], [120, "2 heures avant"], [1440, "La veille, à la même heure"]];
  var REPS = [["", "Une seule fois"], ["d", "Tous les jours"], ["w", "Toutes les semaines"], ["m", "Tous les mois"], ["y", "Tous les ans"]];
  var FREQ = { d: "DAILY", w: "WEEKLY", m: "MONTHLY", y: "YEARLY" };
  var PERIOD = { d: 864e5, w: 7 * 864e5, m: 31 * 864e5, y: 366 * 864e5 };
  var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  /* ---------- utilitaires ---------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function parseYmd(s) { var a = s.split("-"); return new Date(+a[0], +a[1] - 1, +a[2]); }
  function hm(d) { return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  function read(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function uid() { return "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function dayLabel(d) {
    var n = new Date(), t0 = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    var d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()), diff = Math.round((d0 - t0) / 864e5);
    if (diff === 0) return "Aujourd'hui";
    if (diff === 1) return "Demain";
    return d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
  }

  /* ---------- données ---------- */
  var events = read(KEY, []);
  if (!Array.isArray(events)) events = [];
  events = events.filter(function (e) {
    return e && typeof e.id === "string" && typeof e.t === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.d || "") && /^\d{2}:\d{2}$/.test(e.h || "");
  });
  var snoozes = read(SNZ, []);
  if (!Array.isArray(snoozes)) snoozes = [];
  function saveEvents() { return write(KEY, events); }
  function byId(id) { for (var i = 0; i < events.length; i++) { if (events[i].id === id) return events[i]; } return null; }

  /* ---------- calcul des occurrences (répétitions comprises) ---------- */
  function occ(ev, n) {
    var p = ev.d.split("-"), h = ev.h.split(":");
    var y = +p[0], mo = +p[1] - 1, dd = +p[2], hh = +h[0], mm = +h[1];
    if (ev.r === "d") dd += n;
    else if (ev.r === "w") dd += 7 * n;
    else if (ev.r === "m" || ev.r === "y") {
      mo += ev.r === "m" ? n : 12 * n;
      var ty = y + Math.floor(mo / 12), tm = ((mo % 12) + 12) % 12;
      return new Date(ty, tm, Math.min(dd, new Date(ty, tm + 1, 0).getDate()), hh, mm);
    }
    return new Date(y, mo, dd, hh, mm);
  }
  /* première occurrence strictement après t (ms) */
  function firstAfter(ev, t) {
    if (!ev.r) { var o = occ(ev, 0); return o.getTime() > t ? { n: 0, at: o } : null; }
    var start = occ(ev, 0).getTime(), n = Math.max(0, Math.floor((t - start) / PERIOD[ev.r]) - 1);
    for (var i = 0; i < 400; i++, n++) {
      var o2 = occ(ev, n);
      if (o2.getTime() > t) return { n: n, at: o2 };
    }
    return null;
  }
  function eventsOn(ds) {
    var d = parseYmd(ds), t0 = d.getTime(), t1 = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(), res = [];
    events.forEach(function (ev) {
      var f = firstAfter(ev, t0 - 1);
      if (f && f.at.getTime() < t1) res.push({ ev: ev, at: f.at });
    });
    return res.sort(function (a, b) { return a.at - b.at; });
  }
  function upcoming(max) {
    var n = new Date(), t0 = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime(), lim = t0 + 60 * 864e5, res = [];
    events.forEach(function (ev) {
      var f = firstAfter(ev, t0 - 1), c = 0;
      while (f && f.at.getTime() < lim && c < 3) { res.push({ ev: ev, at: f.at }); f = ev.r ? firstAfter(ev, f.at.getTime()) : null; c++; }
    });
    return res.sort(function (a, b) { return a.at - b.at; }).slice(0, max);
  }
  /* alarmes dont l'heure se situe dans l'intervalle ]since, now] */
  function due(since, now) {
    var out = [], keep = [];
    events.forEach(function (ev) {
      var lead = (ev.l || 0) * 60000, f = firstAfter(ev, since + lead), c = 0;
      while (f && f.at.getTime() - lead <= now && c < 5) {
        out.push({ t: ev.t, at: f.at, missed: now - (f.at.getTime() - lead) > 120000 });
        f = ev.r ? firstAfter(ev, f.at.getTime()) : null; c++;
      }
    });
    snoozes.forEach(function (s) {
      if (s.at <= now) out.push({ t: s.t, at: new Date(s.start), missed: false }); else keep.push(s);
    });
    if (keep.length !== snoozes.length) { snoozes = keep; write(SNZ, snoozes); }
    return out.sort(function (a, b) { return a.at - b.at; });
  }

  /* ---------- export vers le calendrier du téléphone / de l'ordinateur (.ics) ---------- */
  function icsEsc(s) { return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n"); }
  function fold(line) {
    var out = [], s = line;
    while (s.length > 35) {
      var cut = 35, c = s.charCodeAt(cut - 1);
      if (c >= 0xd800 && c <= 0xdbff) cut--;
      out.push(s.slice(0, cut)); s = " " + s.slice(cut);
    }
    out.push(s);
    return out.join("\r\n");
  }
  function icsDate(d) { return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "T" + pad(d.getHours()) + pad(d.getMinutes()) + "00"; }
  function trig(l) {
    if (!l) return "PT0S";
    if (l % 1440 === 0) return "-P" + l / 1440 + "D";
    if (l % 60 === 0) return "-PT" + l / 60 + "H";
    return "-PT" + l + "M";
  }
  function buildIcs(list) {
    var stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    var L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Point du jour//FR", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
    list.forEach(function (ev) {
      var s = occ(ev, 0), e = new Date(s.getTime() + 30 * 60000);
      L.push("BEGIN:VEVENT", "UID:" + ev.id + "@point-du-jour", "DTSTAMP:" + stamp, "DTSTART:" + icsDate(s), "DTEND:" + icsDate(e), "SUMMARY:" + icsEsc(ev.t));
      if (ev.n) L.push("DESCRIPTION:" + icsEsc(ev.n));
      if (ev.r) L.push("RRULE:FREQ=" + FREQ[ev.r]);
      L.push("BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + icsEsc(ev.t), "TRIGGER:" + trig(ev.l || 0), "END:VALARM", "END:VEVENT");
    });
    L.push("END:VCALENDAR");
    return L.map(fold).join("\r\n") + "\r\n";
  }
  function sendIcs(name, text) {
    var blob = new Blob([text], { type: "text/calendar;charset=utf-8" }), file = null;
    try { file = new File([blob], name, { type: "text/calendar" }); } catch (e) {}
    var standalone = window.navigator.standalone === true || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
    if (standalone && file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: "Rappel" }).catch(function () {});
      return;
    }
    var url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 4000);
  }

  /* ---------- sonnerie, vibration, notification ---------- */
  var actx = null, ringT = null, ringStopT = null;
  function audio() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      if (!actx) actx = new AC();
      if (actx.state === "suspended") actx.resume();
    } catch (e) { return null; }
    return actx;
  }
  function beeps() {
    var c = audio();
    if (!c) return;
    for (var i = 0; i < 3; i++) {
      var t0 = c.currentTime + i * 0.28, o = c.createOscillator(), g = c.createGain();
      o.type = "sine"; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.5, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
      o.connect(g); g.connect(c.destination); o.start(t0); o.stop(t0 + 0.22);
    }
  }
  function stopSound() { clearInterval(ringT); clearTimeout(ringStopT); ringT = ringStopT = null; }
  function startSound() { stopSound(); beeps(); ringT = setInterval(beeps, 1800); ringStopT = setTimeout(stopSound, 90000); }
  document.addEventListener("pointerdown", function () { audio(); }, true);
  function notify(it) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    var title = "⏰ " + it.t, opts = { body: it.missed ? "Rappel manqué de " + hm(it.at) : "À " + hm(it.at), tag: "pdj-" + it.t + it.at.getTime(), requireInteraction: true };
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then(function (r) { return r.showNotification(title, opts); })
          .catch(function () { try { new Notification(title, opts); } catch (e) {} });
      } else { new Notification(title, opts); }
    } catch (e) {}
  }

  /* ---------- interface ---------- */
  var css = document.createElement("style");
  css.textContent =
    ".ag-row{display:flex;gap:10px;align-items:center;width:100%;text-align:left;border:0;background:var(--chip);color:var(--ink);font:inherit;padding:10px;border-radius:10px;margin-top:6px;cursor:pointer}" +
    ".ag-row.past{opacity:.55}.ag-row .ag-t{flex:none;font-weight:600;font-size:13.5px;min-width:96px}.ag-row .ag-n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}" +
    ".ag-act{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}" +
    ".ag-nav{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.ag-nav b{font-size:16px;text-transform:capitalize}" +
    ".ag-nav .chip{padding:7px 16px;font-size:16px}" +
    ".ag-cal{display:grid;grid-template-columns:repeat(7,1fr);gap:4px;text-align:center;margin-bottom:6px}.ag-cal .wd{font-size:11.5px;color:var(--mut)}" +
    ".ag-cal button{position:relative;border:0;background:var(--chip);color:var(--ink);border-radius:10px;height:40px;font:inherit;font-size:14px;cursor:pointer}" +
    ".ag-cal button.out{opacity:.4}.ag-cal button.today{outline:2px solid var(--acc)}.ag-cal button.sel{background:var(--acc);color:#fff}" +
    ".ag-cal button i{position:absolute;bottom:4px;left:50%;width:5px;height:5px;margin-left:-2.5px;border-radius:50%;background:var(--acc)}.ag-cal button.sel i{background:#fff}" +
    ".ag-al{padding:10px 0;border-top:1px solid var(--line)}.ag-al:first-child{border-top:0}.ag-al b{font-size:19px}" +
    ".ag-bell{font-size:46px;text-align:center;animation:agr .5s ease-in-out infinite alternate}@keyframes agr{from{transform:rotate(-14deg)}to{transform:rotate(14deg)}}" +
    ".ag-pri{background:var(--acc)!important;color:#fff!important}.ag-err{color:var(--down);font-size:13px;min-height:18px;margin:8px 0 0}";
  document.head.appendChild(css);

  var card = document.createElement("section");
  card.className = "card"; card.id = "s-agenda";
  card.innerHTML = '<h2>Agenda <small></small></h2><div class="body"></div>';
  var hl = $("#s-highlights");
  if (hl && hl.parentNode) hl.parentNode.insertBefore(card, hl.nextSibling);
  else (document.querySelector(".wrap") || document.body).appendChild(card);

  var modal = document.createElement("div");
  modal.className = "modal"; modal.id = "ag-modal"; modal.hidden = true;
  modal.innerHTML = '<div class="sheet set" id="ag-sheet"></div>';
  document.body.appendChild(modal);
  var alarm = document.createElement("div");
  alarm.className = "modal"; alarm.id = "ag-alarm"; alarm.hidden = true; alarm.style.zIndex = "20";
  alarm.innerHTML = '<div class="sheet" id="ag-alsheet"></div>';
  document.body.appendChild(alarm);

  var st = { mode: "month", month: new Date(), sel: ymd(new Date()), editing: null };
  st.month = new Date(st.month.getFullYear(), st.month.getMonth(), 1);

  function notifBtn() {
    if (!("Notification" in window) || Notification.permission !== "default") return "";
    return '<button type="button" class="chip" data-ag="notif">🔔 Activer les notifications</button>';
  }
  function renderCard() {
    var ups = upcoming(5), html = "";
    if (!ups.length) html += '<p class="muted">Aucun rappel pour le moment. Créez-en un : une sonnerie vous préviendra.</p>';
    else html += ups.map(function (u) {
      return '<button type="button" class="ag-row' + (u.at.getTime() < Date.now() ? " past" : "") + '" data-edit="' + esc(u.ev.id) + '"><span class="ag-t">' +
        esc(dayLabel(u.at)) + " · " + hm(u.at) + '</span><span class="ag-n">' + esc(u.ev.t) + "</span>" + (u.ev.r ? '<span class="muted">↻</span>' : "") + "</button>";
    }).join("");
    html += '<div class="ag-act"><button type="button" class="chip on" data-ag="new">＋ Rappel</button><button type="button" class="chip" data-ag="cal">📅 Calendrier</button>' + notifBtn() + "</div>";
    $(".body", card).innerHTML = html;
    var s = $("h2 small", card);
    if (s) s.textContent = events.length ? events.length + (events.length > 1 ? " rappels" : " rappel") : "";
  }

  function selectHtml(id, list, val) {
    return '<select id="' + id + '">' + list.map(function (x) { return '<option value="' + esc(x[0]) + '"' + (String(x[0]) === String(val) ? " selected" : "") + ">" + esc(x[1]) + "</option>"; }).join("") + "</select>";
  }
  function renderSheet() {
    var s = $("#ag-sheet");
    if (st.mode === "form") { renderForm(s); return; }
    var m = st.month, y = m.getFullYear(), mo = m.getMonth(), today = ymd(new Date()), first = new Date(y, mo, 1), off = (first.getDay() + 6) % 7, h = "";
    h += '<h2>Agenda</h2><div class="ag-nav"><button type="button" class="chip" data-ag="prev" aria-label="Mois précédent">‹</button><b>' +
      esc(first.toLocaleDateString("fr-FR", { month: "long", year: "numeric" })) + '</b><button type="button" class="chip" data-ag="next" aria-label="Mois suivant">›</button></div>';
    h += '<div class="ag-cal">' + ["L", "M", "M", "J", "V", "S", "D"].map(function (w) { return '<span class="wd">' + w + "</span>"; }).join("");
    for (var i = 0; i < 42; i++) {
      var d = new Date(y, mo, 1 - off + i), ds = ymd(d), has = eventsOn(ds).length > 0;
      h += '<button type="button" data-day="' + ds + '" class="' + (d.getMonth() !== mo ? "out " : "") + (ds === today ? "today " : "") + (ds === st.sel ? "sel" : "") + '">' + d.getDate() + (has ? "<i></i>" : "") + "</button>";
    }
    h += "</div>";
    var day = eventsOn(st.sel), sd = parseYmd(st.sel);
    h += "<h3>" + esc(sd.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })) + "</h3>";
    h += day.length ? day.map(function (u) {
      return '<button type="button" class="ag-row" data-edit="' + esc(u.ev.id) + '"><span class="ag-t">' + hm(u.at) + '</span><span class="ag-n">' + esc(u.ev.t) + "</span>" + (u.ev.r ? '<span class="muted">↻</span>' : "") + "</button>";
    }).join("") : '<p class="muted small">Aucun rappel ce jour-là.</p>';
    h += '<button type="button" class="more ag-pri" data-ag="new">＋ Ajouter un rappel ce jour-là</button>';
    h += '<p class="small muted" style="margin-top:12px">⚠️ L\'application ne peut sonner que lorsqu\'elle est ouverte. Pour être prévenu même téléphone verrouillé ou appli fermée, ajoutez le rappel au calendrier du téléphone (bouton dans la fiche du rappel).</p>';
    h += '<button type="button" class="more" data-ag="export">📲 Tout ajouter au calendrier (.ics)</button>';
    h += '<button type="button" class="more" data-ag="test">🔊 Tester la sonnerie</button>';
    h += '<button type="button" class="more" data-ag="close">Fermer</button>';
    s.innerHTML = h;
  }
  function nextHour() { var d = new Date(); d.setHours(d.getHours() + 1, 0, 0, 0); return hm(d); }
  function renderForm(s) {
    var ev = st.editing || { t: "", d: st.sel, h: nextHour(), l: 15, r: "", n: "" };
    s.innerHTML = "<h2>" + (st.editing ? "Modifier le rappel" : "Nouveau rappel") + "</h2>" +
      '<label for="ag-t">Titre</label><input id="ag-t" type="text" maxlength="80" placeholder="Ex. Rendez-vous médecin" autocomplete="off" value="' + esc(ev.t) + '">' +
      '<label for="ag-d">Date</label><input id="ag-d" type="date" value="' + esc(ev.d) + '">' +
      '<label for="ag-h">Heure</label><input id="ag-h" type="time" value="' + esc(ev.h) + '">' +
      '<label for="ag-l">Me prévenir</label>' + selectHtml("ag-l", LEADS, ev.l || 0) +
      '<label for="ag-r">Répétition</label>' + selectHtml("ag-r", REPS, ev.r || "") +
      '<label for="ag-n">Note (facultatif)</label><input id="ag-n" type="text" maxlength="200" value="' + esc(ev.n || "") + '">' +
      '<p class="ag-err" id="ag-err"></p>' +
      '<button type="button" class="more ag-pri" data-ag="save">Enregistrer</button>' +
      '<button type="button" class="more" data-ag="ics">📲 Enregistrer et ajouter au calendrier du téléphone (sonne même appli fermée)</button>' +
      (st.editing ? '<button type="button" class="more" data-ag="del">Supprimer</button>' : "") +
      '<button type="button" class="more" data-ag="cancel">Annuler</button>';
  }
  function readForm() {
    var ev = { id: st.editing ? st.editing.id : uid(), t: $("#ag-t").value.trim(), d: $("#ag-d").value, h: $("#ag-h").value,
      l: Number($("#ag-l").value) || 0, r: $("#ag-r").value, n: $("#ag-n").value.trim() }, err = "";
    if (!ev.t) err = "Donnez un titre au rappel.";
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(ev.d)) err = "Choisissez une date.";
    else if (!/^\d{2}:\d{2}$/.test(ev.h)) err = "Choisissez une heure.";
    if (err) { $("#ag-err").textContent = err; return null; }
    return ev;
  }
  function saveForm() {
    var ev = readForm();
    if (!ev) return null;
    var old = byId(ev.id);
    if (old) events[events.indexOf(old)] = ev; else events.push(ev);
    if (!saveEvents()) { $("#ag-err").textContent = "Impossible d'enregistrer (stockage du navigateur indisponible)."; return null; }
    st.mode = "month"; st.editing = null; st.sel = ev.d;
    var d = parseYmd(ev.d); st.month = new Date(d.getFullYear(), d.getMonth(), 1);
    renderCard(); renderSheet();
    return ev;
  }

  function openSheet() { modal.hidden = false; renderSheet(); }
  function closeSheet() { modal.hidden = true; st.mode = "month"; st.editing = null; renderCard(); }
  function openForm(ev, ds) {
    st.mode = "form"; st.editing = ev || null; if (ds) st.sel = ds;
    modal.hidden = false; renderSheet();
    if (!ev) setTimeout(function () { var t = $("#ag-t"); if (t) t.focus(); }, 60);
  }

  function act(b) {
    var a = b.getAttribute("data-ag"), day = b.getAttribute("data-day"), id = b.getAttribute("data-edit");
    if (day) { st.sel = day; renderSheet(); return; }
    if (id) { var ev = byId(id); if (ev) openForm(ev); return; }
    if (a === "new") { openForm(null, modal.hidden ? ymd(new Date()) : st.sel); }
    else if (a === "cal") { st.mode = "month"; openSheet(); }
    else if (a === "close") closeSheet();
    else if (a === "prev" || a === "next") { st.month = new Date(st.month.getFullYear(), st.month.getMonth() + (a === "next" ? 1 : -1), 1); renderSheet(); }
    else if (a === "cancel") { st.mode = "month"; st.editing = null; renderSheet(); }
    else if (a === "save") saveForm();
    else if (a === "ics") { var ev2 = saveForm(); if (ev2) sendIcs("rappel.ics", buildIcs([ev2])); }
    else if (a === "export") { if (events.length) sendIcs("agenda-point-du-jour.ics", buildIcs(events)); }
    else if (a === "test") ring([{ t: "Test de sonnerie", at: new Date(), missed: false }]);
    else if (a === "del") {
      if (b.getAttribute("data-sure") !== "1") { b.setAttribute("data-sure", "1"); b.textContent = "Confirmer la suppression"; return; }
      events = events.filter(function (e) { return !st.editing || e.id !== st.editing.id; });
      saveEvents(); st.mode = "month"; st.editing = null; renderCard(); renderSheet();
    } else if (a === "notif") {
      try {
        var p = Notification.requestPermission(function () { renderCard(); });
        if (p && p.then) p.then(function () { renderCard(); });
      } catch (e) {}
    }
  }
  function onClick(e) {
    var b = e.target.closest("[data-ag],[data-day],[data-edit]");
    if (b) act(b);
  }
  card.addEventListener("click", onClick);
  modal.addEventListener("click", function (e) { if (e.target === modal) closeSheet(); else onClick(e); });

  /* ---------- alarmes ---------- */
  var ringing = [];
  function renderAlarm() {
    var h = '<div class="ag-bell">🔔</div>' + ringing.map(function (it) {
      return '<div class="ag-al"><b>' + esc(it.t) + '</b><div class="small muted">' + (it.missed ? "Rappel manqué · " : "") + esc(dayLabel(it.at)) + " à " + hm(it.at) + "</div></div>";
    }).join("");
    h += '<button type="button" class="more ag-pri" id="ag-ok">OK</button><button type="button" class="more" id="ag-snz">Me le rappeler dans 10 min</button>';
    $("#ag-alsheet").innerHTML = h;
  }
  function ring(items) {
    ringing = ringing.concat(items);
    renderAlarm(); alarm.hidden = false; startSound();
    items.forEach(notify);
    try { if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]); } catch (e) {}
  }
  function stopRing() { stopSound(); alarm.hidden = true; ringing = []; }
  alarm.addEventListener("click", function (e) {
    if (e.target.id === "ag-ok") stopRing();
    else if (e.target.id === "ag-snz") {
      var at = Date.now() + 10 * 60000;
      ringing.forEach(function (it) { if (it.t !== "Test de sonnerie") snoozes.push({ t: it.t, start: it.at.getTime(), at: at }); });
      write(SNZ, snoozes); stopRing();
    }
  });

  var seen = Number(read(SEEN, 0)) || 0, now0 = Date.now();
  var since = seen && now0 - seen < 12 * 3600000 ? seen : now0 - (seen ? 12 * 3600000 : 0);
  function tick() {
    var now = Date.now(), list = due(since, now);
    since = now; write(SEEN, now);
    if (list.length) ring(list);
  }
  setInterval(tick, 15000);
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") { tick(); renderCard(); } });

  renderCard();
  setTimeout(tick, 800);
})();
