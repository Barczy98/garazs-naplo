"use strict";
const APP_VERSION = "1.3.0";
const KEY = "garazs-naplo-v1";
const DAY = 864e5;

const DOC_TYPES = [
  ["rca", "RCA biztosítás", "kötelező felelősségbiztosítás"],
  ["rov", "Rovinieta", "úthasználati díj"],
  ["itp", "ITP", "műszaki vizsga"],
  ["tax", "Gépjárműadó", "impozit auto"],
];
// km vagy idő alapú karbantartás: amelyik előbb jön
const SERVICES = {
  oil: { t: "Olajcsere", everyKm: 15000, everyMonths: 12, logLabel: "Ez olajcsere volt",
    hint: "Az utolsó olajcsere és az intervallum alapján számol." },
  timing: { t: "Vezérműszíj", everyKm: 120000, everyMonths: 60, logLabel: "Ez vezérműszíj-csere volt",
    hint: "Az utolsó vezérlés csere és a gyártói intervallum alapján számol (gyakran 90–150 ezer km vagy 5–6 év, nézd meg a szervizkönyvben). Láncos motornál hagyd üresen." },
};
const SERVICE_KEYS = Object.keys(SERVICES);
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
    for (const k of SERVICE_KEYS) c[k] = c[k] || { date: "", km: c.km || 0, everyKm: SERVICES[k].everyKm, everyMonths: SERVICES[k].everyMonths };
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
  if (!date) return { s: "none", txt: "nincs megadva", d: 1e9, n: "–", u: "" };
  const days = Math.round((parseDate(date) - today()) / DAY);
  if (days < 0) return { s: "bad", txt: `lejárt ${-days} napja`, d: days, n: -days, u: "napja" };
  if (days === 0) return { s: "bad", txt: "ma jár le", d: 0, n: "ma", u: "" };
  if (days <= 30) return { s: "warn", txt: `${days} nap múlva`, d: days, n: days, u: "nap" };
  return { s: "ok", txt: `${days} nap múlva`, d: days, n: days, u: "nap" };
}
function serviceInfo(c, key) {
  const o = c[key];
  if (!o.date) return { s: "none", txt: "nincs megadva", d: 1e9, sub: "koppints ide, és add meg az utolsó cserét", date: "", n: "–", u: "", frac: null };
  const dueKm = Number(o.km) + Number(o.everyKm);
  const leftKm = dueKm - Number(c.km);
  const dd = parseDate(o.date); dd.setMonth(dd.getMonth() + Number(o.everyMonths));
  const leftDays = Math.round((dd - today()) / DAY);
  const totalDays = Math.max(1, Math.round((dd - parseDate(o.date)) / DAY));
  const warnKm = Math.max(1500, Number(o.everyKm) * 0.05);
  let s = "ok";
  if (leftKm < 0 || leftDays < 0) s = "bad"; else if (leftKm < warnKm || leftDays <= 30) s = "warn";
  const dateFirst = leftDays * 40 < leftKm; // ha az idő jár le előbb (kb. 40 km/nap)
  let txt, n, u;
  if (leftKm < 0) { txt = `${fmtKm(-leftKm)}-rel túllépve`; n = kShort(-leftKm); u = kUnit(-leftKm) + " túl"; }
  else if (leftDays < 0) { txt = `${-leftDays} napja esedékes`; n = -leftDays; u = "napja"; }
  else if (dateFirst && leftDays <= 90) { txt = `${leftDays} nap múlva`; n = leftDays; u = "nap"; }
  else { txt = `még ${fmtKm(leftKm)}`; n = kShort(leftKm); u = kUnit(leftKm); }
  const frac = Math.max(0, Math.min(leftKm / Number(o.everyKm), leftDays / totalDays));
  return { s, txt, n, u, frac, d: Math.min(leftDays, Math.round(leftKm / 40)), date: iso(dd),
    sub: `${fmtKm(dueKm)}-nél vagy ${fmtDate(iso(dd))}-ig` };
}
// km-állás alapú saját emlékeztető (pl. 200 000 km-nél fékfolyadék)
function kmStatus(c, x) {
  const target = Number(x.km), left = target - Number(c.km);
  const span = Math.max(1, target - Number(x.startKm ?? c.km));
  const warnKm = Math.max(1000, span * 0.05);
  const s = left < 0 ? "bad" : left < warnKm ? "warn" : "ok";
  const sub = `${fmtKm(target)}-nél` + (x.note ? `, ${x.note}` : "");
  if (left < 0) return { s, sub, txt: `${fmtKm(-left)}-rel túllépve`, n: kShort(-left), u: kUnit(-left) + " túl", d: Math.round(left / 40), frac: 0, date: "" };
  return { s, sub, txt: `még ${fmtKm(left)}`, n: kShort(left), u: kUnit(left), d: Math.round(left / 40), frac: Math.min(1, left / span), date: "" };
}
function kShort(km) { return km >= 1000 ? (km / 1000).toLocaleString("hu-HU", { maximumFractionDigits: km < 10000 ? 1 : 0 }) : String(km); }
const kUnit = km => km >= 1000 ? "ezer km" : "km";
function items(c) {
  const list = DOC_TYPES.map(([k, t, sub]) => ({ k, t, sub: c.notes[k] || sub, date: c.docs[k], ...dateStatus(c.docs[k]) }));
  for (const k of SERVICE_KEYS) {
    const o = serviceInfo(c, k);
    list.push({ ...o, k, t: SERVICES[k].t, service: true });
  }
  c.custom.forEach(x => list.push(x.mode === "km" ? { k: "c:" + x.id, t: x.title, ...kmStatus(c, x), service: true }
    : { k: "c:" + x.id, t: x.title, sub: x.note || "saját emlékeztető", date: x.date, ...dateStatus(x.date) }));
  return list;
}
const RANK = { bad: 0, warn: 1, ok: 2, none: 3 };
const byUrgency = (a, b) => RANK[a.s] - RANK[b.s] || a.d - b.d;
const monthLabel = s => parseDate(s).toLocaleDateString("hu-HU", { year: "numeric", month: "long" });
const shortDate = s => parseDate(s).toLocaleDateString("hu-HU", { month: "short", day: "numeric" });
function sinceText(s) {
  if (!s) return "";
  const d = Math.round((today() - parseDate(s)) / DAY);
  return d <= 0 ? "Frissítve: ma" : d === 1 ? "Frissítve: tegnap" : `Frissítve: ${d} napja`;
}

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
    h += plates(c);
    h += `<div class="carname"><div><h1>${esc(c.model || c.name)}</h1><p class="hint">${esc(c.name)}${c.year ? ", " + esc(c.year) : ""}</p></div>
      <button class="iconbtn" data-act="editcar" aria-label="Autó adatainak szerkesztése"><svg viewBox="0 0 24 24">${ICONS.edit}</svg></button></div>`;
    if (tab === "home") h += renderHome(c, list);
    if (tab === "docs") h += renderDocs(c, list);
    if (tab === "log") h += renderLog(c);
  }
  $("#app").innerHTML = h;
  const tabs = [["home", "Áttekintés"], ["docs", "Lejáratok"], ["log", "Szervizkönyv"], ["settings", "Beállítások"]];
  $("#tabs").innerHTML = tabs.map(([k, l]) =>
    `<button class="tab" role="tab" aria-selected="${tab === k}" data-tab="${k}"><svg viewBox="0 0 24 24">${ICONS[k]}</svg>${l}</button>`).join("");
}

