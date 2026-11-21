"use strict";
/* Iratok mappa: képek és PDF-ek titkosítva, Face ID-val vagy jelkóddal nyitható.
   - Jelkód (2.8.0): legalább 8 karakter, betűvel (meta.kind = "code"). A 2.8.0 előtti mappák 4 jegyű PIN-nel
     nyílnak (nincs meta.kind); ezek tovább működnek, de nyitott mappában az app kéri a cserét jelkódra.
   - A fájlokat egy véletlen mesterkulcs titkosítja (AES-GCM 256).
   - A mesterkulcsot a jelkódból/PIN-ből származtatott kulcs (PBKDF2) és, ha be van kapcsolva,
     a Face ID-s passkey PRF-kimenetéből származtatott kulcs (HKDF) is lezárja.
   - Nyitott állapotban a kulcs csak a memóriában van; zárolás után eldobjuk. */
const Vault = (() => {
  const AND = (window.APP_CONFIG || {}).platform === "android";
  // feloldás neve a két változatban, a magyar ragokkal együtt
  const W = AND
    ? { Name: "Ujjlenyomatos feloldás", the: "az ujjlenyomatos feloldás", The: "Az ujjlenyomatos feloldás", acc: "az ujjlenyomatos feloldást", ins: "ujjlenyomattal", os: "Android" }
    : { Name: "Face ID", the: "a Face ID", The: "A Face ID", acc: "a Face ID-t", ins: "Face ID-val", os: "iOS" };
  const DB = (window.APP_CONFIG || {}).vaultDb || "garazs-iratok", PIN_ITER = 400000, IDLE_MS = 2 * 60 * 1000;
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
    if (tab === "vault") { render(); autoFace(); }
  }
  const isSetUp = () => !!meta;
  const isOpen = () => !!master;
  const hasFace = () => !!(meta && meta.face);
  const isCode = () => !!(meta && meta.kind === "code"); // jelkód; különben a régi 4 jegyű PIN
  const K = () => isCode() ? { n: "jelkód", acc: "jelkódot", ins: "jelkóddal" } : { n: "PIN-kód", acc: "PIN-kódot", ins: "PIN-kóddal" };
  const faceSupported = () => !!(window.PublicKeyCredential && navigator.credentials);

  function lock() {
    master = null; pin = "";
    files.forEach(f => f.thumbUrl && URL.revokeObjectURL(f.thumbUrl)); files = [];
    clearTimeout(idleTimer);
    closeViewer();
    if (tab === "vault") { closeSheet(); render(); }
  }
  function idleLock() { lock(); }
  function touch() { clearTimeout(idleTimer); if (master) idleTimer = setTimeout(idleLock, IDLE_MS); }
  // Rövid appváltásnál (30 mp-en belül) nyitva marad; hosszabb után zár, és visszatéréskor magától indul a Face ID.
  const GRACE_MS = 30 * 1000;
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hiddenAt = Date.now(); document.body.classList.add("vhide"); return; }
    document.body.classList.remove("vhide");
    if (master && Date.now() - hiddenAt > GRACE_MS) lock();
    if (master) touch();
    autoFace();
  });
  // a zár képernyő bárhol megérintve is elindítja a Face ID-t
  function autoFace() { if (tab === "vault" && hasFace() && !master && !faceBusy) unlockFace(); }
  ["click", "touchstart", "keydown"].forEach(e => document.addEventListener(e, () => { if (master) touch(); }, { passive: true }));

  let pendingCb = null;
  async function afterUnlock() {
    pin = ""; failReset();
    await loadList(); touch(); render();
    if (pendingCb) { const cb = pendingCb; pendingCb = null; cb(); }
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
    meta = { v: 1, kind: "code", salt, iter: PIN_ITER, pin: await wrapMaster(await pinKey(p, salt, PIN_ITER)), face: null };
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
      .catch(e => {
        faceBusy = false;
        if (e.name !== "NotAllowedError" && e.name !== "AbortError") toast(`${W.The} most nem sikerült. Használd a ${K().acc}.`);
        if (pendingCb) pinFlow(); else render();
      });
  }

  let pendingFace = null;
  function enableFace() {
    if (!master) return;
    if (!faceSupported()) { toast(`Ezen a telefonon ${W.the} nem érhető el az app számára.`); return; }
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
        if (!ext || ext.enabled === false) { toast(`Ez az ${W.os}-verzió még nem támogatja ${W.acc} ehhez. Frissítsd a rendszert, addig a ${K().n} működik.`); return; }
        const credId = new Uint8Array(cred.rawId);
        if (ext.results?.first) return saveFace(credId, prfSalt, ext.results.first);
        // Néhány iOS verzió csak egy második Face ID után adja ki a kulcsot.
        pendingFace = { credId, prfSalt };
        confirmFaceSheet();
      })
      .catch(e => { if (e.name !== "NotAllowedError" && e.name !== "AbortError") toast(`${W.The} beállítása nem sikerült.`); });
  }
  function confirmFaceSheet() {
    const form = sheet(`<h2>${W.Name}: megerősítés</h2><p class="hint">Még egyszer erősítsd meg, hogy a mappa ${W.ins} nyitható legyen.</p>`, null,
      `<button type="button" class="btn" data-ok>Megerősítés ${W.ins}</button>`);
    form.querySelector("[data-ok]").onclick = () => {
      const { credId, prfSalt } = pendingFace;
      navigator.credentials.get({ publicKey: { challenge: rnd(32), rpId: location.hostname, userVerification: "required", timeout: 60000,
        allowCredentials: [{ type: "public-key", id: credId, transports: ["internal", "hybrid"] }], extensions: prfOptions(prfSalt) } })
        .then(cred => {
          const out = cred.getClientExtensionResults().prf?.results?.first;
          if (!out) { closeSheet(); toast(`Ez az ${W.os}-verzió még nem támogatja ${W.acc} ehhez. A ${K().n} működik.`); return; }
          closeSheet(); return saveFace(credId, prfSalt, out);
        })
        .catch(() => { toast(`${W.The} megerősítése nem sikerült.`); });
    };
  }
  async function saveFace(credId, prfSalt, out) {
    const w = await wrapMaster(await prfKey(out));
    meta.face = { credId, prfSalt, iv: w.iv, ct: w.ct };
    await putMeta(meta); pendingFace = null;
    toast(`${W.Name} bekapcsolva.`); render();
  }
  async function disableFace() { meta.face = null; await putMeta(meta); toast(`${W.Name} kikapcsolva. A mappa ${K().ins} nyílik.`); render(); }

  /* ---------- PDF megjelenítés (beépített pdf.js, internet nélkül is) ---------- */
  let pdfReady = null;
  function loadPdfJs() {
    if (!pdfReady) pdfReady = new Promise((res, rej) => {
      const sc = document.createElement("script");
      sc.src = "lib/pdfjs/pdf.min.js";
      sc.onload = () => { pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdfjs/pdf.worker.min.js"; res(pdfjsLib); };
      sc.onerror = () => { pdfReady = null; rej(new Error("pdfjs")); };
      document.head.appendChild(sc);
    });
    return pdfReady;
  }
  async function openPdf(bytes) {
    const lib = await loadPdfJs();
    return lib.getDocument({ data: new Uint8Array(bytes.slice(0)), standardFontDataUrl: "lib/pdfjs/standard_fonts/" }).promise;
  }
  async function pageCanvas(doc, n, cssWidth, sharp = 1) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const ratio = Math.min(window.devicePixelRatio || 1, 3) * sharp;
    const vp = page.getViewport({ scale: (cssWidth / base.width) * ratio });
    const cv = document.createElement("canvas");
    cv.width = Math.floor(vp.width); cv.height = Math.floor(vp.height);
    await page.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
    page.cleanup();
    return cv;
  }
  async function pdfThumb(bytes) {
    const doc = await openPdf(bytes);
    try {
      const cv = await pageCanvas(doc, 1, 360 / Math.min(window.devicePixelRatio || 1, 2.5));
      return await new Promise(res => cv.toBlob(b => res(b), "image/jpeg", 0.7));
    } finally { doc.destroy(); }
  }
  async function renderPdfInto(box, bytes, f) {
    let doc;
    try { doc = await openPdf(bytes); }
    catch (e) { box.innerHTML = `<p class="hint">A PDF-et nem sikerült megjeleníteni. A Megosztás gombbal megnyithatod.</p>`; return; }
    box.innerHTML = "";
    if (box.onCount) box.onCount(doc.numPages);
    const width = box.clientWidth || 340;
    for (let n = 1; n <= doc.numPages; n++) {
      if (!box.isConnected) break; // közben bezárták
      const wrap = document.createElement("figure");
      wrap.className = "pdfpage";
      wrap.dataset.page = n;
      box.appendChild(wrap);
      if (box.onPage) box.onPage(wrap);
      try {
        const cv = await pageCanvas(doc, n, width, 1.5);
        cv.setAttribute("aria-label", `${n}. oldal`);
        wrap.appendChild(cv);
        if (n === 1 && !f.thumbUrl) saveThumbFrom(cv, f);
      } catch (e) { wrap.insertAdjacentHTML("afterbegin", `<p class="hint">Ez az oldal nem jeleníthető meg.</p>`); }
    }
    doc.destroy();
  }
  // a korábban feltöltött PDF-ek is kapjanak előnézetet
  async function saveThumbFrom(cv, f) {
    try {
      const t = document.createElement("canvas"), k = 360 / cv.width;
      t.width = 360; t.height = Math.round(cv.height * k);
      t.getContext("2d").drawImage(cv, 0, 0, t.width, t.height);
      const blob = await new Promise(res => t.toBlob(b => res(b), "image/jpeg", 0.7));
      const r = await getFile(f.id); if (!r || !master) return;
      const et = await encrypt(master, await blob.arrayBuffer());
      r.tiv = et.iv; r.thumb = et.ct; await putFile(r);
      f.thumbUrl = URL.createObjectURL(blob);
    } catch (e) {}
  }

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
        } else {
          data = await file.arrayBuffer();
          try { thumb = await (await pdfThumb(data)).arrayBuffer(); } catch (e) { thumb = null; }
        }
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
  // Teljes képernyős nézegető (mint az iPhone Fájlok appja). Külön réteg, hogy az átnevezés/törlés lap fölé nyílhasson.
  const VI = {
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    share: '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
    zoom: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5M11 8.5v5M8.5 11h5"/>',
  };
  const vic = k => `<svg viewBox="0 0 24 24" aria-hidden="true">${VI[k]}</svg>`;
  let viewerUrl = "";
  function closeViewer() {
    const el = document.getElementById("viewer");
    if (el) el.remove();
    if (viewerUrl) { URL.revokeObjectURL(viewerUrl); viewerUrl = ""; }
    document.body.classList.remove("noscroll");
  }
  async function view(id) {
    const f = files.find(x => x.id === id); if (!f || !master) return;
    const blob = await fileBlob(f);
    if (f.type === "application/pdf") return fullView(f, blob);
    imageCard(f, blob);
  }
  function shareFile(f, blob) {
    const file = new File([blob], f.name + (f.type === "application/pdf" ? ".pdf" : ".jpg"), { type: f.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) navigator.share({ files: [file] }).catch(() => {});
    else toast("A megosztás ezen az eszközön nem érhető el.");
  }
  function renameFile(f, after) {
    sheet(`<h2>Átnevezés</h2>${field("vname", "Megnevezés", `required value="${esc(f.name)}"`)}`, async fd => {
      const name = fd.vname.trim() || f.name;
      if (name === f.name) return;
      const r = await getFile(f.id);
      const em = await encrypt(master, enc.encode(JSON.stringify({ name, type: f.type, size: f.size })));
      r.miv = em.iv; r.mct = em.ct; await putFile(r); f.name = name;
      render(); if (after) after(name);
    });
    setTimeout(() => { const i = document.getElementById("f-vname"); if (i) { i.focus(); i.select(); } }, 50);
  }
  function deleteFile(f) {
    const form = sheet(`<h2>Törlöd ezt az iratot?</h2><p><b>${esc(f.name)}</b></p><p class="hint">A törlés nem vonható vissza.</p>`, null,
      `<button type="button" class="btn danger" data-yes>Törlés</button>`);
    form.querySelector("[data-yes]").onclick = async () => {
      await delFile(f.id); closeSheet(); closeViewer(); await loadList(); render(); toast("Irat törölve.");
    };
  }
  // kép (pl. jogosítvány, személyi): kis előnézet egy lapon; a képre koppintva teljes képernyő
  function imageCard(f, blob) {
    const url = URL.createObjectURL(blob);
    const el = $("#sheet");
    el.innerHTML = `<div class="sheet-bg"><div class="sheet imgsheet" role="dialog" aria-label="${esc(f.name)}">
      <div class="imghead"><div><h2>${esc(f.name)}</h2><p class="hint num">Kép, ${mb(f.size)}, ${fmtDate(iso(new Date(f.created)))}</p></div>
        <button type="button" class="vw-btn light" data-x aria-label="Bezárás">${vic("close")}</button></div>
      <button type="button" class="imgcard" data-full aria-label="Megnyitás teljes képernyőn"><img src="${url}" alt="${esc(f.name)}"><span class="imgzoom">${vic("zoom")}</span></button>
      <div class="vw-bar card-bar">
        <button type="button" data-full>${vic("zoom")}<span>Nagyítás</span></button>
        <button type="button" data-share>${vic("share")}<span>Megosztás</span></button>
        <button type="button" data-ren>${vic("edit")}<span>Átnevezés</span></button>
        <button type="button" data-del class="vw-del">${vic("trash")}<span>Törlés</span></button>
      </div></div></div>`;
    const cleanup = () => URL.revokeObjectURL(url);
    const close = () => { closeSheet(); cleanup(); };
    el.querySelector(".sheet-bg").addEventListener("click", e => { if (e.target.classList.contains("sheet-bg")) close(); });
    el.querySelector("[data-x]").onclick = close;
    el.querySelectorAll("[data-full]").forEach(b => b.onclick = () => { close(); fullView(f, blob); });
    el.querySelector("[data-share]").onclick = () => shareFile(f, blob);
    el.querySelector("[data-ren]").onclick = () => { cleanup(); renameFile(f); };
    el.querySelector("[data-del]").onclick = () => { cleanup(); deleteFile(f); };
  }
  function fullView(f, blob) {
    const isPdf = f.type === "application/pdf";
    closeViewer();
    if (!isPdf) viewerUrl = URL.createObjectURL(blob);
    const el = document.createElement("div");
    el.id = "viewer"; el.className = "viewer"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", f.name);
    el.innerHTML = `
      <header class="vw-top">
        <button type="button" class="vw-btn" data-x aria-label="Bezárás">${vic("close")}</button>
        <div class="vw-title"><b>${esc(f.name)}</b><small class="num">${isPdf ? "PDF" : "Kép"}, ${mb(f.size)}</small></div>
        <button type="button" class="vw-btn" data-share aria-label="Megosztás">${vic("share")}</button>
      </header>
      <div class="vw-body${isPdf ? "" : " img"}">
        ${isPdf ? `<div class="vw-pages"><p class="vw-load">Oldalak betöltése...</p></div>` : `<img src="${viewerUrl}" alt="${esc(f.name)}">`}
      </div>
      ${isPdf ? `<div class="vw-count num" aria-live="polite" hidden></div>` : ""}
      <footer class="vw-bar">
        <button type="button" data-zoom>${vic("zoom")}<span>Nagyítás</span></button>
        <button type="button" data-ren>${vic("edit")}<span>Átnevezés</span></button>
        <button type="button" data-del class="vw-del">${vic("trash")}<span>Törlés</span></button>
      </footer>`;
    document.body.appendChild(el);
    document.body.classList.add("noscroll");
    const body = el.querySelector(".vw-body");

    // dupla koppintás vagy a Nagyítás gomb: 2x-es nagyítás, oldalra görgethető
    const toggleZoom = () => {
      // a nézet közepe ugyanott maradjon nagyítás után is
      const cy = (body.scrollTop + body.clientHeight / 2) / body.scrollHeight;
      const cx = (body.scrollLeft + body.clientWidth / 2) / body.scrollWidth;
      body.classList.toggle("zoomed");
      body.scrollTop = cy * body.scrollHeight - body.clientHeight / 2;
      body.scrollLeft = cx * body.scrollWidth - body.clientWidth / 2;
      el.querySelector("[data-zoom] span").textContent = body.classList.contains("zoomed") ? "Kicsinyítés" : "Nagyítás";
    };
    let lastTap = 0;
    body.addEventListener("touchend", e => { const t = Date.now(); if (t - lastTap < 300) { e.preventDefault(); toggleZoom(); lastTap = 0; } else lastTap = t; });
    body.addEventListener("dblclick", toggleZoom);
    el.querySelector("[data-zoom]").onclick = toggleZoom;

    if (isPdf) {
      const pages = el.querySelector(".vw-pages"), counter = el.querySelector(".vw-count");
      let total = 0, hideT;
      const show = n => { counter.textContent = `${n} / ${total}`; counter.hidden = false; clearTimeout(hideT); hideT = setTimeout(() => { counter.hidden = true; }, 1500); };
      const io = new IntersectionObserver(es => { es.forEach(e => { if (e.isIntersecting) show(Number(e.target.dataset.page)); }); }, { root: body, threshold: 0.5 });
      pages.onCount = n => { total = n; el.querySelector(".vw-title small").textContent = `PDF, ${n} oldal, ${mb(f.size)}`; };
      pages.onPage = fig => io.observe(fig);
      blob.arrayBuffer().then(buf => renderPdfInto(pages, buf, f));
    }

    el.querySelector("[data-x]").onclick = closeViewer;
    el.querySelector("[data-share]").onclick = () => shareFile(f, blob);
    el.querySelector("[data-ren]").onclick = () => renameFile(f, name => { el.querySelector(".vw-title b").textContent = name; });
    el.querySelector("[data-del]").onclick = () => deleteFile(f);
  }

  /* ---------- PIN megadás és módosítás ---------- */
  function pinPad(title, hint, onDone) {
    let p = "";
    const el = $("#sheet");
    el.innerHTML = `<div class="sheet-bg"><div class="sheet" role="dialog" aria-label="${esc(title)}"><h2>${esc(title)}</h2><p class="hint">${hint}</p>
      <div class="pinbox" aria-live="polite">${"<span></span>".repeat(4)}</div>${keypad()}
      <div class="actions"><button type="button" class="btn ghost" data-close>Mégse</button></div></div></div>`;
    const dots = el.querySelectorAll(".pinbox span");
    el.querySelectorAll("[data-k]").forEach(b => b.onclick = () => {
      const k = b.dataset.k;
      if (k === "del") p = p.slice(0, -1); else if (p.length < 4) p += k;
      dots.forEach((d, i) => d.classList.toggle("on", i < p.length));
      if (p.length === 4) setTimeout(() => onDone(p), 120);
    });
  }
  const keypad = () => `<div class="keypad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button type="button" data-k="${n}">${n}</button>`).join("")}
    <span></span><button type="button" data-k="0">0</button><button type="button" data-k="del" aria-label="Utolsó számjegy törlése"><svg viewBox="0 0 24 24"><path d="M9 6h11v12H9l-6-6z"/><path d="M12.5 9.5l5 5M17.5 9.5l-5 5"/></svg></button></div>`;
  /* ---------- jelkód (2.8.0): beállítás, csere, feloldás; a meglévő ablak (sheet) mezőivel ---------- */
  const CODE_ATTRS = 'type="password" autocapitalize="off" autocorrect="off" spellcheck="false" required';
  const codeOk = p => p.length >= 8 && /\p{L}/u.test(p);
  function newCodeFlow(after, title = "Új jelkód") {
    const form = sheet(`<h2>${title}</h2>
      <p class="hint">Legalább 8 karakter, legyen benne betű is. Ezzel nyílik a mappa, ha ${W.the} nem működik, és ez kell a mentésből való visszaállításhoz is. Ha elfelejted, az iratok nem nyithatók ki.</p>
      ${field("vnew", "Jelkód", `${CODE_ATTRS} autocomplete="new-password"`)}
      ${field("vnew2", "Jelkód még egyszer", `${CODE_ATTRS} autocomplete="new-password"`)}`, f => {
      if (!codeOk(f.vnew)) { toast("A jelkód legyen legalább 8 karakter, és legyen benne betű is."); return false; }
      if (f.vnew !== f.vnew2) { toast("A két jelkód nem egyezik."); return false; }
      closeSheet(); after(f.vnew); return false;
    });
    setTimeout(() => { const i = form.querySelector("#f-vnew"); if (i) i.focus(); }, 50);
  }
  // a régi PIN cseréje vagy a jelkód módosítása (csak nyitott mappánál; a mesterkulcs és a fájlok nem változnak)
  async function changeCode(p) {
    const salt = rnd(16);
    meta.salt = salt; meta.iter = PIN_ITER; meta.kind = "code"; meta.pin = await wrapMaster(await pinKey(p, salt, PIN_ITER));
    await putMeta(meta); render();
    toast("Jelkód beállítva. Készíts új mentést: a korábbi mentés még a régi kóddal nyílik.");
  }
  // feloldás jelkóddal
  function codeSheet() {
    const form = sheet(`<h2>Iratok feloldása</h2><p class="hint">Írd be a mappa jelkódját.</p>
      ${field("vcode", "Jelkód", `${CODE_ATTRS} autocomplete="current-password"`)}`, f => { tryCode(form, f.vcode); return false; });
    const go = form.querySelector(".ssave"); if (go) go.textContent = "Nyitás";
    form.querySelector("[data-close]").addEventListener("click", () => { pendingCb = null; });
    setTimeout(() => { const i = form.querySelector("#f-vcode"); if (i) i.focus(); }, 50);
  }
  async function tryCode(form, p) {
    if (busy) return;
    const f = failState();
    if (f.until > Date.now()) { toast(`Túl sok hibás próbálkozás. Várj ${Math.ceil((f.until - Date.now()) / 1000)} másodpercet.`); return; }
    busy = true;
    const go = form.querySelector(".ssave"); if (go) { go.disabled = true; go.textContent = "Nyitás..."; }
    try {
      master = await unwrapMaster(await pinKey(p, meta.salt, meta.iter), meta.pin);
      busy = false; closeSheet(); await afterUnlock();
    } catch (e) {
      busy = false; if (go) { go.disabled = false; go.textContent = "Nyitás"; }
      const s = failAdd(), i = form.querySelector("#f-vcode"); if (i) { i.value = ""; i.focus(); }
      toast(s.n >= 5 ? "Hibás jelkód. Kis várakozás következik." : `Hibás jelkód. Még ${5 - s.n} próbálkozás várakozás nélkül.`);
    }
  }
  function shake() { const d = document.querySelector(".vpanel .pinbox"); if (d) { d.classList.remove("shake"); void d.offsetWidth; d.classList.add("shake"); } }

  // a mappa törlése (fájlok és kulcsok) egy lépésben
  async function clear() {
    lock();
    const db = await open();
    try {
      await new Promise((res, rej) => {
        const t = db.transaction(["files", "meta"], "readwrite");
        t.oncomplete = res; t.onerror = t.onabort = () => rej(t.error || new Error("abort"));
        t.objectStore("files").clear(); t.objectStore("meta").clear();
      });
    } finally { db.close(); }
    meta = null; failReset();
  }
  async function wipe() { await clear(); render(); toast("A mappa törölve. Most újra beállíthatod."); }

  /* ---------- megjelenítés ---------- */
  const IC = {
    lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
    face: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M9 9v1.5M15 9v1.5M12 9v4h-1M9.5 16a3.5 3.5 0 0 0 5 0"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    finger: '<path d="M7 11a5 5 0 0 1 10 0v2a9 9 0 0 1-1.5 5"/><path d="M12 11v3a12 12 0 0 1-2 6.5"/><path d="M4.5 9a8 8 0 0 1 15 0M4 14v-1M9 11a3 3 0 0 1 6 0v2"/>',
    chev: '<path d="M9 6l6 6-6 6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  };
  const svg = (k, cls = "") => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${IC[k]}</svg>`;
  const mb = n => n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + " KB" : (n / 1024 / 1024).toLocaleString("hu-HU", { maximumFractionDigits: 1 }) + " MB";

  function html() {
    if (!isSetUp()) return `<h1 class="pagetitle">Iratok</h1>
      <div class="vpanel vintro">${svg("folder", "vbig")}
        <h2>Zárolt mappa a fontos papíroknak</h2>
        <p>Jogosítvány, forgalmi, biztosítási kötvény: fotó vagy PDF. Titkosítva, csak ezen a telefonon, ${W.ins} vagy jelkóddal nyílik.</p>
        <button class="btn" data-v="setup">Mappa beállítása</button></div>`;

    if (!isOpen()) return `<h1 class="pagetitle">Iratok</h1>
      <div class="vlock">
        <div class="vpanel" data-v="${hasFace() ? "face" : ""}">
          ${svg("lock", "vbig")}
          <p class="vmsg">${busy ? "Nyitás..." : faceBusy ? "Nézz a telefonra..." : "Zárolva"}</p>
          ${isCode() ? "" : `<div class="pinbox" aria-label="PIN-kód, ${pin.length} számjegy beírva">${[0, 1, 2, 3].map(i => `<span class="${i < pin.length ? "on" : ""}"></span>`).join("")}</div>`}
        </div>
        ${hasFace() ? `<button class="btn wide faceid" data-v="face">${svg(AND ? "finger" : "face")}Nyitás ${W.ins}</button>` : ""}
        ${isCode() ? `<button class="btn wide${hasFace() ? " ghost" : ""}" data-v="code">Nyitás jelkóddal</button>` : keypad()}
        <button class="link" data-v="forgot">Elfelejtettem a ${K().acc}</button>
      </div>`;

    let h = `<div class="vhead"><h1>Iratok</h1><button class="iconbtn" data-v="lock" aria-label="Mappa zárolása">${svg("lock")}</button></div>
      <p class="vstatus"><span class="vdot"></span>Nyitva. Bezáródik, ha 2 percig nem használod, vagy ha fél percnél tovább kilépsz.</p>`;
    if (!isCode()) h += `<button class="vtip" data-v="pin">${svg("lock")}<span><b>Cseréld a 4 jegyű PIN-kódot jelkódra</b><small>4 számjegy gyorsan kipróbálható, ha a mentésed illetéktelen kézbe kerül. A jelkód legalább 8 karakter, betűvel.</small></span></button>`;
    if (!hasFace() && faceSupported()) h += `<button class="vtip" data-v="faceon">${svg(AND ? "finger" : "face")}<span><b>Kapcsold be ${W.acc}</b><small>Így a mappa magától nyílik, nem kell ${K().acc} beírni.</small></span></button>`;
    h += `<label class="vadd"><input type="file" id="vfile" accept="image/*,application/pdf" multiple hidden>${svg("plus")}<span><b>Fájl hozzáadása</b><small>Fotó, kép vagy PDF</small></span></label>`;
    h += files.length ? `<div class="rows vlist">${files.map(f => `<button class="vrow" data-vf="${f.id}">
        <span class="vth">${f.thumbUrl ? `<img src="${f.thumbUrl}" alt="">` : `<span class="vpdf">PDF</span>`}</span>
        <span class="vtx"><b>${esc(f.name)}</b><small class="num">${f.type === "application/pdf" ? "PDF" : "Kép"}, ${mb(f.size)}, ${fmtDate(iso(new Date(f.created)))}</small></span>
        ${svg("chev", "vchev")}</button>`).join("")}</div>`
      : `<p class="hint vempty">Még nincs irat. Kezdd a jogosítvánnyal vagy az RCA kötvénnyel.</p>`;
    h += `<div class="vfoot">${hasFace() ? `<span>${W.Name} bekapcsolva</span><button class="link" data-v="faceoff">Kikapcsolás</button>` : ""}
      <button class="link" data-v="pin">${isCode() ? "Jelkód módosítása" : "PIN-kód cseréje jelkódra"}</button></div>`;
    return h;
  }
  function render() { if (typeof window.render === "function") window.render(); }

  /* ---------- események ---------- */
  document.addEventListener("click", e => {
    const b = e.target.closest("[data-v],[data-vf],[data-k]");
    if (!b || b.closest("#sheet")) return;
    if (b.dataset.vf) return view(b.dataset.vf);
    if (b.dataset.k && !master && meta && !isCode()) {
      if (busy) return;
      const k = b.dataset.k;
      if (k === "del") pin = pin.slice(0, -1); else if (pin.length < 4) pin += k;
      render();
      if (pin.length === 4) unlockPin(pin);
      return;
    }
    switch (b.dataset.v) {
      case "setup": newCodeFlow(async p => { await setup(p); await afterUnlock(); if (faceSupported()) toast(`Kész. Most kapcsold be ${W.acc} is.`); }); break;
      case "face": unlockFace(); break;
      case "code": codeSheet(); break;
      case "lock": lock(); break;
      case "faceon": enableFace(); break;
      case "faceoff": disableFace(); break;
      case "pin": if (master) newCodeFlow(changeCode, isCode() ? "Új jelkód" : "Jelkód beállítása"); break;
      case "forgot": {
        const form = sheet(`<h2>Elfelejtett ${K().n}</h2><p>A fájlok titkosítva vannak, ezért ${K().n}${hasFace() ? " vagy " + W.Name.toLowerCase() : ""} nélkül nem lehet kinyitni őket.</p>
          <p class="hint">${hasFace() ? `Próbáld ${W.acc}: nyitás után a mappában új jelkódot állíthatsz be. ` : ""}Ha nincs más mód, törölheted a mappát az összes fájllal együtt, és újrakezdheted.</p>`, null,
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
  // a mentés Iratok részének ellenőrzése: a hiba szövege, vagy "" ha rendben van
  function checkData(d) {
    const isB = x => !!x && typeof x === "object" && typeof x.$b === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(x.$b);
    if (!d || typeof d !== "object" || !d.meta || typeof d.meta !== "object" || !Array.isArray(d.files)) return "hiányos";
    const m = d.meta;
    if (!isB(m.salt) || !(Number(m.iter) > 0) || !m.pin || !isB(m.pin.iv) || !isB(m.pin.ct)) return "hiányzik a mappa kulcsa";
    if (m.face && !(isB(m.face.credId) && isB(m.face.prfSalt) && isB(m.face.iv) && isB(m.face.ct))) return `hibás ${W.the} adata`;
    const ids = new Set();
    for (const f of d.files) {
      if (!f || typeof f !== "object" || typeof f.id !== "string" || !f.id || ids.has(f.id)) return "egy irat azonosítója hibás";
      ids.add(f.id);
      if (!isB(f.miv) || !isB(f.mct) || !isB(f.iv) || !isB(f.data) || (f.thumb && !(isB(f.tiv) && isB(f.thumb)))) return "egy irat hiányos";
    }
    return "";
  }
  // Egy lépésben: előbb minden átalakítás (ha hibás, semmihez nem nyúlunk), utána egy tranzakció; hiba esetén a régi marad.
  async function importData(d) {
    const recs = d.files.map(deser), m = deser(d.meta);
    lock();
    const db = await open();
    try {
      await new Promise((res, rej) => {
        const t = db.transaction(["files", "meta"], "readwrite");
        t.oncomplete = res; t.onerror = t.onabort = () => rej(t.error || new Error("abort"));
        try { const fs = t.objectStore("files"); fs.clear(); recs.forEach(r => fs.put(r)); t.objectStore("meta").put(m, "vault"); }
        catch (e) { t.abort(); }
      });
    } finally { db.close(); }
    meta = await getMeta(); failReset();
  }

  /* ---------- irat csatolása a lejáratokhoz (máshonnan, nem az Iratok fülről) ---------- */
  // a mappa megnyitása, majd a művelet; a Face ID-t a koppintásból kell indítani, ezért nincs előtte await
  function ensureOpen(cb) {
    if (!isSetUp()) { toast("Előbb állítsd be az Iratok mappát az Iratok fülön."); return; }
    if (master) { touch(); cb(); return; }
    pendingCb = cb;
    if (hasFace()) unlockFace(); else pinFlow();
  }
  function pinFlow() {
    if (isCode()) return codeSheet();
    pinPad("Iratok feloldása", "Írd be a mappa PIN-kódját.", async p => {
      const f = failState();
      if (f.until > Date.now()) { closeSheet(); pendingCb = null; toast(`Túl sok hibás próbálkozás. Várj ${Math.ceil((f.until - Date.now()) / 1000)} másodpercet.`); return; }
      try {
        master = await unwrapMaster(await pinKey(p, meta.salt, meta.iter), meta.pin);
        closeSheet(); await afterUnlock();
      } catch (e) {
        const s2 = failAdd(); closeSheet(); pendingCb = null;
        toast(s2.n >= 5 ? "Hibás PIN-kód. Kis várakozás következik." : "Hibás PIN-kód.");
      }
    });
  }
  // irat kiválasztása (vagy új feltöltése) a mappából
  function pick(cb) {
    ensureOpen(() => {
      const form = sheet(`<h2>Irat csatolása</h2>
        ${files.length ? `<div class="rows vlist">${files.map(f => `<button type="button" class="vrow" data-pick="${f.id}">
          <span class="vth">${f.thumbUrl ? `<img src="${f.thumbUrl}" alt="">` : `<span class="vpdf">PDF</span>`}</span>
          <span class="vtx"><b>${esc(f.name)}</b><small class="num">${f.type === "application/pdf" ? "PDF" : "Kép"}, ${mb(f.size)}</small></span></button>`).join("")}</div>`
          : `<p class="hint">Az Iratok mappa még üres. Tölts fel egy fotót vagy PDF-et.</p>`}`, null,
        `<label class="btn ghost">Új fájl feltöltése<input type="file" id="pickfile" accept="image/*,application/pdf" hidden></label>`);
      form.querySelectorAll("[data-pick]").forEach(b => b.onclick = () => { closeSheet(); cb(b.dataset.pick); });
      form.querySelector("#pickfile").onchange = async e => {
        const list = [...e.target.files]; if (!list.length) return;
        closeSheet(); await addFiles(list);
        const newest = files.reduce((a, b) => (!a || b.created > a.created ? b : a), null);
        if (newest) cb(newest.id);
      };
    });
  }
  // csatolt irat megnyitása; ha már nincs meg, szól
  function openFile(id, onMissing) {
    ensureOpen(() => {
      if (!files.some(f => f.id === id)) { if (onMissing) onMissing(); return; }
      view(id);
    });
  }
  const fileName = id => (master && files.find(f => f.id === id)?.name) || "";

  return { init, html, unlockFace, hasFace, isOpen, isSetUp, isCode, exportData, importData, checkData, clear, pick, openFile, fileName };
})();
