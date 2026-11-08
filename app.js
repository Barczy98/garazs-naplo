"use strict";
const APP_VERSION = "1.0.0";
const KEY = "garazs-naplo-v1";
const DAY = 864e5;

const DOC_TYPES = [
  ["rca", "RCA biztosítás", "kötelező felelősségbiztosítás"],
  ["casco", "CASCO", "casco biztosítás"],
  ["rov", "Rovinieta", "úthasználati díj"],
  ["itp", "ITP", "műszaki vizsga"],
  ["trusa", "Elsősegélycsomag", "trusă medicală, kötelező"],
  ["ext", "Tűzoltó készülék", "extinctor, kötelező"],
  ["tax", "Gépjárműadó", "impozit auto"],
];
const REMIND_OPTIONS = [60, 30, 14, 7, 3, 1];

/* ---------- segédfüggvények ---------- */
const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parseDate = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const fmtDate = s => s ? s.replaceAll("-", ".") + "." : "–";
const fmtKm = n => Number(n || 0).toLocaleString("hu-HU") + " km";
const fmtMoney = n => Number(n || 0).toLocaleString("hu-HU") + " lej";
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
const $ = s => document.querySelector(s);

/* ---------- adat ---------- */
function emptyState() { return { version: 1, sel: null, cars: [], settings: { remind: [30, 7, 1] } }; }
function normalize(s) {
  const base = emptyState();
  if (!s || !Array.isArray(s.cars)) return base;
  s.settings = Object.assign(base.settings, s.settings || {});
  s.cars.forEach(c => {
    c.docs = c.docs || {}; c.notes = c.notes || {}; c.log = c.log || []; c.custom = c.custom || [];
    c.oil = c.oil || { date: "", km: c.km || 0, everyKm: 15000, everyMonths: 12 };
  });
  if (!s.cars.some(c => c.id === s.sel)) s.sel = s.cars[0]?.id ?? null;
  return s;
}
let S;
try { S = normalize(JSON.parse(localStorage.getItem(KEY))); } catch (e) { S = emptyState(); }
let tab = "home";

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch (e) { toast("Nem sikerült menteni: a telefon tárhelye megtelt?"); }
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

const car = () => S.cars.find(c => c.id === S.sel);

/* ---------- állapotszámítás ---------- */
function dateStatus(date) {
  if (!date) return { s: "none", txt: "nincs megadva", d: 1e9 };
  const days = Math.round((parseDate(date) - today()) / DAY);
  if (days < 0) return { s: "bad", txt: `lejárt ${-days} napja`, d: days };
  if (days === 0) return { s: "bad", txt: "ma jár le", d: 0 };
  if (days <= 30) return { s: "warn", txt: `${days} nap múlva`, d: days };
  return { s: "ok", txt: `${days} nap múlva`, d: days };
}
function oilInfo(c) {
  const o = c.oil;
  if (!o.date) return { s: "none", txt: "nincs megadva", d: 1e9, sub: "add meg az utolsó olajcserét", date: "" };
  const dueKm = Number(o.km) + Number(o.everyKm);
  const leftKm = dueKm - Number(c.km);
  const dd = parseDate(o.date); dd.setMonth(dd.getMonth() + Number(o.everyMonths));
  const leftDays = Math.round((dd - today()) / DAY);
  let s = "ok";
  if (leftKm < 0 || leftDays < 0) s = "bad"; else if (leftKm < 1500 || leftDays <= 30) s = "warn";
  let txt;
  if (leftKm < 0) txt = `${fmtKm(-leftKm)}-rel túllépve`;
  else if (leftDays < 0) txt = `${-leftDays} napja esedékes`;
  else txt = `még ${fmtKm(leftKm)}`;
  return { s, txt, d: Math.min(leftDays, Math.round(leftKm / 40)), date: iso(dd),
    sub: `${fmtKm(dueKm)}-nél vagy ${fmtDate(iso(dd))}-ig` };
}
function items(c) {
  const list = DOC_TYPES.map(([k, t, sub]) => ({ k, t, sub: c.notes[k] || sub, date: c.docs[k], ...dateStatus(c.docs[k]) }));
  const o = oilInfo(c);
  list.push({ k: "oil", t: "Olajcsere", sub: o.sub, date: o.date, s: o.s, txt: o.txt, d: o.d, noDate: true });
  c.custom.forEach(x => list.push({ k: "c:" + x.id, t: x.title, sub: x.note || "saját emlékeztető", date: x.date, ...dateStatus(x.date) }));
  return list;
}
const RANK = { bad: 0, warn: 1, ok: 2, none: 3 };
const byUrgency = (a, b) => RANK[a.s] - RANK[b.s] || a.d - b.d;