function plateHtml(x) {
  return `<span class="eu">RO</span><span class="nr">${esc(x.plate || x.name)}</span>`;
}
function plates(c) {
  return `<div class="plates">${S.cars.map(x => {
    const bad = items(x).some(i => i.s === "bad");
    return `<button class="plate" aria-pressed="${x.id === c?.id}" data-car="${x.id}" aria-label="${esc(x.name)}${bad ? ", lejárt tétel" : ""}">${plateHtml(x)}${bad ? '<span class="dot"></span>' : ""}</button>`;
  }).join("")}<button class="plate add" data-act="addcar">+ autó</button></div>`;
}

function odometer(c) {
  const s = String(Math.max(0, Math.round(c.km)));
  const digits = s.padStart(Math.max(6, s.length), "0").split("");
  return `<button class="odo" data-act="km" aria-label="Km-óra: ${fmtKm(c.km)}. Koppints a frissítéshez.">
    <span class="drums" aria-hidden="true">${digits.map((d, i) => `<span class="drum${i === digits.length - 1 ? " last" : ""}">${d}</span>`).join("")}<span class="unit">km</span></span>
    <span class="odo-row"><span>${sinceText(c.kmDate)}</span><span class="btn">Km frissítése</span></span>
  </button>`;
}

const rowHtml = i => `<button class="r" data-edit="${esc(i.k)}">
  <span class="n ${i.s}">${i.n}<small>${i.u}</small></span>
  <span class="rt"><span class="t">${esc(i.t)}</span><span class="s">${esc(i.s === "none" ? i.sub : i.service ? i.sub : (i.s === "bad" ? "lejárt " : "") + fmtDate(i.date) + (i.sub ? ", " + i.sub : ""))}</span></span>
</button>`;

