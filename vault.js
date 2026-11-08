"use strict";
/* Iratok mappa: képek és PDF-ek titkosítva, Face ID-val vagy 4 jegyű PIN-nel nyitható.
   - A fájlokat egy véletlen mesterkulcs titkosítja (AES-GCM 256).
   - A mesterkulcsot a PIN-ből származtatott kulcs (PBKDF2) és, ha be van kapcsolva,
     a Face ID-s passkey PRF-kimenetéből származtatott kulcs (HKDF) is lezárja.
   - Nyitott állapotban a kulcs csak a memóriában van; zárolás után eldobjuk. */
const Vault = (() => {
  const DB = "garazs-iratok", PIN_ITER = 400000, IDLE_MS = 2 * 60 * 1000;
  const enc = new TextEncoder(), dec = new TextDecoder();
  let meta = null;        // a lezárt kulcsok (betöltve induláskor, hogy a Face ID azonnal indulhasson)
  let master = null;      // nyitott állapotban a mesterkulcs
  let files = [];         // nyitott állapotban a fájlok listája (név, típus, előnézet)
  let pin = "";           // a PIN-billentyűzeten beírt számjegyek
  let idleTimer = null, busy = false, faceBusy = false;

  /* ---------- IndexedDB ---------- */
  function open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { r.result.createObjectStore("files", { keyPath: "id" }); r.result.createObjectStore("meta"); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode), s = t.objectStore(store);
      let out; const r = fn(s); if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => { db.close(); res(out); }; t.onerror = () => { db.close(); rej(t.error); };
    });
  }
  const getMeta = () => tx("meta", "readonly", s => s.get("vault"));
  const putMeta = m => tx("meta", "readwrite", s => s.put(m, "vault"));
  const allFiles = () => tx("files", "readonly", s => s.getAll());
  const putFile = f => tx("files", "readwrite", s => s.put(f));
  const getFile = id => tx("files", "readonly", s => s.get(id));
  const delFile = id => tx("files", "readwrite", s => s.delete(id));

  /* ---------- titkosítás ---------- */
  const rnd = n => crypto.getRandomValues(new Uint8Array(n));
  async function encrypt(key, bytes) { const iv = rnd(12); return { iv, ct: await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes) }; }
  const decrypt = (key, iv, ct) => crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  async function pinKey(p, salt, iter) {
    const base = await crypto.subtle.importKey("raw", enc.encode(p), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function prfKey(bytes) {
    const base = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode("garazs-iratok-faceid") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }
  async function wrapMaster(kek) { return encrypt(kek, await crypto.subtle.exportKey("raw", master)); }
  async function unwrapMaster(kek, w) {
    const raw = await decrypt(kek, w.iv, w.ct);
    return crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
  }

  /* ---------- állapot ---------- */
  async function init() {
    try { meta = await getMeta() || null; } catch (e) { meta = null; }
    if (tab === "vault") render();
  }
  const isSetUp = () => !!meta;
  const isOpen = () => !!master;
  const hasFace = () => !!(meta && meta.face);
  const faceSupported = () => !!(window.PublicKeyCredential && navigator.credentials);

  function lock() {
    master = null; pin = "";
    files.forEach(f => f.thumbUrl && URL.revokeObjectURL(f.thumbUrl)); files = [];
    clearTimeout(idleTimer);
    if (tab === "vault") { closeSheet(); render(); }
  }
  function touch() { clearTimeout(idleTimer); if (master) idleTimer = setTimeout(lock, IDLE_MS); }
  document.addEventListener("visibilitychange", () => { if (document.hidden && master) lock(); });
  ["click", "touchstart", "keydown"].forEach(e => document.addEventListener(e, () => { if (master) touch(); }, { passive: true }));

  async function afterUnlock() {
    pin = ""; failReset();
    await loadList(); touch(); render();
  }
  async function loadList() {
    const recs = await allFiles();
    const list = [];
    for (const r of recs) {
      try {
        const m = JSON.parse(dec.decode(await decrypt(master, r.miv, r.mct)));
        let thumbUrl = "";
        if (r.thumb) thumbUrl = URL.createObjectURL(new Blob([await decrypt(master, r.tiv, r.thumb)], { type: "image/jpeg" }));
        list.push({ id: r.id, created: r.created, ...m, thumbUrl });
      } catch (e) { /* sérült elem: kihagyjuk */ }
    }
    files.forEach(f => f.thumbUrl && URL.revokeObjectURL(f.thumbUrl));
    files = list.sort((a, b) => b.created - a.created);
  }

  /* ---------- PIN hibák korlátozása ---------- */
  const FAIL = "garazs-iratok-fail";
  function failState() { try { return JSON.parse(localStorage.getItem(FAIL)) || { n: 0, until: 0 }; } catch (e) { return { n: 0, until: 0 }; } }
  function failAdd() {
    const f = failState(); f.n++;
    if (f.n >= 5) f.until = Date.now() + 30000 * Math.pow(2, f.n - 5);
    try { localStorage.setItem(FAIL, JSON.stringify(f)); } catch (e) {}
    return f;
  }
  function failReset() { try { localStorage.removeItem(FAIL); } catch (e) {} }

  /* ---------- beállítás és feloldás ---------- */
  async function setup(p) {
    master = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const salt = rnd(16);
    meta = { v: 1, salt, iter: PIN_ITER, pin: await wrapMaster(await pinKey(p, salt, PIN_ITER)), face: null };
    await putMeta(meta);
  }
  async function unlockPin(p) {
    const f = failState();
    if (f.until > Date.now()) { toast(`Túl sok hibás próbálkozás. Várj ${Math.ceil((f.until - Date.now()) / 1000)} másodpercet.`); pin = ""; render(); return; }
    busy = true; render();
    try {
      master = await unwrapMaster(await pinKey(p, meta.salt, meta.iter), meta.pin);
      busy = false; await afterUnlock();
    } catch (e) {
      busy = false; pin = ""; const s = failAdd();
      render(); shake();
      toast(s.n >= 5 ? "Hibás PIN-kód. Kis várakozás következik." : `Hibás PIN-kód. Még ${5 - s.n} próbálkozás várakozás nélkül.`);
    }
  }
  function prfOptions(prfSalt) { return { prf: { eval: { first: prfSalt } } }; }
  // A Face ID-t közvetlenül a koppintásból kell indítani (Safari szabály), ezért itt nincs előtte await.
  function unlockFace() {
    if (!hasFace() || master || faceBusy) return;
    faceBusy = true;
    navigator.credentials.get({ publicKey: {
      challenge: rnd(32), rpId: location.hostname, userVerification: "required", timeout: 60000,
      allowCredentials: [{ type: "public-key", id: meta.face.credId, transports: ["internal", "hybrid"] }],
      extensions: prfOptions(meta.face.prfSalt) } })
      .then(async cred => {
        const out = cred.getClientExtensionResults().prf?.results?.first;
        if (!out) throw new Error("noprf");
        faceBusy = false;
        if (master) return; // közben PIN-nel már kinyílt
        master = await unwrapMaster(await prfKey(out), meta.face);
        await afterUnlock();
      })
      .catch(e => { faceBusy = false; if (e.name !== "NotAllowedError" && e.name !== "AbortError") toast("A Face ID most nem sikerült. Használd a PIN-kódot."); render(); });
  }

  let pendingFace = null;
  function enableFace() {
    if (!master) return;
    if (!faceSupported()) { toast("Ezen a telefonon a Face ID nem érhető el az app számára."); return; }
    const prfSalt = rnd(32);
    navigator.credentials.create({ publicKey: {
      rp: { name: "Garázs napló", id: location.hostname },
      user: { id: rnd(16), name: "Garázs napló iratok", displayName: "Garázs napló iratok" },
      challenge: rnd(32), timeout: 60000,
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required", residentKey: "required" },
      extensions: prfOptions(prfSalt) } })
      .then(async cred => {
        const ext = cred.getClientExtensionResults().prf;
        if (!ext || ext.enabled === false) { toast("Ez az iOS verzió még nem támogatja a Face ID-t ehhez. Frissítsd az iOS-t, addig a PIN-kód működik."); return; }
        const credId = new Uint8Array(cred.rawId);
        if (ext.results?.first) return saveFace(credId, prfSalt, ext.results.first);
        // Néhány iOS verzió csak egy második Face ID után adja ki a kulcsot.
        pendingFace = { credId, prfSalt };
        confirmFaceSheet();
      })
      .catch(e => { if (e.name !== "NotAllowedError" && e.name !== "AbortError") toast("A Face ID beállítása nem sikerült."); });
  }
  function confirmFaceSheet() {
    const form = sheet(`<h2>Face ID megerősítése</h2><p class="hint">Még egyszer nézz a telefonra, hogy a mappa Face ID-val nyitható legyen.</p>`, null,
      `<button type="button" class="btn" data-ok>Megerősítés Face ID-val</button>`);
    form.querySelector("[data-ok]").onclick = () => {
      const { credId, prfSalt } = pendingFace;
      navigator.credentials.get({ publicKey: { challenge: rnd(32), rpId: location.hostname, userVerification: "required", timeout: 60000,
        allowCredentials: [{ type: "public-key", id: credId, transports: ["internal", "hybrid"] }], extensions: prfOptions(prfSalt) } })
        .then(cred => {
          const out = cred.getClientExtensionResults().prf?.results?.first;
          if (!out) { closeSheet(); toast("Ez az iOS verzió még nem támogatja a Face ID-t ehhez. A PIN-kód működik."); return; }
          closeSheet(); return saveFace(credId, prfSalt, out);
        })
        .catch(() => { toast("A Face ID megerősítése nem sikerült."); });
    };
  }
  async function saveFace(credId, prfSalt, out) {
    const w = await wrapMaster(await prfKey(out));
    meta.face = { credId, prfSalt, iv: w.iv, ct: w.ct };
    await putMeta(meta); pendingFace = null;
    toast("Face ID bekapcsolva."); render();
  }
  async function disableFace() { meta.face = null; await putMeta(meta); toast("Face ID kikapcsolva. A mappa PIN-kóddal nyílik."); render(); }

  /* ---------- fájlok ---------- */
  async function toJpeg(file, max, q) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const cv = document.createElement("canvas");
    cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
    cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
    bmp.close && bmp.close();
    return new Promise(res => cv.toBlob(b => res(b), "image/jpeg", q));
  }
  async function addFiles(list) {
    if (!master) return;
    let ok = 0;
    toast("Feltöltés...");
    for (const file of list) {
      try {
        const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
        const isImg = file.type.startsWith("image/");
        if (!isPdf && !isImg) { toast(`${file.name}: csak kép vagy PDF tölthető fel.`); continue; }
        if (file.size > 40 * 1024 * 1024) { toast(`${file.name} túl nagy (legfeljebb 40 MB).`); continue; }
        let data, thumb = null, type = file.type || "application/pdf";
        if (isImg) {
          const big = await toJpeg(file, 2400, 0.85); type = "image/jpeg";
          data = await big.arrayBuffer();
          thumb = await (await toJpeg(file, 360, 0.7)).arrayBuffer();
        } else data = await file.arrayBuffer();
        const name = file.name.replace(/\.(jpe?g|png|heic|heif|webp|pdf)$/i, "") || "Irat";
        const m = { name, type, size: data.byteLength };
        const em = await encrypt(master, enc.encode(JSON.stringify(m)));
        const ed = await encrypt(master, data);
        const et = thumb ? await encrypt(master, thumb) : null;
        await putFile({ id: uid(), created: Date.now(), miv: em.iv, mct: em.ct, iv: ed.iv, data: ed.ct, tiv: et?.iv || null, thumb: et?.ct || null });
        ok++;
      } catch (e) { toast(`${file.name} feltöltése nem sikerült.`); }
    }
    await loadList(); render();
    if (ok) toast(ok === 1 ? "Fájl feltöltve." : `${ok} fájl feltöltve.`);
  }
  async function fileBlob(f) {
    const r = await getFile(f.id);
    return new Blob([await decrypt(master, r.iv, r.data)], { type: f.type });
  }
  async function view(id) {
    const f = files.find(x => x.id === id); if (!f || !master) return;
    const blob = await fileBlob(f), url = URL.createObjectURL(blob);
    const isPdf = f.type === "application/pdf";
    const form = sheet(`<h2>${esc(f.name)}</h2>
      ${isPdf ? `<iframe class="pdfview" src="${url}" title="${esc(f.name)}"></iframe>` : `<img class="imgview" src="${url}" alt="${esc(f.name)}">`}
      <label class="field"><span class="label">Megnevezés</span><input id="f-vname" name="vname" value="${esc(f.name)}" required></label>
      <p class="hint num">${isPdf ? "PDF" : "Kép"}, ${(f.size / 1024 / 1024).toLocaleString("hu-HU", { maximumFractionDigits: 1 })} MB, feltöltve ${fmtDate(iso(new Date(f.created)))}</p>`,
      async fd => {
        const name = fd.vname.trim() || f.name;
        if (name !== f.name) {
          const r = await getFile(f.id);
          const em = await encrypt(master, enc.encode(JSON.stringify({ name, type: f.type, size: f.size })));
          r.miv = em.iv; r.mct = em.ct; await putFile(r); f.name = name;
        }
        URL.revokeObjectURL(url); render();
      },
      `<button type="button" class="btn danger" data-del>Törlés</button><button type="button" class="btn ghost" data-share>Megosztás</button>`);
    form.querySelector("[data-share]").onclick = () => {
      const file = new File([blob], f.name + (isPdf ? ".pdf" : ".jpg"), { type: f.type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) navigator.share({ files: [file] }).catch(() => {});
      else toast("A megosztás ezen az eszközön nem érhető el.");
    };
    form.querySelector("[data-del]").onclick = () => confirmIn(form, `Törlöd: <b>${esc(f.name)}</b>?`, async () => {
      await delFile(f.id); URL.revokeObjectURL(url); await loadList(); render(); toast("Fájl törölve.");
    });
  }

  /* ---------- PIN megadás és módosítás ---------- */
  function pinPad(title, hint, onDone) {
    let p = "";
    const el = $("#sheet");
    el.innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-label="${esc(title)}"><h2>${esc(title)}</h2><p class="hint">${hint}</p>
      <div class="dots" aria-live="polite">${"<span></span>".repeat(4)}</div>${keypad()}
      <div class="actions"><button type="button" class="btn ghost" data-close>Mégse</button></div></div></div>`;
    const dots = el.querySelectorAll(".dots span");
    el.querySelectorAll("[data-k]").forEach(b => b.onclick = () => {
      const k = b.dataset.k;
      if (k === "del") p = p.slice(0, -1); else if (p.length < 4) p += k;
      dots.forEach((d, i) => d.classList.toggle("on", i < p.length));
      if (p.length === 4) setTimeout(() => onDone(p), 120);
    });
  }
  const keypad = () => `<div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button type="button" data-k="${n}">${n}</button>`).join("")}
    <span></span><button type="button" data-k="0">0</button><button type="button" data-k="del" aria-label="Törlés">⌫</button></div>`;
  function newPinFlow(after) {
    pinPad("Új PIN-kód", "Adj meg egy 4 jegyű kódot. Ezzel nyílik a mappa, ha a Face ID nem működik.", p1 => {
      pinPad("PIN-kód még egyszer", "Ellenőrzésképp írd be újra.", async p2 => {
        if (p1 !== p2) { toast("A két kód nem egyezik. Kezdjük újra."); return newPinFlow(after); }
        closeSheet(); await after(p1);
      });
    });
  }
  async function changePin(p) {
    const salt = rnd(16);
    meta.salt = salt; meta.iter = PIN_ITER; meta.pin = await wrapMaster(await pinKey(p, salt, PIN_ITER));
    await putMeta(meta); toast("PIN-kód módosítva.");
  }
  function shake() { const d = document.querySelector(".lock .dots"); if (d) { d.classList.remove("shake"); void d.offsetWidth; d.classList.add("shake"); } }

  async function wipe() {
    lock();
    const db = await open();
    await new Promise(res => { const t = db.transaction(["files", "meta"], "readwrite"); t.objectStore("files").clear(); t.objectStore("meta").clear(); t.oncomplete = res; });
    db.close(); meta = null; failReset(); render(); toast("A mappa törölve. Most újra beállíthatod.");
  }

  /* ---------- megjelenítés ---------- */
  function html() {
    let h = `<h1 class="pagetitle">Iratok</h1>`;
    if (!isSetUp()) return h + `<div class="card vintro">
      <svg class="vicon" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><rect x="9" y="11" width="6" height="5" rx="1"/><path d="M10 11V9.5a2 2 0 0 1 4 0V11"/></svg>
      <h2>Zárolt mappa a fontos papíroknak</h2>
      <p class="hint">Jogosítvány, forgalmi, biztosítási kötvény: fotó vagy PDF. A fájlok titkosítva, csak ezen a telefonon tárolódnak, és Face ID-val vagy PIN-kóddal nyílnak.</p>
      <button class="btn" data-v="setup">Mappa beállítása</button></div>`;
    if (!isOpen()) return h + `<div class="lock">
      <svg class="vicon" viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
      <p class="hint">${busy ? "Nyitás..." : "A mappa zárolva van. Írd be a PIN-kódot" + (hasFace() ? " vagy használd a Face ID-t." : ".")}</p>
      <div class="dots">${[0, 1, 2, 3].map(i => `<span class="${i < pin.length ? "on" : ""}"></span>`).join("")}</div>
      ${keypad()}
      ${hasFace() ? `<button class="btn" data-v="face">Nyitás Face ID-val</button>` : ""}
      <button class="link" data-v="forgot">Elfelejtettem a PIN-kódot</button></div>`;
    h += `<div class="vbar"><label class="btn"><input type="file" id="vfile" accept="image/*,application/pdf" multiple hidden>Fájl hozzáadása</label>
      <button class="btn quiet" data-v="lock">Zárolás</button></div>`;
    h += files.length ? `<div class="vgrid">${files.map(f => `<button class="vfile" data-vf="${f.id}">
        ${f.thumbUrl ? `<img src="${f.thumbUrl}" alt="">` : `<span class="pdf">PDF</span>`}
        <span class="vname">${esc(f.name)}</span></button>`).join("")}</div>`
      : `<div class="card empty">Még üres. A „Fájl hozzáadása” gombbal fotózhatsz, vagy választhatsz képet és PDF-et.</div>`;
    h += `<section class="section"><h2 class="h">Mappa zárolása</h2><div class="card vset">
      ${hasFace() ? `<p class="hint">Face ID bekapcsolva.</p><button class="btn quiet" data-v="faceoff">Face ID kikapcsolása</button>`
        : `<p class="hint">Kapcsold be, hogy a mappa Face ID-val nyíljon.</p><button class="btn" data-v="faceon">Face ID bekapcsolása</button>`}
      <button class="btn quiet" data-v="pin">PIN-kód módosítása</button>
      <p class="hint">A mappa bezáródik, ha kilépsz az appból, vagy 2 percig nem használod.</p></div></section>`;
    return h;
  }
  function render() { if (typeof window.render === "function") window.render(); }

  /* ---------- események ---------- */
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-v],[data-vf],[data-k]");
    if (!b || b.closest("#sheet")) return;
    if (b.dataset.vf) return view(b.dataset.vf);
    if (b.dataset.k && !master && meta) {
      if (busy) return;
      const k = b.dataset.k;
      if (k === "del") pin = pin.slice(0, -1); else if (pin.length < 4) pin += k;
      render();
      if (pin.length === 4) unlockPin(pin);
      return;
    }
    switch (b.dataset.v) {
      case "setup": newPinFlow(async p => { await setup(p); await afterUnlock(); if (faceSupported()) toast("Kész. Lent bekapcsolhatod a Face ID-t is."); }); break;
      case "face": unlockFace(); break;
      case "lock": lock(); break;
      case "faceon": enableFace(); break;
      case "faceoff": disableFace(); break;
      case "pin": newPinFlow(changePin); break;
      case "forgot": {
        const form = sheet(`<h2>Elfelejtett PIN-kód</h2><p>A fájlok titkosítva vannak, ezért PIN-kód${hasFace() ? " vagy Face ID" : ""} nélkül nem lehet kinyitni őket.</p>
          <p class="hint">${hasFace() ? "Próbáld a Face ID-t: nyitás után a mappában új PIN-kódot állíthatsz be. " : ""}Ha nincs más mód, törölheted a mappát az összes fájllal együtt, és újrakezdheted.</p>`, null,
          `<button type="button" class="btn danger" data-wipe>Mappa törlése</button>`);
        form.querySelector("[data-wipe]").onclick = () => confirmIn(form, "Biztosan törlöd a mappát és benne az összes fájlt? Ez nem vonható vissza.", () => { wipe(); });
        break;
      }
    }
  });
  document.addEventListener("change", e => { if (e.target.id === "vfile" && e.target.files.length) { addFiles([...e.target.files]); e.target.value = ""; } });

  /* ---------- biztonsági mentés ---------- */
  const b64 = buf => { const u = new Uint8Array(buf); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  const ser = o => o instanceof ArrayBuffer || ArrayBuffer.isView(o) ? { $b: b64(o.buffer ? o.buffer.slice(o.byteOffset, o.byteOffset + o.byteLength) : o) }
    : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, ser(v)])) : o;
  const deser = o => o && typeof o === "object" ? (o.$b !== undefined ? unb64(o.$b) : Object.fromEntries(Object.entries(o).map(([k, v]) => [k, deser(v)]))) : o;
  async function exportData() {
    if (!meta) return null;
    return { meta: ser(meta), files: (await allFiles()).map(ser) };
  }
  async function importData(d) {
    if (!d || !d.meta) return;
    lock();
    const db = await open();
    await new Promise((res, rej) => {
      const t = db.transaction(["files", "meta"], "readwrite");
      const fs = t.objectStore("files"); fs.clear(); d.files.forEach(f => fs.put(deser(f)));
      t.objectStore("meta").put(deser(d.meta), "vault");
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
    db.close(); meta = await getMeta();
  }

  return { init, html, unlockFace, hasFace, isOpen, isSetUp, exportData, importData };
})();