/* ---------- megjelenítés ---------- */
const ICONS = {
  home: '<path d="M3 11l9-7 9 7v9h-6v-6H9v6H3z"/>',
  docs: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
  log: '<path d="M14 6a4 4 0 0 0-5 5L4 16l3 3 5-5a4 4 0 0 0 5-5l-2 2-2-1-1-2z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
};

function render() {
  const c = car();
  let h = "";
  if (tab === "settings") h = renderSettings();
  else if (!c) h = renderWelcome();
  else {
    const list = items(c);
    const n = { bad: 0, warn: 0, ok: 0 };
    list.forEach(i => { if (i.s in n) n[i.s]++; });
    h += `<div class="top"><h1>Garázs napló</h1>
      <button class="iconbtn" data-act="editcar" aria-label="Autó adatainak szerkesztése"><svg viewBox="0 0 24 24">${ICONS.edit}</svg></button></div>`;
    h += carChips(c);
    h += `<div class="card hero">
      <div class="row">
        <div><h2>${esc(c.model || c.name)}</h2><div class="hint">${c.year ? esc(c.year) + " · " : ""}${esc(c.name)}</div></div>
        ${c.plate ? `<span class="plate"><span class="eu">RO</span><span class="nr">${esc(c.plate)}</span></span>` : ""}
      </div>
      <div class="row">
        <div><div class="label">Km-óra állás</div><div class="big num">${fmtKm(c.km)}</div></div>
        <button class="btn" data-act="km">Km frissítése</button>
      </div></div>`;
    h += `<div class="summary">
      ${n.bad ? `<span class="pill s-bad">${n.bad} lejárt</span>` : ""}
      ${n.warn ? `<span class="pill s-warn">${n.warn} hamarosan lejár</span>` : ""}
      <span class="pill s-ok">${n.ok} rendben</span></div>`;
    if (tab === "home") h += renderHome(c, list);
    if (tab === "docs") h += renderDocs(c, list);
    if (tab === "log") h += renderLog(c);
  }
  $("#app").innerHTML = h;
  const tabs = [["home", "Áttekintés"], ["docs", "Lejáratok"], ["log", "Szervizkönyv"], ["settings", "Beállítások"]];
  $("#tabs").innerHTML = tabs.map(([k, l]) =>
    `<button class="tab" role="tab" aria-selected="${tab === k}" data-tab="${k}"><svg viewBox="0 0 24 24">${ICONS[k]}</svg>${l}</button>`).join("");
}

function carChips(c) {
  return `<div class="cars">${S.cars.map(x => {
    const bad = items(x).some(i => i.s === "bad");
    return `<button class="chip" aria-pressed="${x.id === c?.id}" data-car="${x.id}">${esc(x.name)}${bad ? '<span class="dot" aria-label="lejárt tétel"></span>' : ""}</button>`;
  }).join("")}<button class="chip add" data-act="addcar">+ Új autó</button></div>`;
}

const itemHtml = i => `<button class="item" data-edit="${esc(i.k)}">
  <span class="bar s-${i.s}"></span>
  <span><div class="t">${esc(i.t)}</div><div class="sub">${esc(i.sub)}</div></span>
  <span class="right"><div class="c-${i.s} num">${i.txt}</div><div class="hint num">${i.noDate ? "" : fmtDate(i.date)}</div></span>
</button>`;