function gaugeHtml(i) {
  if (i.s === "none") return `<button class="gauge" data-edit="${i.k}"><span class="gtop"><b>${esc(i.t)}</b><span class="hint">nincs megadva</span></span><span class="s">${esc(i.sub)}</span></button>`;
  return `<button class="gauge" data-edit="${i.k}">
    <span class="gtop"><b>${esc(i.t)}</b><span class="c-${i.s} num">${esc(i.txt)}</span></span>
    ${i.frac == null ? "" : `<span class="track"><span class="fill ${i.s}" style="width:${Math.max(3, Math.round(i.frac * 100))}%"></span></span>`}
    <span class="s">${esc(i.sub)}</span></button>`;
}

function entryHtml(e) {
  return `<button class="svc" data-entry="${e.id}">
    <span class="svc-main"><span class="t">${esc(e.title)}</span>
    <span class="s num">${fmtDate(e.date)}, ${fmtKm(e.km)}${e.cost ? ` <b class="cost">${fmtMoney(e.cost)}</b>` : ""}</span></span>
    ${e.place ? `<span class="stamp" aria-label="Szerviz: ${esc(e.place)}">${esc(e.place.toUpperCase())}</span>` : ""}
  </button>`;
}

function renderWelcome() {
  return `<div class="welcome">
    <span class="plate big" aria-hidden="true"><span class="eu">RO</span><span class="nr">CJ 00 NEW</span></span>
    <h1>Add hozzá az első autót</h1>
    <p class="hint">Utána beírhatod az RCA, rovinieta, ITP és a többi lejáratot, és bejegyezheted a szervizeket. Minden adat csak ezen a telefonon tárolódik.</p>
    <button class="btn" data-act="addcar">Autó hozzáadása</button>
  </div>`;
}

function renderHome(c, list) {
  const urgent = list.filter(i => i.s === "bad" || i.s === "warn").sort(byUrgency);
  const missing = list.filter(i => i.s === "none" && !i.service);
  const services = list.filter(i => i.service);
  let h = odometer(c);
  h += `<section class="section"><h2 class="h">Teendők <small>${urgent.length ? urgent.length + " tétel" : ""}</small></h2>
    <div class="rows">${urgent.length ? urgent.map(rowHtml).join("") : `<div class="empty">Minden rendben, 30 napon belül nem jár le semmi.</div>`}</div></section>`;
  h += `<section class="section"><h2 class="h">Karbantartás</h2><div class="rows">${services.map(gaugeHtml).join("")}</div></section>`;
  if (missing.length) h += `<section class="section"><h2 class="h">Még nincs megadva</h2><div class="rows">${missing.map(rowHtml).join("")}</div></section>`;
  const last = [...c.log].sort((a, b) => b.date.localeCompare(a.date))[0];
  h += `<section class="section"><h2 class="h">Utolsó szerviz <button class="link" data-tab="log">Szervizkönyv</button></h2>
    <div class="rows">${last ? entryHtml(last) : `<div class="empty">Még nincs bejegyzés.</div>`}</div></section>`;
  return h;
}

function renderDocs(c, list) {
  const dated = list.filter(i => !i.service && i.date).sort((a, b) => a.date.localeCompare(b.date));
  const undated = list.filter(i => !i.service && !i.date);
  let tl = "", month = "";
  for (const i of dated) {
    const m = monthLabel(i.date);
    if (m !== month) { tl += `<div class="m">${m}</div>`; month = m; }
    tl += `<button class="ev ${i.s}" data-edit="${esc(i.k)}"><span class="evt"><span class="t">${esc(i.t)}</span><span class="s">${esc(i.sub)}</span></span>
      <span class="d num">${i.s === "bad" ? "lejárt<br>" + shortDate(i.date) : shortDate(i.date)}</span></button>`;
  }
  if (undated.length) {
    tl += `<div class="m">Nincs megadva</div>` + undated.map(i => `<button class="ev none" data-edit="${esc(i.k)}"><span class="evt"><span class="t">${esc(i.t)}</span><span class="s">${esc(i.sub)}</span></span><span class="d">–</span></button>`).join("");
  }
  return `<section class="section"><h2 class="h">Lejáratok <small>${esc(c.plate || "")}</small></h2>
    <div class="rows tlbox"><div class="tl">${tl}</div></div>
    <button class="btn wide" data-act="calcar">Lejáratok a Naptárba</button>
    <button class="btn quiet wide" data-act="addcustom">Saját emlékeztető hozzáadása</button>
    <p class="hint">A Naptárba került eseménynél az iPhone ${remindText()} szól előre. Ha módosítasz egy dátumot, add hozzá újra azt az egy tételt.</p></section>
    <section class="section"><h2 class="h">Karbantartás</h2><div class="rows">${list.filter(i => i.service).map(gaugeHtml).join("")}</div></section>`;
}

