"use strict";
const APP_VERSION = "1.14.1";
const CFG = window.APP_CONFIG || { platform: "ios", storageKey: "garazs-naplo-v1", vaultDb: "garazs-iratok" };
const ANDROID = CFG.platform === "android";
const KEY = CFG.storageKey;
const PHONE = ANDROID ? "telefon" : "iPhone"; // szövegekben: "az iPhone" / "a telefon"
const THE_PHONE = ANDROID ? "a telefon" : "az iPhone";
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
// személyes, nem autóhoz kötött lejáratok
const PERSONAL_TYPES = [
  ["license", "Jogosítvány", "permis de conducere"],
  ["idcard", "Személyi igazolvány", "carte de identitate"],
  ["passport", "Útlevél", "pașaport"],
];
const COST_CATS = { fuel: "Üzemanyag", service: "Szerviz", rca: "RCA", rov: "Rovinieta", itp: "ITP", tax: "Gépjárműadó", other: "Egyéb" };
const MANUAL_CATS = ["rca", "rov", "itp", "tax", "other"];
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
function emptyState() { return { version: 1, sel: null, cars: [], personal: { docs: {}, notes: {} }, settings: { remind: [30, 7, 1], theme: "system" } }; }
function normalize(s) {
  const base = emptyState();
  if (!s || !Array.isArray(s.cars)) return base;
  s.settings = Object.assign(base.settings, s.settings || {});
  s.personal = s.personal || base.personal;
  s.personal.docs = s.personal.docs || {}; s.personal.notes = s.personal.notes || {}; s.personal.costs = s.personal.costs || [];
  s.cars.forEach(c => {
    c.docs = c.docs || {}; c.notes = c.notes || {}; c.log = c.log || []; c.custom = c.custom || [];
    c.fuel = c.fuel || []; c.costs = c.costs || [];
    // a saját emlékeztetőként felvett jogosítvány átkerül a személyes lejáratok közé
    c.custom = c.custom.filter(x => {
      if (x.mode !== "km" && x.date && /jogos/i.test(x.title || "") && !s.personal.docs.license) {
        s.personal.docs.license = x.date; s.personal.notes.license = x.note || "";
        s.movedLicense = true; return false;
      }
      return true;
    });
    for (const k of SERVICE_KEYS) c[k] = c[k] || { date: "", km: c.km || 0, everyKm: SERVICES[k].everyKm, everyMonths: SERVICES[k].everyMonths };
  });
  if (!s.cars.some(c => c.id === s.sel)) s.sel = s.cars[0]?.id ?? null;
  return s;
}
let S;
try { S = normalize(JSON.parse(localStorage.getItem(KEY))); } catch (e) { S = emptyState(); }
let tab = "home";
let logView = "service";   // Napló fül: service | fuel | costs
let costYear = String(new Date().getFullYear());

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch (e) { toast("Nem sikerült menteni: a telefon tárhelye megtelt?"); }
}
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

const car = () => S.cars.find(c => c.id === S.sel);

/* ---------- megjelenés: rendszer / világos / sötét ---------- */
function applyTheme() {
  const t = S.settings.theme;
  const root = document.documentElement;
  if (t === "light" || t === "dark") root.dataset.theme = t; else delete root.dataset.theme;
  const dark = t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute("content", dark ? "#111613" : "#e9eee8"));
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
applyTheme();

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
function personalItems() {
  const P = S.personal;
  return PERSONAL_TYPES.map(([k, t, sub]) => ({ k: "p:" + k, t, sub: P.notes[k] || sub, date: P.docs[k], personal: true, ...dateStatus(P.docs[k]) }));
}
function daysText(date) {
  const d = Math.round((parseDate(date) - today()) / DAY);
  if (d < 0) return `${-d} napja lejárt`;
  if (d === 0) return "ma";
  if (d === 1) return "holnap";
  return `${d.toLocaleString("hu-HU")} nap múlva`;
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
  vault: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M10 13v-1a2 2 0 0 1 4 0v1M9.5 13h5v3.5h-5z"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
};