function entryHtml(e) {
  return `<button class="entry" data-entry="${e.id}"><span class="date num">${fmtDate(e.date)}</span>
    <span><div style="font-weight:600">${esc(e.title)}</div><div class="hint num">${fmtKm(e.km)}${e.place ? " · " + esc(e.place) : ""}</div></span>
    <span class="cost num">${e.cost ? fmtMoney(e.cost) : ""}</span></button>`;
}

function renderWelcome() {
  return `<div class="top"><h1>Garázs napló</h1></div>
  <div class="card welcome">
    <h2>Add hozzá az első autót</h2>
    <p class="hint">Utána beírhatod az RCA, rovinieta, ITP és a többi lejáratot, és bejegyezheted a szervizeket. Minden adat csak ezen a telefonon tárolódik.</p>
    <button class="btn" data-act="addcar">+ Új autó</button>
  </div>`;
}

function renderHome(c, list) {
  const urgent = list.filter(i => i.s === "bad" || i.s === "warn").sort(byUrgency);
  const missing = list.filter(i => i.s === "none" && !["casco"].includes(i.k));
  let h = `<div class="section"><h2>Teendők</h2><div class="card list">${urgent.length ? urgent.map(itemHtml).join("")
    : `<div class="empty">Minden rendben, 30 napon belül nem jár le semmi.</div>`}</div></div>`;
  if (missing.length) h += `<div class="section"><h2>Még nincs megadva</h2><div class="card list">${missing.map(itemHtml).join("")}</div></div>`;
  const last = [...c.log].sort((a, b) => b.date.localeCompare(a.date))[0];
  h += `<div class="section"><div class="row"><h2>Utolsó szerviz</h2><button class="btn ghost" data-tab="log">Szervizkönyv</button></div>
    <div class="card list">${last ? entryHtml(last) : `<div class="empty">Még nincs bejegyzés.</div>`}</div></div>`;
  return h;
}

function renderDocs(c, list) {
  return `<div class="section"><h2>Lejáratok</h2>
    <div class="card list">${[...list].sort(byUrgency).map(itemHtml).join("")}</div>
    <button class="btn ghost wide" data-act="addcustom">+ Saját emlékeztető (pl. gumicsere, vezérlés)</button>
    <button class="btn wide" data-act="calcar">Lejáratok hozzáadása a Naptárhoz</button>
    <p class="hint">A Naptárba került eseménynél az iPhone ${remindText()} szól előre. Ha módosítasz egy dátumot, add hozzá újra azt az egy tételt.</p></div>`;
}

function renderLog(c) {
  const list = [...c.log].sort((a, b) => b.date.localeCompare(a.date) || b.km - a.km);
  const year = String(today().getFullYear());
  const totalYear = list.filter(e => e.date.startsWith(year)).reduce((s, e) => s + Number(e.cost || 0), 0);
  const total = list.reduce((s, e) => s + Number(e.cost || 0), 0);
  return `<div class="section"><div class="row"><h2>Szervizkönyv</h2><button class="btn" data-act="addlog">+ Bejegyzés</button></div>
    <div class="card list">${list.length ? list.map(entryHtml).join("")
      : `<div class="empty">Még nincs bejegyzés. A következő szerviz után add hozzá a „+ Bejegyzés” gombbal.</div>`}</div>
    ${list.length ? `<p class="hint num">${year}-ban: ${fmtMoney(totalYear)} · összesen: ${fmtMoney(total)} (${list.length} bejegyzés)</p>` : ""}</div>`;
}

function remindText() {
  const r = [...S.settings.remind].sort((a, b) => b - a);
  return r.length ? r.join(", ") + " nappal" : "nem";
}