function renderLog(c) {
  const list = [...c.log].sort((a, b) => b.date.localeCompare(a.date) || b.km - a.km);
  const year = String(today().getFullYear());
  const totalYear = list.filter(e => e.date.startsWith(year)).reduce((s, e) => s + Number(e.cost || 0), 0);
  const total = list.reduce((s, e) => s + Number(e.cost || 0), 0);
  return `<section class="section"><h2 class="h">Szervizkönyv <button class="btn" data-act="addlog">Új bejegyzés</button></h2>
    <div class="rows">${list.length ? list.map(entryHtml).join("")
      : `<div class="empty">Még nincs bejegyzés. A következő szerviz után add hozzá az „Új bejegyzés” gombbal.</div>`}</div>
    ${list.length ? `<div class="sum num"><span>${year}-ban ${fmtMoney(totalYear)}</span><span>Összesen ${fmtMoney(total)}, ${list.length} bejegyzés</span></div>` : ""}</section>`;
}

function remindText() {
  const r = [...S.settings.remind].sort((a, b) => b - a);
  return r.length ? r.join(", ") + " nappal" : "nem";
}

function renderSettings() {
  const r = S.settings.remind;
  return `<h1 class="pagetitle">Beállítások</h1>
  <div class="settings" style="display:grid;gap:18px">
    <div class="section" style="margin-top:0"><h2>Emlékeztetők</h2><div class="card">
      <p class="hint">Hány nappal a lejárat előtt szóljon a Naptár (reggel 9-kor):</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${REMIND_OPTIONS.map(d =>
        `<button class="toggle" aria-pressed="${r.includes(d)}" data-remind="${d}">${d} nap</button>`).join("")}</div>
      <button class="btn" data-act="calall" ${S.cars.length ? "" : "disabled"}>Összes autó lejáratai a Naptárba</button>
      <p class="hint">Ezt elég egyszer megcsinálni, és utána akkor, ha valamelyik dátum megváltozik.</p>
    </div></div>
    <div class="section" style="margin-top:0"><h2>Mentés</h2><div class="card">
      <p class="hint">Az adatok csak ezen a telefonon vannak. Néha ments egy másolatot a Fájlokba vagy az iCloud Drive-ra, hogy telefoncsere után se vesszen el semmi.</p>
      <button class="btn" data-act="export" ${S.cars.length ? "" : "disabled"}>Biztonsági mentés készítése</button>
      <button class="btn quiet" data-act="import">Visszaállítás mentésből</button>
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
        S.cars.push({ id, ...data, kmDate: iso(today()), docs: {}, notes: {}, log: [], custom: [],
          ...Object.fromEntries(SERVICE_KEYS.map(k => [k, { date: "", km: data.km, everyKm: SERVICES[k].everyKm, everyMonths: SERVICES[k].everyMonths }])) });
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
  if (SERVICES[k]) {
    const o = c[k], def = SERVICES[k];
    const form = sheet(`<h2>${def.t}</h2><p class="hint">${def.hint} Amelyik előbb jön, a km vagy az idő, az számít.</p>
      <div class="row2">${field("date", "Utolsó csere", `type="date" required value="${v(o.date)}"`)}${field("km", "Km-állás akkor", `type="number" inputmode="numeric" required value="${v(o.km)}"`)}</div>
      <div class="row2">${field("everyKm", "Csere km-enként", `type="number" inputmode="numeric" required value="${v(o.everyKm)}"`)}${field("everyMonths", "vagy hónaponként", `type="number" inputmode="numeric" required value="${v(o.everyMonths)}"`)}</div>`,
      f => { c[k] = { date: f.date, km: Number(f.km), everyKm: Number(f.everyKm), everyMonths: Number(f.everyMonths) }; },
      o.date ? `<button type="button" class="btn ghost" data-cal>Naptárba</button>` : "");
    const cal = form.querySelector("[data-cal]");
    if (cal) cal.onclick = () => exportCalendar([c], k);
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
  const mode = x.mode === "km" ? "km" : "date";
  const form = sheet(`<h2>${isNew ? "Saját emlékeztető" : esc(x.title)}</h2>
    ${field("title", "Megnevezés", `required value="${v(x.title)}" placeholder="pl. Nyári gumi felrakása"`)}
    <div class="field"><span class="label">Mikor figyelmeztessen?</span>
      <div class="seg" role="radiogroup">
        <label><input type="radio" name="mode" value="date" ${mode === "date" ? "checked" : ""}><span>Dátum szerint</span></label>
        <label><input type="radio" name="mode" value="km" ${mode === "km" ? "checked" : ""}><span>Km-állás szerint</span></label>
      </div></div>
    <div data-mode="date">${field("date", "Dátum", `type="date" value="${v(x.date)}"`)}</div>
    <div data-mode="km">${field("km", "Ennél a km-állásnál", `type="number" inputmode="numeric" min="0" value="${v(x.km)}" placeholder="pl. ${Math.ceil((Number(c.km) + 10000) / 1000) * 1000}"`)}
      <p class="hint" style="margin-top:4px">Most ${fmtKm(c.km)}. Ha már csak kevés van hátra, narancssárgára vált.</p></div>
    ${field("note", "Megjegyzés", `value="${v(x.note)}"`)}`,
    f => {
      const data = { title: f.title.trim(), mode: f.mode, note: f.note.trim() };
      if (f.mode === "km") {
        if (!f.km) { toast("Add meg, hány km-nél figyelmeztessen."); return false; }
        data.km = Number(f.km); data.date = "";
        if (isNew || x.mode !== "km" || Number(x.km) !== data.km) data.startKm = Number(c.km);
      } else {
        if (!f.date) { toast("Add meg a dátumot."); return false; }
        data.date = f.date; delete x.km;
      }
      if (isNew) c.custom.push({ id: uid(), ...data }); else Object.assign(x, data);
    },
    isNew ? "" : `<button type="button" class="btn danger" data-del>Törlés</button>${mode === "date" ? '<button type="button" class="btn ghost" data-cal>Naptárba</button>' : ""}`);
  const sync = () => {
    const m = form.querySelector('input[name="mode"]:checked').value;
    form.querySelectorAll("[data-mode]").forEach(el => { el.hidden = el.dataset.mode !== m; });
  };
  form.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener("change", sync));
  sync();
  if (!isNew) {
    form.querySelector("[data-del]").onclick = () => confirmIn(form, "Törlöd ezt az emlékeztetőt?", () => { c.custom = c.custom.filter(y => y.id !== x.id); });
    const cal = form.querySelector("[data-cal]");
    if (cal) cal.onclick = () => exportCalendar([c], "c:" + x.id);
  }
}

function logForm(c, e) {
  const isNew = !e; e = e || { date: iso(today()), km: c.km };
  const form = sheet(`<h2>${isNew ? "Új szerviz bejegyzés" : "Szerviz bejegyzés"}</h2>
    ${field("title", "Mit csináltak", `required value="${v(e.title)}" placeholder="pl. Olajcsere + szűrők"`)}
    <div class="row2">${field("date", "Dátum", `type="date" required value="${v(e.date)}"`)}${field("km", "Km-állás", `type="number" inputmode="numeric" required value="${v(e.km)}"`)}</div>
    <div class="row2">${field("place", "Szerviz neve", `value="${v(e.place)}"`)}${field("cost", "Ár (lej)", `type="number" inputmode="decimal" step="any" value="${v(e.cost || "")}"`)}</div>
    ${isNew ? SERVICE_KEYS.map(k => `<label class="check"><input type="checkbox" id="f-is-${k}" name="is-${k}"><span>${SERVICES[k].logLabel} (a következőt innen számolja)</span></label>`).join("") : ""}`,
    f => {
      const data = { date: f.date, km: Number(f.km), title: f.title.trim(), place: f.place.trim(), cost: f.cost ? Number(f.cost) : 0 };
      if (isNew) c.log.push({ id: uid(), ...data }); else Object.assign(e, data);
      if (data.km > c.km) { c.km = data.km; c.kmDate = data.date; }
      for (const k of SERVICE_KEYS) if (f["is-" + k]) c[k] = { ...c[k], date: data.date, km: data.km };
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
      const verb = SERVICES[i.k] ? "esedékes" : "lejár";
      evs.push({ uid: `${c.id}-${i.k.replace(":", "-")}-${i.date}`, date: i.date,
        title: `${i.t} ${verb} – ${c.name}`,
        desc: `${label}\n${SERVICES[i.k] ? SERVICES[i.k].t + ": " + i.sub : i.sub}\nGarázs napló` });
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
      f => { c.km = Number(f.km); c.kmDate = iso(today()); toast("Km-állás frissítve."); }); break;
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