function render() {
  const c = car();
  let h = "";
  if (tab === "settings") h = renderSettings();
  else if (tab === "vault") h = Vault.html();
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
  const tabs = [["home", "Áttekintés"], ["docs", "Lejáratok"], ["log", "Napló"], ["vault", "Iratok"], ["settings", "Beállítások"]];
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

// km-kijelző: nagy, vékony számok doboz nélkül; alatta csík a következő olajcseréig
function odometer(c) {
  const oil = serviceInfo(c, "oil");
  const since = sinceText(c.kmDate).replace("Frissítve: ", "frissítve ");
  let below;
  if (oil.s === "none") below = `<div class="kmeta"><button class="link" data-edit="oil">Add meg az utolsó olajcserét</button><span>${since}</span></div>`;
  else {
    const left = Number(c.oil.km) + Number(c.oil.everyKm) - Number(c.km);
    const txt = left < 0 ? `Olajcsere <b class="c-bad">${fmtKm(-left)}-rel túllépve</b>` : `Olajcsere <b>${fmtKm(left)}</b> múlva`;
    below = `<button class="ktrack" data-edit="oil" aria-label="Olajcsere részletei"><i class="${oil.s}" style="width:${Math.max(3, Math.round(oil.frac * 100))}%"></i></button>
      <div class="kmeta"><span>${txt}</span><span>${since}</span></div>`;
  }
  return `<div class="kmbox">
    <div class="ktop"><div class="kmnum num" aria-label="Km-óra: ${fmtKm(c.km)}">${Number(c.km).toLocaleString("hu-HU")}<small>km</small></div>
      <button class="kupd" data-act="km" aria-label="Km-állás frissítése"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>Km</button></div>
    ${below}
  </div>`;
}

const rowHtml = i => `<button class="r" data-edit="${esc(i.k)}">
  <span class="n ${i.s}">${i.n}<small>${i.u}</small></span>
  <span class="rt"><span class="t">${esc(i.t)}${i.personal ? ' <span class="tag">személyes</span>' : ""}</span><span class="s">${esc(i.s === "none" ? i.sub : i.service ? i.sub : (i.s === "bad" ? "lejárt " : "") + fmtDate(i.date) + (i.sub ? ", " + i.sub : ""))}</span></span>
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
  const due = i => i.s === "bad" || i.s === "warn";
  const urgent = [...list.filter(i => !i.service), ...personalItems()].filter(due).sort(byUrgency);
  const missing = list.filter(i => i.s === "none" && !i.service);
  // karbantartás csak akkor látszik, ha 30 napon belül esedékes vagy közel a csere km-e
  const services = list.filter(i => i.service && due(i)).sort(byUrgency);
  const group = (title, body, extra = "") => `<section class="lgroup"><h2 class="lmonth">${title}${extra}</h2><div class="rows">${body}</div></section>`;
  let h = odometer(c) + staleBanner();
  h += `<div class="lgroups">`;
  h += group("Teendők", urgent.length ? urgent.map(i => lrowHtml(i, true)).join("") : `<div class="empty">Minden rendben, 30 napon belül nem jár le semmi.</div>`);
  if (services.length) h += group("Karbantartás", services.map(meterRowHtml).join(""));
  if (missing.length) h += group("Még nincs megadva", missing.map(lrowHtml).join(""));
  const last = [...c.log].sort((a, b) => b.date.localeCompare(a.date))[0];
  h += group("Utolsó szerviz", last ? `<button class="lrow" data-entry="${last.id}"><span class="lt"><span class="t">${esc(last.title)}</span>
      <span class="s num">${fmtDate(last.date)}, ${fmtKm(last.km)}${last.place ? ", " + esc(last.place) : ""}</span></span>
      <span class="ld num">${last.cost ? fmtMoney(last.cost) : ""}</span>${CHEV}</button>` : `<div class="empty">Még nincs bejegyzés.</div>`);
  h += group("Gyors rögzítés", `<button class="lrow" data-act="addfuel"><span class="lt"><span class="t">Új tankolás</span></span>${CHEV}</button>
      <button class="lrow" data-act="addlog"><span class="lt"><span class="t">Új szervizbejegyzés</span></span>${CHEV}</button>
      <button class="lrow" data-act="addcost"><span class="lt"><span class="t">Új kiadás</span></span>${CHEV}</button>`);
  h += `</div>`;
  return h;
}

const CHEV = '<svg class="lchev" viewBox="0 0 8 13" aria-hidden="true"><path d="M1 1l5.5 5.5L1 12"/></svg>';
// egy lista sor: pötty, név, jobbra dátum és hátralévő napok (km-es tételnél a hátralévő km)
function lrowHtml(i, showTag = false) {
  const right = i.service && i.s !== "none" ? esc(i.txt)
    : i.date ? `${shortDate(i.date)}<small>${daysText(i.date)}</small>` : "–";
  return `<button class="lrow" data-edit="${esc(i.k)}">
      <span class="ldot ${i.s}"></span>
      <span class="lt"><span class="t">${esc(i.t)}${showTag === true && i.personal ? ' <span class="tag">személyes</span>' : ""}</span><span class="s">${esc(i.sub)}</span></span>
      <span class="ld num ${i.s}">${right}</span>${CHEV}</button>`;
}
// karbantartás sor: név, hátralévő km, alatta vékony csík
function meterRowHtml(i) {
  return `<button class="lrow mrow" data-edit="${esc(i.k)}">
      <span class="lt"><span class="mtop"><span class="t">${esc(i.t)}</span><span class="ld num ${i.s}">${i.s === "none" ? "nincs megadva" : esc(i.txt)}</span></span>
      ${i.frac == null ? `<span class="s">${esc(i.sub)}</span>` : `<span class="meter"><i class="${i.s}" style="width:${Math.max(3, Math.round(i.frac * 100))}%"></i></span><span class="s">${esc(i.sub)}</span>`}</span>${CHEV}</button>`;
}
// Lejáratok hónapok szerint csoportosítva: pötty, név, jobbra dátum és hátralévő napok
function timeline(list) {
  const dated = list.filter(i => i.date).sort((a, b) => a.date.localeCompare(b.date));
  const undated = list.filter(i => !i.date);
  const row = i => lrowHtml(i);
  const groups = [];
  for (const i of dated) {
    const m = monthLabel(i.date);
    if (!groups.length || groups[groups.length - 1].m !== m) groups.push({ m, items: [] });
    groups[groups.length - 1].items.push(i);
  }
  if (undated.length) groups.push({ m: "Nincs megadva", items: undated });
  return `<div class="lgroups">${groups.map(g => `<div class="lgroup"><p class="lmonth">${g.m}</p><div class="rows">${g.items.map(row).join("")}</div></div>`).join("")}</div>`;
}

function renderDocs(c, list) {
  return staleBanner() + `<section class="section"><h2 class="h">Lejáratok <small>${esc(c.plate || "")}</small></h2>
    ${timeline(list.filter(i => !i.service))}
    <button class="btn wide" data-act="calcar">Lejáratok a Naptárba</button>
    <button class="btn quiet wide" data-act="addcustom">Saját emlékeztető hozzáadása</button>
    <p class="hint">A Naptárba került eseménynél ${THE_PHONE} ${remindText()} szól előre. Ha módosítasz egy dátumot, add hozzá újra azt az egy tételt.</p></section>
    <section class="lgroup"><h2 class="lmonth">Karbantartás</h2><div class="rows">${list.filter(i => i.service).map(meterRowHtml).join("")}</div></section>
    <section class="section"><h2 class="h">Személyes <small>minden autónál ugyanaz</small></h2>
    ${timeline(personalItems())}
    <button class="btn quiet wide" data-act="calpersonal">Személyes lejáratok a Naptárba</button></section>`;
}

function renderLog(c) {
  const seg = `<div class="segbar" role="tablist">${[["service", "Szerviz"], ["fuel", "Tankolás"], ["costs", "Költségek"]].map(([k, l]) =>
    `<button role="tab" aria-pressed="${logView === k}" data-lv="${k}">${l}</button>`).join("")}</div>`;
  if (logView === "fuel") return seg + renderFuel(c);
  if (logView === "costs") return seg + renderCosts(c);
  return seg + renderService(c);
}

function renderService(c) {
  const list = [...c.log].sort((a, b) => b.date.localeCompare(a.date) || b.km - a.km);
  const year = String(today().getFullYear());
  const totalYear = list.filter(e => e.date.startsWith(year)).reduce((s, e) => s + Number(e.cost || 0), 0);
  const total = list.reduce((s, e) => s + Number(e.cost || 0), 0);
  return `<section class="section"><h2 class="h">Szervizkönyv <button class="btn" data-act="addlog">Új bejegyzés</button></h2>
    <div class="rows">${list.length ? list.map(entryHtml).join("")
      : `<div class="empty">Még nincs bejegyzés. A következő szerviz után add hozzá az „Új bejegyzés” gombbal.</div>`}</div>
    ${list.length ? `<div class="sum num"><span>${year}-ban ${fmtMoney(totalYear)}</span><span>Összesen ${fmtMoney(total)}, ${list.length} bejegyzés</span></div>` : ""}</section>`;
}

/* ---------- tankolás ---------- */
// Fogyasztás tele tank nélkül: az első tankolás utáni összes liter / az első és az utolsó tankolás közötti km.
// Egy-egy tankolásnál a tank szintje torzít, de sok tankolás után ez kiegyenlítődik.
function consumption(fills) {
  if (fills.length < 2) return null;
  const km = fills[fills.length - 1].km - fills[0].km;
  if (km < 300) return null; // túl rövid táv, még nem mond semmit
  const liters = fills.slice(1).reduce((s, f) => s + Number(f.liters), 0);
  return liters / km * 100;
}
function fuelStats(c) {
  const fills = [...c.fuel].sort((a, b) => a.km - b.km || a.date.localeCompare(b.date));
  const gap = {};
  fills.forEach((f, i) => { if (i) gap[f.id] = f.km - fills[i - 1].km; });
  // utóbbi időszak: a végéről visszafelé legalább 1500 km-nyi tankolás
  let start = fills.length - 1;
  while (start > 0 && fills[fills.length - 1].km - fills[start].km < 1500) start--;
  const recentFills = fills.slice(start);
  const avg = consumption(fills);
  const recent = recentFills.length < fills.length ? consumption(recentFills) : null;
  return { gap, avg, recent, totalKm: fills.length > 1 ? fills[fills.length - 1].km - fills[0].km : 0 };
}
const fmtL = n => n.toLocaleString("hu-HU", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

function renderFuel(c) {
  const st = fuelStats(c);
  const list = [...c.fuel].sort((a, b) => b.date.localeCompare(a.date) || b.km - a.km);
  const year = String(today().getFullYear());
  const yearCost = c.fuel.filter(f => f.date.startsWith(year) && !f.covered).reduce((s, f) => s + Number(f.cost || 0), 0);
  const yearCovered = c.fuel.filter(f => f.date.startsWith(year) && f.covered).reduce((s, f) => s + Number(f.cost || 0), 0);
  let h = `<section class="section"><h2 class="h">Tankolás <button class="btn" data-act="addfuel">Új tankolás</button></h2>`;
  if (list.length) h += `<div class="stats">
      <div><span class="big num">${st.avg != null ? fmtL(st.avg) : "–"}</span><span class="s">átlag l/100 km</span></div>
      <div><span class="big num">${st.recent != null ? fmtL(st.recent) : "–"}</span><span class="s">utóbbi 1500 km</span></div>
      <div><span class="big num">${yearCost.toLocaleString("hu-HU")}</span><span class="s">saját lej ${year}-ban</span></div></div>
    ${yearCovered ? `<p class="hint num">Céges kártyával fedezve ${year}-ban: ${fmtMoney(yearCovered)}. Ez nem számít bele a költségeidbe.</p>` : ""}`;
  h += `<div class="rows">${list.length ? list.map(f => `<button class="svc" data-fuel="${f.id}">
      <span class="svc-main"><span class="t num">${fmtL(Number(f.liters))} l${f.cost ? `, ${fmtMoney(f.cost)}` : ""}${f.covered ? ' <span class="tag covered">fedezve</span>' : ""}</span>
      <span class="s num">${fmtDate(f.date)}, ${fmtKm(f.km)}${f.cost && f.liters ? `, ${(f.cost / f.liters).toLocaleString("hu-HU", { maximumFractionDigits: 2 })} lej/l` : ""}${f.station ? ", " + esc(f.station) : ""}</span></span>
      ${st.gap[f.id] != null ? `<span class="cons num">+${st.gap[f.id].toLocaleString("hu-HU")}<small>km</small></span>` : ""}</button>`).join("")
    : `<div class="empty">Még nincs tankolás. Pár tankolás után már a fogyasztást is látod.</div>`}</div>
    <p class="hint">Nem kell tele tankolni: a fogyasztást az összes tankolt literből és a megtett km-ből becsüli, ezért minél több tankolás van beírva, annál pontosabb${st.totalKm ? ` (most ${fmtKm(st.totalKm)} alapján)` : ""}. Minden tankolás a km-órát is frissíti.</p></section>`;
  return h;
}

function fuelForm(c, f) {
  const isNew = !f; f = f || { date: iso(today()), km: c.km, full: true };
  const form = sheet(`<h2>${isNew ? "Új tankolás" : "Tankolás"}</h2>
    <div class="row2">${field("date", "Dátum", `type="date" required value="${v(f.date)}"`)}${field("km", "Km-állás", `type="number" inputmode="numeric" required min="0" value="${v(f.km)}"`)}</div>
    <div class="row2">${field("liters", "Liter", `type="number" inputmode="decimal" step="any" required min="0.1" value="${v(f.liters)}"`)}${field("cost", "Fizetve (lej)", `type="number" inputmode="decimal" step="any" value="${v(f.cost || "")}"`)}</div>
    ${field("station", "Benzinkút", `value="${v(f.station)}" placeholder="pl. OMV Florești"`)}
    <label class="check"><input type="checkbox" id="f-covered" name="covered" ${f.covered ? "checked" : ""}><span>Fedezve (céges kártyával fizettem, nem az én költségem)</span></label>`,
    d => {
      const data = { date: d.date, km: Number(d.km), liters: Number(d.liters), cost: d.cost ? Number(d.cost) : 0, station: d.station.trim(), full: f.full !== false, covered: !!d.covered };
      if (isNew) c.fuel.push({ id: uid(), ...data }); else Object.assign(f, data);
      if (data.km > c.km) { c.km = data.km; c.kmDate = data.date; }
      if (isNew) toast("Tankolás mentve.");
    },
    isNew ? "" : `<button type="button" class="btn danger" data-del>Törlés</button>`);
  if (!isNew) form.querySelector("[data-del]").onclick = () => confirmIn(form, "Törlöd ezt a tankolást?", () => { c.fuel = c.fuel.filter(x => x.id !== f.id); });
}

/* ---------- költségek ---------- */
function yearCosts(c, year) {
  const by = Object.fromEntries(Object.keys(COST_CATS).map(k => [k, 0]));
  let covered = 0;
  c.fuel.forEach(f => { if (f.date.startsWith(year)) { if (f.covered) covered += Number(f.cost || 0); else by.fuel += Number(f.cost || 0); } });
  c.log.forEach(e => { if (e.date.startsWith(year)) by.service += Number(e.cost || 0); });
  c.costs.forEach(x => { if (x.date.startsWith(year)) by[x.cat in by ? x.cat : "other"] += Number(x.amount || 0); });
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  // megtett km az évben a tankolások és szervizek km-állásaiból (közelítés)
  const kms = [...c.fuel, ...c.log].filter(e => e.date.startsWith(year)).map(e => Number(e.km));
  const driven = kms.length > 1 ? Math.max(...kms) - Math.min(...kms) : 0;
  return { by, total, driven, covered };
}
function costYears(c) {
  const ys = new Set([String(today().getFullYear())]);
  [...c.fuel, ...c.log].forEach(e => ys.add(e.date.slice(0, 4)));
  c.costs.forEach(x => ys.add(x.date.slice(0, 4)));
  return [...ys].sort().reverse();
}
function renderCosts(c) {
  const years = costYears(c);
  if (!years.includes(costYear)) costYear = years[0];
  const y = yearCosts(c, costYear);
  const rows = Object.entries(y.by).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const max = rows.length ? rows[0][1] : 1;
  let h = `<section class="section"><div class="years">${years.map(yr => `<button class="toggle" aria-pressed="${yr === costYear}" data-year="${yr}">${yr}</button>`).join("")}</div>
    <div class="costhead"><span class="big num">${fmtMoney(y.total)}</span>
    <span class="hint num">${costYear}-ban összesen${y.driven > 500 && y.total ? `, kb. ${(y.total / y.driven).toLocaleString("hu-HU", { maximumFractionDigits: 2 })} lej/km (${fmtKm(y.driven)} alapján)` : ""}</span>
    ${y.covered ? `<span class="hint num">Céges kártyával fedezett tankolás: ${fmtMoney(y.covered)}, ez nincs benne.</span>` : ""}</div>`;
  h += rows.length ? `<div class="rows bars" role="table" aria-label="Költségek kategóriánként, ${costYear}">${rows.map(([k, val]) => `<div class="bar" role="row">
      <span class="bl" role="cell">${COST_CATS[k]}</span>
      <span class="bt" role="presentation"><span style="width:${Math.max(2, val / max * 100)}%"></span></span>
      <span class="bv num" role="cell">${val.toLocaleString("hu-HU")} lej <small>${Math.round(val / y.total * 100)}%</small></span></div>`).join("")}</div>`
    : `<div class="rows"><div class="empty">${costYear}-ban még nincs rögzített kiadás.</div></div>`;
  h += `</section>`;
  const manual = c.costs.filter(x => x.date.startsWith(costYear)).sort((a, b) => b.date.localeCompare(a.date));
  h += `<section class="section"><h2 class="h">Egyéb kiadások <button class="btn" data-act="addcost">Új kiadás</button></h2>
    <div class="rows">${manual.length ? manual.map(x => `<button class="svc" data-cost="${x.id}"><span class="svc-main">
      <span class="t">${COST_CATS[x.cat] || "Egyéb"}${x.note ? `: ${esc(x.note)}` : ""}</span><span class="s num">${fmtDate(x.date)}</span></span>
      <span class="cost num">${fmtMoney(x.amount)}</span></button>`).join("")
      : `<div class="empty">RCA, rovinieta, ITP, adó vagy bármi más (pl. mosás, parkolás).</div>`}</div>
    <p class="hint">A tankolások, a szervizek és a megújítások ára magától bekerül.</p></section>`;
  const pers = S.personal.costs.filter(x => x.date.startsWith(costYear));
  if (pers.length) h += `<section class="section"><h2 class="h">Személyes <small>nem autóhoz kötött</small></h2><div class="rows">${pers.map(x =>
    `<div class="svc"><span class="svc-main"><span class="t">${PERSONAL_TYPES.find(t => t[0] === x.cat)?.[1] || "Egyéb"}</span><span class="s num">${fmtDate(x.date)}</span></span><span class="cost num">${fmtMoney(x.amount)}</span></div>`).join("")}</div></section>`;
  return h;
}
function costForm(c, x) {
  const isNew = !x; x = x || { date: iso(today()), cat: "rca" };
  const form = sheet(`<h2>${isNew ? "Új kiadás" : "Kiadás"}</h2>
    <label class="field"><span class="label">Mire</span><select id="f-cat" name="cat">${MANUAL_CATS.map(k => `<option value="${k}" ${x.cat === k ? "selected" : ""}>${COST_CATS[k]}</option>`).join("")}</select></label>
    <div class="row2">${field("amount", "Összeg (lej)", `type="number" inputmode="decimal" step="any" required min="0" value="${v(x.amount)}"`)}${field("date", "Dátum", `type="date" required value="${v(x.date)}"`)}</div>
    ${field("note", "Megjegyzés", `value="${v(x.note)}" placeholder="pl. Allianz, 12 hónap"`)}`,
    d => {
      const data = { cat: d.cat, amount: Number(d.amount), date: d.date, note: d.note.trim() };
      if (isNew) c.costs.push({ id: uid(), ...data }); else Object.assign(x, data);
      costYear = data.date.slice(0, 4);
    },
    isNew ? "" : `<button type="button" class="btn danger" data-del>Törlés</button>`);
  if (!isNew) form.querySelector("[data-del]").onclick = () => confirmIn(form, "Törlöd ezt a kiadást?", () => { c.costs = c.costs.filter(y => y.id !== x.id); });
}

function remindText() {
  const r = [...S.settings.remind].sort((a, b) => b - a);
  return r.length ? r.join(", ") + " nappal" : "nem";
}

function renderSettings() {
  const r = S.settings.remind, theme = S.settings.theme || "system";
  const T = {
    system: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    dark: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  };
  const check = '<svg class="chk" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const group = (title, body, note = "") => `<section class="lgroup"><h2 class="lmonth">${title}</h2><div class="rows">${body}</div>${note ? `<p class="setnote">${note}</p>` : ""}</section>`;
  return `<h1 class="pagetitle">Beállítások</h1>
  <div class="setlist">
    <section class="lgroup"><h2 class="lmonth">Megjelenés</h2>
      <div class="segbar theme" role="radiogroup" aria-label="Megjelenés">${[["system", "Rendszer"], ["light", "Világos"], ["dark", "Sötét"]].map(([k, l]) =>
        `<button role="radio" aria-checked="${theme === k}" aria-pressed="${theme === k}" data-theme-set="${k}"><svg viewBox="0 0 24 24" aria-hidden="true">${T[k]}</svg>${l}</button>`).join("")}</div>
      <p class="setnote">${theme === "system" ? (ANDROID ? "A telefon" : "Az iPhone") + " beállítását követi, este magától sötétre vált." : theme === "dark" ? "Mindig sötét." : "Mindig világos."}</p></section>

    ${group("Autók", S.cars.map(c => `<button class="lrow" data-caredit="${c.id}">
        <span class="miniplate"><i>RO</i><b>${esc(c.plate || "–")}</b></span>
        <span class="lt"><span class="t">${esc(c.name)}</span><span class="s">${esc(c.model || "")}${c.year ? ", " + esc(c.year) : ""}</span></span>${CHEV}</button>`).join("") +
      `<button class="lrow" data-act="addcar"><span class="lt"><span class="t act">Új autó hozzáadása</span></span>${CHEV}</button>`)}

    ${group("Naptár emlékeztetők", REMIND_OPTIONS.map(d => `<button class="lrow" role="menuitemcheckbox" aria-checked="${r.includes(d)}" data-remind="${d}">
        <span class="lt"><span class="t">${d === 1 ? "1 nappal előtte" : d + " nappal előtte"}</span></span>${check}</button>`).join("") +
      `<button class="lrow" data-act="calall"><span class="lt"><span class="t act">Minden lejárat a Naptárba</span><span class="s">autók és személyes iratok</span></span>${CHEV}</button>`,
      "A Naptár reggel 9-kor szól. Dátumváltozás után add hozzá újra.")}

    ${group("Biztonsági mentés", `<button class="lrow" data-act="export" ${S.cars.length ? "" : "disabled"}>
        <span class="lt"><span class="t act">Mentés készítése</span><span class="s">${S.lastBackup ? "Utolsó mentés: " + fmtDate(S.lastBackup) : "Még nem készült mentés"}</span></span>${CHEV}</button>
      <button class="lrow" data-act="import"><span class="lt"><span class="t">Visszaállítás mentésből</span></span>${CHEV}</button>`,
      "Az adatok csak ezen a telefonon vannak. Néha ments a Fájlokba vagy az iCloud Drive-ra.")}

    <p class="appfoot">Garázs napló ${APP_VERSION}</p>
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
    if (onSave(f) !== false) { save(); closeSheet(); render(); checkStaleAfterSave(); }
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
        S.cars.push({ id, ...data, kmDate: iso(today()), docs: {}, notes: {}, log: [], custom: [], fuel: [], costs: [],
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
    const form = sheet(`<h2>${def.t}</h2>
      <button type="button" class="btn wide" data-renew>${def.t} megtörtént: új csere rögzítése</button>
      <p class="hint">Vagy javítsd a mostani adatokat. ${def.hint} Amelyik előbb jön, a km vagy az idő, az számít.</p>
      <div class="row2">${field("date", "Utolsó csere", `type="date" required value="${v(o.date)}"`)}${field("km", "Km-állás akkor", `type="number" inputmode="numeric" required value="${v(o.km)}"`)}</div>
      <div class="row2">${field("everyKm", "Csere km-enként", `type="number" inputmode="numeric" required value="${v(o.everyKm)}"`)}${field("everyMonths", "vagy hónaponként", `type="number" inputmode="numeric" required value="${v(o.everyMonths)}"`)}</div>`,
      f => { c[k] = { date: f.date, km: Number(f.km), everyKm: Number(f.everyKm), everyMonths: Number(f.everyMonths) }; },
      o.date ? `<button type="button" class="btn ghost" data-cal>Naptárba</button>` : "");
    const cal = form.querySelector("[data-cal]");
    if (cal) cal.onclick = () => exportCalendar([c], k);
    form.querySelector("[data-renew]").onclick = () => serviceSwapForm(c, k);
    return;
  }
  if (k.startsWith("p:")) return personalForm(k.slice(2));
  if (k.startsWith("c:")) {
    const x = c.custom.find(y => "c:" + y.id === k);
    return customForm(c, x);
  }
  const t = DOC_TYPES.find(d => d[0] === k);
  const hist = c.costs.filter(x => x.cat === k).sort((a, b) => b.date.localeCompare(a.date));
  const form = sheet(`<h2>${t[1]}</h2><p class="hint">${t[2]}, ${esc(c.name)}${c.docs[k] ? `: ${fmtDate(c.docs[k])}, ${daysText(c.docs[k])}` : ""}</p>
    <button type="button" class="btn wide" data-renew>Megújítás: új lejárat és ár</button>
    <p class="hint">Vagy javítsd a mostani adatokat:</p>
    ${field("exp", "Lejárat dátuma", `type="date" value="${v(c.docs[k])}"`)}
    ${field("note", "Megjegyzés", `value="${v(c.notes[k])}" placeholder="pl. biztosító, kötvényszám"`)}
    <p class="hint">Hagyd üresen a dátumot, ha erre az autóra nem vonatkozik.</p>
    ${historyHtml(hist)}`,
    f => { c.docs[k] = f.exp; c.notes[k] = f.note.trim(); },
    c.docs[k] ? `<button type="button" class="btn ghost" data-cal>Naptárba</button>` : "");
  const cal = form.querySelector("[data-cal]");
  if (cal) cal.onclick = () => exportCalendar([c], k);
  form.querySelector("[data-renew]").onclick = () => renewForm({
    title: `${t[1]} megújítása`, sub: esc(c.name), old: c.docs[k], months: RENEW_MONTHS[k], presets: PRESETS[k], note: c.notes[k], fromToday: k === "itp",
    save: f => { c.docs[k] = f.exp; c.notes[k] = f.note; c.costs.push({ id: uid(), cat: k, amount: f.amount, date: f.paid, note: f.note }); }
  });
}

function personalForm(k) {
  const t = PERSONAL_TYPES.find(d => d[0] === k), P = S.personal;
  const hist = P.costs.filter(x => x.cat === k).sort((a, b) => b.date.localeCompare(a.date));
  const form = sheet(`<h2>${t[1]}</h2><p class="hint">${t[2]}, személyes${P.docs[k] ? `: ${fmtDate(P.docs[k])}, ${daysText(P.docs[k])}` : ""}</p>
    <button type="button" class="btn wide" data-renew>Megújítás: új lejárat és ár</button>
    <p class="hint">Vagy javítsd a mostani adatokat:</p>
    ${field("exp", "Lejárat dátuma", `type="date" value="${v(P.docs[k])}"`)}
    ${field("note", "Megjegyzés", `value="${v(P.notes[k])}" placeholder="pl. kategóriák: B"`)}
    ${historyHtml(hist)}`,
    f => { P.docs[k] = f.exp; P.notes[k] = f.note.trim(); },
    P.docs[k] ? `<button type="button" class="btn ghost" data-cal>Naptárba</button>` : "");
  const cal = form.querySelector("[data-cal]");
  if (cal) cal.onclick = () => exportCalendar([], "p:" + k, true);
  form.querySelector("[data-renew]").onclick = () => renewForm({
    title: `${t[1]} megújítása`, sub: "személyes", old: P.docs[k], months: RENEW_MONTHS[k], note: P.notes[k],
    costHint: "Az ár a személyes kiadások közé kerül, nem egy autóhoz.",
    save: f => { P.docs[k] = f.exp; P.notes[k] = f.note; P.costs.push({ id: uid(), cat: k, amount: f.amount, date: f.paid, note: f.note }); }
  });
}

/* ---------- megújítás / csere ---------- */
const RENEW_MONTHS = { rca: 12, rov: 12, itp: 24, tax: 12, license: 120, idcard: 120, passport: 120 };
// gyors időtartam-gombok: [felirat, hónap, nap]
const PRESETS = {
  rca: [["1 hónap", 1], ["6 hónap", 6], ["12 hónap", 12]],
  rov: [["30 nap", 0, 30], ["90 nap", 0, 90], ["12 hónap", 12]],
  itp: [["1 év", 12], ["2 év", 24]],
};
function addPeriod(base, months, days) {
  const d = parseDate(base);
  if (months) d.setMonth(d.getMonth() + months);
  if (days) d.setDate(d.getDate() + days);
  return iso(d);
}
// a régi lejárattól számol, ha az még nem múlt el; különben mától
const renewBase = old => old && parseDate(old) >= today() ? old : iso(today());

function historyHtml(list) {
  if (!list.length) return "";
  return `<div class="hist"><span class="label">Korábbi megújítások</span>${list.slice(0, 5).map(x =>
    `<div class="hrow num"><span>${fmtDate(x.date)}${x.note ? ", " + esc(x.note) : ""}</span><b>${fmtMoney(x.amount)}</b></div>`).join("")}</div>`;
}

function renewForm(o) {
  // ITP-nél az új érvényesség a vizsga napjától számít, a többinél a régi lejárattól
  const base = o.fromToday ? iso(today()) : renewBase(o.old);
  const form = sheet(`<h2>${esc(o.title)}</h2>
    <p class="hint">${o.sub}${o.old ? `, eddig: ${fmtDate(o.old)}` : ""}${o.fromToday ? ". Az új érvényesség a vizsga napjától, mától számít." : ""}</p>
    ${o.presets ? `<div class="presets">${o.presets.map(([l, m, d]) => `<button type="button" class="toggle" data-m="${m || 0}" data-d="${d || 0}">${l}</button>`).join("")}</div>` : ""}
    ${field("exp", "Új lejárat", `type="date" required value="${addPeriod(base, o.months)}"`)}
    <div class="row2">${field("amount", "Ár (lej)", `type="number" inputmode="decimal" step="any" min="0" required`)}${field("paid", "Fizetve", `type="date" required value="${iso(today())}"`)}</div>
    ${field("note", "Megjegyzés", `value="${v(o.note)}" placeholder="pl. biztosító neve"`)}
    <p class="hint">${o.costHint || "Az ár magától bekerül a Napló / Költségek közé."}</p>`,
    f => {
      o.save({ exp: f.exp, amount: Number(f.amount), paid: f.paid, note: f.note.trim() });
      toast(`Megújítva, új lejárat: ${fmtDate(f.exp)}`);
    });
  form.querySelectorAll("[data-m]").forEach(b => b.onclick = () => {
    form.querySelector("#f-exp").value = addPeriod(base, Number(b.dataset.m), Number(b.dataset.d));
    form.querySelectorAll("[data-m]").forEach(x => x.setAttribute("aria-pressed", x === b));
  });
  setTimeout(() => form.querySelector("#f-amount").focus(), 50);
}

function serviceSwapForm(c, k) {
  const def = SERVICES[k];
  sheet(`<h2>${def.t}: új csere</h2><p class="hint">${esc(c.name)}. Bekerül a szervizkönyvbe, és innen számolja a következőt.</p>
    <div class="row2">${field("date", "Dátum", `type="date" required value="${iso(today())}"`)}${field("km", "Km-állás", `type="number" inputmode="numeric" required min="0" value="${c.km}"`)}</div>
    <div class="row2">${field("cost", "Ár (lej)", `type="number" inputmode="decimal" step="any" min="0" required`)}${field("place", "Szerviz neve", "")}</div>
    ${field("title", "Mit csináltak", `value="${def.t}${k === "oil" ? " és szűrők" : ""}" required`)}`,
    f => {
      const km = Number(f.km);
      c.log.push({ id: uid(), date: f.date, km, title: f.title.trim(), place: f.place.trim(), cost: Number(f.cost) });
      c[k] = { ...c[k], date: f.date, km };
      if (km > c.km) { c.km = km; c.kmDate = f.date; }
      toast(`${def.t} rögzítve. A következő: ${fmtKm(km + Number(c[k].everyKm))}.`);
    });
}

function customKmRenew(c, x) {
  sheet(`<h2>${esc(x.title)}: megtörtént</h2><p class="hint">${esc(c.name)}, most ${fmtKm(c.km)}</p>
    ${field("km", "Következő figyelmeztetés ennél a km-nél", `type="number" inputmode="numeric" required min="0" value="${Number(c.km) + Math.max(1000, Number(x.km) - Number(x.startKm ?? x.km))}"`)}
    <div class="row2">${field("amount", "Ár (lej)", `type="number" inputmode="decimal" step="any" min="0" required`)}${field("paid", "Dátum", `type="date" required value="${iso(today())}"`)}</div>
    <p class="hint">Az ár magától bekerül a Napló / Költségek közé.</p>`,
    f => {
      x.km = Number(f.km); x.startKm = Number(c.km);
      c.costs.push({ id: uid(), cat: "other", amount: Number(f.amount), date: f.paid, note: x.title });
      toast("Rögzítve.");
    });
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
    <div data-mode="date">${field("date", "Dátum", `type="date" value="${v(x.date)}"`)}${x.date ? `<p class="hint num" style="margin-top:4px">${daysText(x.date)}</p>` : ""}</div>
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
  if (!isNew) {
    const rb = document.createElement("button");
    rb.type = "button"; rb.className = "btn wide"; rb.textContent = mode === "km" ? "Megtörtént: új km és ár" : "Megújítás: új dátum és ár";
    form.querySelector("h2").after(rb);
    rb.onclick = () => mode === "km" ? customKmRenew(c, x) : renewForm({
      title: `${x.title}: megújítás`, sub: esc(c.name), old: x.date, months: 12, note: x.note,
      save: f => { x.date = f.exp; x.note = f.note; c.costs.push({ id: uid(), cat: "other", amount: f.amount, date: f.paid, note: x.title }); }
    });
  }
  const cal = form.querySelector("[data-cal]");
  if (cal) cal.onclick = () => exportCalendar([c], "c:" + x.id);
  const sync = () => {
    const m = form.querySelector('input[name="mode"]:checked').value;
    form.querySelectorAll("[data-mode]").forEach(el => { el.hidden = el.dataset.mode !== m; });
  };
  form.querySelectorAll('input[name="mode"]').forEach(r => r.addEventListener("change", sync));
  sync();
  if (!isNew) {
    form.querySelector("[data-del]").onclick = () => confirmIn(form, "Törlöd ezt az emlékeztetőt?", () => { c.custom = c.custom.filter(y => y.id !== x.id); });
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
    // állandó azonosító (dátum nélkül) és növekvő sorszám, hogy az iPhone frissítse a meglévő eseményt
    L.push("BEGIN:VEVENT", `UID:${ev.uid}@garazs-naplo`, `DTSTAMP:${stamp}`, `SEQUENCE:${Math.floor(Date.now() / 60000) - 29000000}`,
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
function calendarEvents(cars, only, personal) {
  const evs = [];
  if (personal) for (const i of personalItems()) {
    if (only && i.k !== only) continue;
    if (!i.date || (!only && i.s === "bad" && dateStatus(i.date).d < -1)) continue;
    evs.push({ uid: `personal-${i.k.slice(2)}`, date: i.date, title: `${i.t} lejár`, desc: `${i.sub}\nGarázs napló`, s: i.s });
  }
  for (const c of cars) {
    const label = c.plate ? `${c.name} (${c.plate})` : c.name;
    for (const i of items(c)) {
      if (only && i.k !== only) continue;
      if (!i.date) continue; // a km szerinti emlékeztetőnek nincs dátuma, az csak az appban jelez
      if (!only && i.s === "bad" && dateStatus(i.date).d < -1) continue; // régen lejártat nem rakunk be
      const verb = SERVICES[i.k] ? "esedékes" : i.k.startsWith("c:") ? "" : "lejár";
      evs.push({ uid: `${c.id}-${i.k.replace(":", "-")}`, date: i.date, s: i.s,
        title: `${i.t}${verb ? " " + verb : ""} – ${c.name}`,
        desc: `${label}\n${SERVICES[i.k] ? SERVICES[i.k].t + ": " + i.sub : i.sub}\nGarázs napló` });
    }
  }
  return evs;
}
/* ---------- Naptárba adás: előnézet, majd egy gombbal a fájl ---------- */
function exportCalendar(cars, only, personal, keys, update) {
  let evs = calendarEvents(cars, only, personal);
  if (keys) evs = evs.filter(e => keys.has(e.uid));
  if (!evs.length) { toast("Nincs olyan dátum, amit a Naptárba lehetne tenni."); return; }
  evs.sort((a, b) => a.date.localeCompare(b.date));
  const r = [...S.settings.remind].sort((a, b) => b - a);
  const when = r.length ? `${r.join(", ").replace(/, (\d+)$/, " és $1")} nappal előtte, és a lejárat napján, reggel 9-kor` : "a lejárat napján reggel 9-kor";
  const sent = S.calSent || {};
  const el = $("#sheet");
  el.innerHTML = `<div class="sheet-bg"><div class="sheet calsheet" role="dialog" aria-label="Naptárba">
    <div class="imghead"><div><h2>${update ? "Frissítés a Naptárban" : "Naptárba"}</h2><p class="hint">${update ? "A dátum megváltozott. A Naptárban a régi esemény magától lecserélődik az újra." : (evs.length === 1 ? "1 esemény" : evs.length + " esemény") + " kerül " + (ANDROID ? "a telefon naptárába" : "az iPhone Naptárába")}</p></div>
      <button type="button" class="vw-btn light" data-x aria-label="Bezárás">${'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>'}</button></div>
    <div class="rows calrows">${evs.map(e => `<div class="lrow"><span class="ldot ${e.s || "ok"}"></span>
      <span class="lt"><span class="t">${esc(e.title)}</span>${sent[e.uid] && sent[e.uid].date !== e.date ? `<span class="s">a Naptárban most: ${fmtDate(sent[e.uid].date)}, ez lecserélődik</span>` : sent[e.uid] ? `<span class="s">már a Naptárban van</span>` : ""}</span>
      <span class="ld num">${fmtDate(e.date)}<small>${daysText(e.date)}</small></span>
      ${ANDROID ? `<a class="gcal" href="${googleCalUrl(e)}" target="_blank" rel="noopener" data-g="${esc(e.uid)}" aria-label="${esc(e.title)} a Google Naptárba">Google</a>` : ""}</div>`).join("")}</div>
    <div class="calwhen"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>
      <span>Értesítés ${when}. <button type="button" class="link" data-remset>Módosítás</button></span></div>
    ${ANDROID ? `<p class="hint"><b>Pixel, Xiaomi és a legtöbb Android (Google Naptár):</b> koppints a sorok melletti Google gombra, eseményenként, és ott mentsd el.${update ? " A régit előbb töröld a naptárból, mert a Google Naptár nem cseréli le magától." : ""} A Google Naptár a saját alapértelmezett értesítését használja.</p>` : ""}
    <button type="button" class="btn wide" data-go>${ANDROID ? "Naptárfájl letöltése (Samsung Naptár)" : update ? "Frissítés a Naptárban" : "Hozzáadás a Naptárhoz"}</button>
    <p class="hint">${ANDROID ? "<b>Samsung Naptár:</b> nyisd meg a letöltött fájlt, és mentsd a naptárba. Így az értesítések is beállítva érkeznek." : "A megnyíló ablakban válaszd az <b>Összes hozzáadása</b> lehetőséget."}</p>
  </div></div>`;
  const close = () => closeSheet();
  el.querySelector(".sheet-bg").addEventListener("click", e => { if (e.target.classList.contains("sheet-bg")) close(); });
  el.querySelector("[data-x]").onclick = close;
  el.querySelector("[data-remset]").onclick = () => { close(); tab = "settings"; render(); window.scrollTo(0, 0); };
  // Google Naptár gombok: a megnyitott eseményt is Naptárba tettnek tekintjük
  el.querySelectorAll("[data-g]").forEach(a => a.addEventListener("click", () => {
    const e = evs.find(x => x.uid === a.dataset.g); if (!e) return;
    S.calSent = S.calSent || {}; S.calSent[e.uid] = { date: e.date, title: e.title }; save();
    a.textContent = "Kész"; a.classList.add("done");
  }));
  el.querySelector("[data-go]").onclick = () => {
    deliverFile(only ? "garazs-emlekezteto.ics" : "garazs-lejaratok.ics", "text/calendar", buildIcs(evs), true);
    S.calSent = S.calSent || {};
    for (const e of evs) S.calSent[e.uid] = { date: e.date, title: e.title };
    save(); close(); render();
  };
}

// Google Naptár esemény-sablon link (Androidon a Google Naptár nem tud naptárfájlt megnyitni)
function googleCalUrl(e) {
  const d = parseDate(e.date), n = parseDate(e.date); n.setDate(n.getDate() + 1);
  const ymd = x => iso(x).replace(/-/g, "");
  return "https://calendar.google.com/calendar/render?action=TEMPLATE" +
    "&text=" + encodeURIComponent(e.title) + "&dates=" + ymd(d) + "/" + ymd(n) + "&details=" + encodeURIComponent(e.desc || "");
}

/* ---------- a Naptárban maradt régi dátumok ---------- */
// minden tétel jelenlegi dátuma az állandó azonosító szerint
function currentCalDates() {
  const m = {};
  for (const e of calendarEvents(S.cars, null, true)) m[e.uid] = e.date;
  for (const c of S.cars) for (const i of items(c)) if (i.date) m[`${c.id}-${i.k.replace(":", "-")}`] = i.date;
  for (const i of personalItems()) if (i.date) m[`personal-${i.k.slice(2)}`] = i.date;
  return m;
}
function staleCal() {
  const sent = S.calSent || {}, cur = currentCalDates(), out = [];
  const yesterday = iso(new Date(today().getTime() - DAY));
  for (const [uid, x] of Object.entries(sent)) {
    if (cur[uid] === x.date) continue;
    if (x.date < yesterday) { delete sent[uid]; continue; } // a már elmúlt események nem zavarnak
    out.push({ uid, old: x.date, title: x.title, now: cur[uid] || "" });
  }
  return out;
}
let staleShown = "";
function staleBanner() {
  const st = staleCal();
  if (!st.length) return "";
  const upd = st.filter(x => x.now);
  return `<button class="calwarn" data-act="stale"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4M15 3v4M12 13v5M9.5 15.5L12 18l2.5-2.5"/></svg>
    <span><b>${upd.length ? "Frissítsd a Naptárban" : "Régi dátum maradt a Naptárban"}</b><small>${st.length === 1 ? esc(st[0].title) + (st[0].now ? ", új dátum: " + fmtDate(st[0].now) : "") : st.length + " esemény dátuma megváltozott."} Koppints ide.</small></span></button>`;
}
function staleSheet() {
  const st = staleCal();
  if (!st.length) return;
  staleShown = st.map(x => x.uid + x.old).join("|");
  const upd = st.filter(x => x.now), gone = st.filter(x => !x.now);
  if (upd.length) return exportCalendar(S.cars, null, true, new Set(upd.map(x => x.uid)), true);
  // a dátumot kitörölték: ezt az app nem tudja eltávolítani, csak kézzel lehet
  const form = sheet(`<h2>Törölt dátum a Naptárban</h2>
    <p class="hint">Ezeknek már nincs dátumuk az appban, de a Naptárban még szerepelnek.</p>
    <div class="rows calrows">${gone.map(x => `<div class="lrow"><span class="ldot warn"></span><span class="lt"><span class="t">${esc(x.title)}</span><span class="s">Naptárban: ${fmtDate(x.old)}</span></span></div>`).join("")}</div>
    <div class="steps"><b>Törlés:</b> Naptár app, koppints az eseményre, és legalul: Esemény törlése.</div>`, null,
    `<button type="button" class="btn" data-done>Rendben</button>`);
  form.querySelector("[data-close]").textContent = "Később";
  form.querySelector("[data-done]").onclick = () => { gone.forEach(x => delete S.calSent[x.uid]); save(); closeSheet(); render(); };
}
// mentés után: ha egy már Naptárba tett dátum megváltozott, egyszer rögtön szólunk
function checkStaleAfterSave() {
  const st = staleCal();
  const sig = st.map(x => x.uid + x.old).join("|");
  if (st.length && sig !== staleShown) setTimeout(staleSheet, 350);
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
  let vault = null;
  try { vault = await Vault.exportData(); } catch (e) { toast("Az iratok mappát nem sikerült a mentéshez olvasni."); }
  const data = JSON.stringify({ ...S, lastBackup: undefined, vault, app: "garazs-naplo", exported: new Date().toISOString() });
  const mb = (data.length / 1024 / 1024).toLocaleString("hu-HU", { maximumFractionDigits: 1 });
  // a megosztás ablakot új koppintásból kell nyitni, ezért egy gombbal kérjük
  const form = sheet(`<h2>Mentés kész</h2><p>${S.cars.length} autó${vault ? `, ${vault.files.length} irat (titkosítva)` : ""}, ${mb} MB.</p>
    <p class="hint">Mentsd a Fájlokba vagy az iCloud Drive-ra.${vault ? " Az iratok visszaállításához a mappa PIN-kódja kell." : ""}</p>`, null,
    `<button type="button" class="btn" data-go>Mentés a Fájlokba</button>`);
  form.querySelector("[data-go]").onclick = async () => {
    const ok = await deliverFile(name, "application/json", data, false);
    if (ok) { closeSheet(); S.lastBackup = iso(today()); save(); render(); toast("Mentés kész."); }
  };
}

function importBackup(file) {
  const r = new FileReader();
  r.onload = () => {
    let data;
    try { data = JSON.parse(r.result); } catch (e) { data = null; }
    if (!data || data.app !== "garazs-naplo" || !Array.isArray(data.cars)) {
      toast("Ez a fájl nem Garázs napló mentés."); return;
    }
    const form = sheet(`<h2>Visszaállítás</h2><p>A mentésben ${data.cars.length} autó van (${data.cars.map(c => esc(c.name)).join(", ")})${data.vault ? ` és ${data.vault.files.length} irat` : ""}, készült: ${fmtDate((data.exported || "").slice(0, 10))}.</p>
      <p class="hint">A visszaállítás lecseréli a jelenlegi adatokat.</p>`, null,
      `<button type="button" class="btn" data-yes>Visszaállítás</button>`);
    form.querySelector("[data-yes]").onclick = async () => {
      if (data.vault) { try { await Vault.importData(data.vault); } catch (e) { toast("Az iratokat nem sikerült visszaállítani."); } }
      delete data.app; delete data.exported; delete data.vault;
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
  if (b.dataset.car) { S.sel = b.dataset.car; if (tab === "settings" || tab === "vault") tab = "home"; save(); render(); return; }
  if (b.dataset.tab && !b.dataset.lv) {
    // a Face ID-nak közvetlenül a koppintásból kell indulnia
    if (b.dataset.tab === "vault" && Vault.hasFace() && !Vault.isOpen()) Vault.unlockFace();
    tab = b.dataset.tab; render(); window.scrollTo(0, 0); return; }
  if (b.dataset.edit) { docForm(c, b.dataset.edit); return; }
  if (b.dataset.lv) { logView = b.dataset.lv; if (b.dataset.tab) tab = b.dataset.tab; render(); return; }
  if (b.dataset.fuel) { fuelForm(c, c.fuel.find(x => x.id === b.dataset.fuel)); return; }
  if (b.dataset.cost) { costForm(c, c.costs.find(x => x.id === b.dataset.cost)); return; }
  if (b.dataset.year) { costYear = b.dataset.year; render(); return; }
  if (b.dataset.entry) { logForm(c, c.log.find(x => x.id === b.dataset.entry)); return; }
  if (b.dataset.themeSet) { S.settings.theme = b.dataset.themeSet; applyTheme(); save(); render(); return; }
  if (b.dataset.caredit) { carForm(S.cars.find(x => x.id === b.dataset.caredit)); return; }
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
    case "stale": staleSheet(); break;
    case "calall": exportCalendar(S.cars, null, true); break;
    case "calpersonal": exportCalendar([], null, true); break;
    case "addfuel": fuelForm(c, null); break;
    case "addcost": costForm(c, null); break;
    case "export": exportBackup(); break;
    case "import": $("#importfile").click(); break;
  }
});
$("#importfile").addEventListener("change", e => { const f = e.target.files[0]; if (f) importBackup(f); e.target.value = ""; });

// napváltáskor (pl. másnap megnyitva) frissüljenek a napok
document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
render();
Vault.init();
if (S.movedLicense) { delete S.movedLicense; save(); setTimeout(() => toast("A jogosítványod átkerült a Lejáratok fül Személyes részébe."), 600); }