function renderSettings() {
  const r = S.settings.remind;
  return `<div class="top"><h1>Beállítások</h1></div>
  <div class="settings" style="display:grid;gap:18px">
    <div class="section" style="margin-top:0"><h2>Emlékeztetők</h2><div class="card">
      <p class="hint">Hány nappal a lejárat előtt szóljon a Naptár (reggel 9-kor):</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${REMIND_OPTIONS.map(d =>
        `<button class="chip" aria-pressed="${r.includes(d)}" data-remind="${d}">${d} nap</button>`).join("")}</div>
      <button class="btn" data-act="calall" ${S.cars.length ? "" : "disabled"}>Összes autó lejáratai a Naptárba</button>
      <p class="hint">Ezt elég egyszer megcsinálni, és utána akkor, ha valamelyik dátum megváltozik.</p>
    </div></div>
    <div class="section" style="margin-top:0"><h2>Mentés</h2><div class="card">
      <p class="hint">Az adatok csak ezen a telefonon vannak. Néha ments egy másolatot a Fájlokba vagy az iCloud Drive-ra, hogy telefoncsere után se vesszen el semmi.</p>
      <button class="btn" data-act="export" ${S.cars.length ? "" : "disabled"}>Biztonsági mentés készítése</button>
      <button class="btn ghost" data-act="import">Visszaállítás mentésből</button>
      ${S.lastBackup ? `<p class="hint">Utolsó mentés: ${fmtDate(S.lastBackup)}</p>` : ""}
    </div></div>
    <p class="hint">Garázs napló ${APP_VERSION}</p>
  </div>`;
}

/* ---------- lapok (űrlapok) ---------- */
function sheet(html, onSave, extraActions = "") {
  const el = $("#sheet");
  el.innerHTML = `<div class="sheet-bg"><form class="sheet" id="sf" novalidate>${html}
    <div class="actions">${extraActions}<span class="spacer"></span><button type="button" class="btn ghost" data-close>Mégse</button>${onSave ? '<button class="btn" type="submit">Mentés</button>' : ""}</div></form></div>`;
  const form = $("#sf");
  form.addEventListener("submit", e => {
    e.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const f = Object.fromEntries(new FormData(form));
    if (onSave(f) !== false) { save(); closeSheet(); render(); }
  });
  el.querySelector(".sheet-bg").addEventListener("click", e => { if (e.target.classList.contains("sheet-bg")) closeSheet(); });
  return form;
}
const closeSheet = () => { $("#sheet").innerHTML = ""; };
const field = (id, label, attrs = "") => `<label class="field"><span class="label">${label}</span><input id="f-${id}" name="${id}" ${attrs}></label>`;
const v = s => esc(s ?? "");

function confirmIn(form, text, onYes) {
  const box = document.createElement("div");
  box.className = "card"; box.style.cssText = "padding:12px;display:grid;gap:10px;border-color:var(--bad)";
  box.innerHTML = `<p>${text}</p><div class="actions"><button type="button" class="btn ghost" data-no>Mégse</button><button type="button" class="btn danger" data-yes>Igen, törlés</button></div>`;
  form.querySelector(".actions").before(box);
  box.querySelector("[data-no]").onclick = () => box.remove();
  box.querySelector("[data-yes]").onclick = () => { onYes(); save(); closeSheet(); render(); };
}

function carForm(c) {
  const isNew = !c;
  c = c || {};
  const form = sheet(`<h2>${isNew ? "Új autó" : "Autó adatai"}</h2>
    ${field("name", "Megnevezés", `required value="${v(c.name)}" placeholder="pl. Apu autója"`)}
    <div class="row2">${field("plate", "Rendszám", `value="${v(c.plate)}" placeholder="CJ 01 ABC" autocapitalize="characters"`)}${field("year", "Évjárat", `type="number" inputmode="numeric" value="${v(c.year)}"`)}</div>
    ${field("model", "Márka, típus", `value="${v(c.model)}" placeholder="pl. Dacia Logan 1.5 dCi"`)}
    ${field("km", "Km-óra állás", `type="number" inputmode="numeric" required min="0" value="${v(c.km)}"`)}`,
    f => {
      const data = { name: f.name.trim(), plate: f.plate.trim().toUpperCase(), year: f.year, model: f.model.trim(), km: Number(f.km) };
      if (isNew) {
        const id = uid();
        S.cars.push({ id, ...data, docs: {}, notes: {}, log: [], custom: [],
          oil: { date: "", km: data.km, everyKm: 15000, everyMonths: 12 } });
        S.sel = id; tab = "docs";
        toast("Autó hozzáadva. Most add meg a lejáratokat.");
      } else Object.assign(c, data);
    },
    isNew ? "" : `<button type="button" class="btn danger" data-delcar>Autó törlése</button>`);
  const del = form.querySelector("[data-delcar]");
  if (del) del.onclick = () => confirmIn(form, `Biztosan törlöd: <b>${esc(c.name)}</b>? Minden lejárata és szervizbejegyzése is törlődik.`, () => {
    S.cars = S.cars.filter(x => x.id !== c.id); S.sel = S.cars[0]?.id ?? null; tab = "home";
  });
}

function docForm(c, k) {
  if (k === "oil") {
    const o = c.oil;
    const form = sheet(`<h2>Olajcsere</h2><p class="hint">Az utolsó olajcsere és az intervallum alapján számol. Amelyik előbb jön, a km vagy az idő, az számít.</p>
      <div class="row2">${field("date", "Utolsó csere", `type="date" required value="${v(o.date)}"`)}${field("km", "Km-állás akkor", `type="number" inputmode="numeric" required value="${v(o.km)}"`)}</div>
      <div class="row2">${field("everyKm", "Csere km-enként", `type="number" inputmode="numeric" required value="${v(o.everyKm)}"`)}${field("everyMonths", "vagy hónaponként", `type="number" inputmode="numeric" required value="${v(o.everyMonths)}"`)}</div>`,
      f => { c.oil = { date: f.date, km: Number(f.km), everyKm: Number(f.everyKm), everyMonths: Number(f.everyMonths) }; },
      o.date ? `<button type="button" class="btn ghost" data-cal>Naptárba</button>` : "");
    const cal = form.querySelector("[data-cal]");
    if (cal) cal.onclick = () => exportCalendar([c], "oil");
    return;
  }
  if (k.startsWith("c:")) {
    const x = c.custom.find(y => "c:" + y.id === k);
    return customForm(c, x);
  }
  const t = DOC_TYPES.find(d => d[0] === k);
  const form = sheet(`<h2>${t[1]}</h2><p class="hint">${t[2]} · ${esc(c.name)}</p>
    ${field("exp", "Lejárat dátuma", `type="date" value="${v(c.docs[k])}"`)}
    ${field("note", "Megjegyzés", `value="${v(c.notes[k])}" placeholder="pl. biztosító, kötvényszám, ár"`)}
    <p class="hint">Hagyd üresen a dátumot, ha erre az autóra nem vonatkozik.</p>`,
    f => { c.docs[k] = f.exp; c.notes[k] = f.note.trim(); },
    c.docs[k] ? `<button type="button" class="btn ghost" data-cal>Naptárba</button>` : "");
  const cal = form.querySelector("[data-cal]");
  if (cal) cal.onclick = () => exportCalendar([c], k);
}

function customForm(c, x) {
  const isNew = !x; x = x || {};
  const form = sheet(`<h2>${isNew ? "Saját emlékeztető" : esc(x.title)}</h2>
    ${field("title", "Megnevezés", `required value="${v(x.title)}" placeholder="pl. Nyári gumi felrakása"`)}
    ${field("date", "Dátum", `type="date" required value="${v(x.date)}"`)}
    ${field("note", "Megjegyzés", `value="${v(x.note)}"`)}`,
    f => {
      const data = { title: f.title.trim(), date: f.date, note: f.note.trim() };
      if (isNew) c.custom.push({ id: uid(), ...data }); else Object.assign(x, data);
    },
    isNew ? "" : `<button type="button" class="btn danger" data-del>Törlés</button><button type="button" class="btn ghost" data-cal>Naptárba</button>`);
  if (!isNew) {
    form.querySelector("[data-del]").onclick = () => confirmIn(form, "Törlöd ezt az emlékeztetőt?", () => { c.custom = c.custom.filter(y => y.id !== x.id); });
    form.querySelector("[data-cal]").onclick = () => exportCalendar([c], "c:" + x.id);
  }
}

function logForm(c, e) {
  const isNew = !e; e = e || { date: iso(today()), km: c.km };
  const form = sheet(`<h2>${isNew ? "Új szerviz bejegyzés" : "Szerviz bejegyzés"}</h2>
    ${field("title", "Mit csináltak", `required value="${v(e.title)}" placeholder="pl. Olajcsere + szűrők"`)}
    <div class="row2">${field("date", "Dátum", `type="date" required value="${v(e.date)}"`)}${field("km", "Km-állás", `type="number" inputmode="numeric" required value="${v(e.km)}"`)}</div>
    <div class="row2">${field("place", "Szerviz neve", `value="${v(e.place)}"`)}${field("cost", "Ár (lej)", `type="number" inputmode="decimal" step="any" value="${v(e.cost || "")}"`)}</div>
    ${isNew ? `<label class="check"><input type="checkbox" id="f-isoil" name="isoil"><span>Ez olajcsere volt (a következőt innen számolja)</span></label>` : ""}`,
    f => {
      const data = { date: f.date, km: Number(f.km), title: f.title.trim(), place: f.place.trim(), cost: f.cost ? Number(f.cost) : 0 };
      if (isNew) c.log.push({ id: uid(), ...data }); else Object.assign(e, data);
      if (data.km > c.km) c.km = data.km;
      if (f.isoil) c.oil = { ...c.oil, date: data.date, km: data.km };
    },
    isNew ? "" : `<button type="button" class="btn danger" data-del>Törlés</button>`);
  if (!isNew) form.querySelector("[data-del]").onclick = () => confirmIn(form, "Törlöd ezt a bejegyzést?", () => { c.log = c.log.filter(y => y.id !== e.id); });
}

/* ---------- Naptár (.ics) ---------- */
function icsEscape(s) { return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n"); }
function fold(line) {
  const out = []; let cur = ""; let bytes = 0;
  for (const ch of line) {
    const b = new TextEncoder().encode(ch).length;
    if (bytes + b > 74) { out.push(cur); cur = " "; bytes = 1; }
    cur += ch; bytes += b;
  }
  out.push(cur); return out.join("\r\n");
}
function buildIcs(events) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Garazs naplo//HU", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  for (const ev of events) {
    const start = parseDate(ev.date), end = parseDate(ev.date);
    end.setDate(end.getDate() + 1);
    const ymd = d => iso(d).replace(/-/g, "");
    L.push("BEGIN:VEVENT", `UID:${ev.uid}@garazs-naplo`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ymd(start)}`, `DTEND;VALUE=DATE:${ymd(end)}`,
      `SUMMARY:${icsEscape(ev.title)}`, `DESCRIPTION:${icsEscape(ev.desc)}`, "TRANSP:TRANSPARENT");
    for (const n of S.settings.remind) {
      // egész napos esemény kezdete éjfél; 15 órával előtte = előző nap 9:00
      const trig = n === 1 ? "-PT15H" : `-P${n - 1}DT15H`;
      L.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(ev.title)}`, `TRIGGER:${trig}`, "END:VALARM");
    }
    L.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(ev.title)}`, "TRIGGER:PT9H", "END:VALARM");
    L.push("END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return L.map(fold).join("\r\n") + "\r\n";
}
function calendarEvents(cars, only) {
  const evs = [];
  for (const c of cars) {
    const label = c.plate ? `${c.name} (${c.plate})` : c.name;
    for (const i of items(c)) {
      if (only && i.k !== only) continue;
      if (!i.date) continue;
      if (!only && i.s === "bad" && dateStatus(i.date).d < -1) continue; // régen lejártat nem rakunk be
      const verb = i.k === "oil" ? "esedékes" : "lejár";
      evs.push({ uid: `${c.id}-${i.k.replace(":", "-")}-${i.date}`, date: i.date,
        title: `${i.t} ${verb} – ${c.name}`,
        desc: `${label}\n${i.k === "oil" ? "Olajcsere: " + i.sub : i.sub}\nGarázs napló` });
    }
  }
  return evs;
}
function exportCalendar(cars, only) {
  const evs = calendarEvents(cars, only);
  if (!evs.length) { toast("Nincs olyan dátum, amit a Naptárba lehetne tenni."); return; }
  const name = only ? "garazs-emlekezteto.ics" : "garazs-lejaratok.ics";
  deliverFile(name, "text/calendar", buildIcs(evs), true);
}

/* ---------- fájl átadás (Naptár, mentés) ---------- */
async function deliverFile(name, mime, text, isCalendar) {
  const blob = new Blob([text], { type: mime + ";charset=utf-8" });
  if (isCalendar) {
    // iPhone-on a Safari megnyitja a naptárfájlt és felajánlja: „Összes hozzáadása”
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast("Nyisd meg a letöltött fájlt, és válaszd: Összes hozzáadása");
    return;
  }
  const file = new File([blob], name, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return true; }
    catch (e) { if (e.name === "AbortError") return false; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

async function exportBackup() {
  const name = `garazs-mentes-${iso(today())}.json`;
  const data = JSON.stringify({ ...S, lastBackup: undefined, app: "garazs-naplo", exported: new Date().toISOString() }, null, 1);
  const ok = await deliverFile(name, "application/json", data, false);
  if (ok) { S.lastBackup = iso(today()); save(); render(); toast("Mentés kész. Tedd a Fájlokba vagy az iCloud Drive-ra."); }
}

function importBackup(file) {
  const r = new FileReader();
  r.onload = () => {
    let data;
    try { data = JSON.parse(r.result); } catch (e) { data = null; }
    if (!data || data.app !== "garazs-naplo" || !Array.isArray(data.cars)) {
      toast("Ez a fájl nem Garázs napló mentés."); return;
    }
    const form = sheet(`<h2>Visszaállítás</h2><p>A mentésben ${data.cars.length} autó van (${data.cars.map(c => esc(c.name)).join(", ")}), készült: ${fmtDate((data.exported || "").slice(0, 10))}.</p>
      <p class="hint">A visszaállítás lecseréli a jelenlegi adatokat.</p>`, null,
      `<button type="button" class="btn" data-yes>Visszaállítás</button>`);
    form.querySelector("[data-yes]").onclick = () => {
      delete data.app; delete data.exported;
      S = normalize(data); save(); closeSheet(); tab = "home"; render(); toast("Adatok visszaállítva.");
    };
  };
  r.readAsText(file);
}

/* ---------- egyéb ---------- */
let toastTimer;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

document.addEventListener("click", e => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.hasAttribute("data-close")) { closeSheet(); return; }
  if (b.closest("#sheet")) return; // a lapok saját gombjai
  const c = car();
  if (b.dataset.car) { S.sel = b.dataset.car; if (tab === "settings") tab = "home"; save(); render(); return; }
  if (b.dataset.tab) { tab = b.dataset.tab; render(); window.scrollTo(0, 0); return; }
  if (b.dataset.edit) { docForm(c, b.dataset.edit); return; }
  if (b.dataset.entry) { logForm(c, c.log.find(x => x.id === b.dataset.entry)); return; }
  if (b.dataset.remind) {
    const d = Number(b.dataset.remind), r = S.settings.remind;
    S.settings.remind = r.includes(d) ? r.filter(x => x !== d) : [...r, d];
    save(); render(); return;
  }
  switch (b.dataset.act) {
    case "addcar": carForm(null); break;
    case "editcar": carForm(c); break;
    case "km": sheet(`<h2>Km-óra állás</h2><p class="hint">${esc(c.name)} · eddig ${fmtKm(c.km)}</p>
      ${field("km", "Jelenlegi km", `type="number" inputmode="numeric" required min="0" value="${c.km}"`)}`,
      f => { c.km = Number(f.km); toast("Km-állás frissítve."); }); break;
    case "addlog": logForm(c, null); break;
    case "addcustom": customForm(c, null); break;
    case "calcar": exportCalendar([c]); break;
    case "calall": exportCalendar(S.cars); break;
    case "export": exportBackup(); break;
    case "import": $("#importfile").click(); break;
  }
});
$("#importfile").addEventListener("change", e => { const f = e.target.files[0]; if (f) importBackup(f); e.target.value = ""; });

// napváltáskor (pl. másnap megnyitva) frissüljenek a napok
document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
render();
