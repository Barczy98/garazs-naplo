"use strict";
/* Szövegfelismerés a telefonon (Tesseract, internet nélkül is, első használat után). A kép nem megy el sehova.
   - scan(): tankolási blokk → liter, egységár, fizetett összeg, dátum, benzinkút
   - odometer(): műszerfal fotó → km-óra állás */
const Receipt = (() => {
  let ready = null;
  function loadLib() {
    if (window.Tesseract) return Promise.resolve();
    return new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "lib/tesseract/tesseract.min.js";
      s.onload = res; s.onerror = () => rej(new Error("A szövegfelismerő nem töltődött be."));
      document.head.appendChild(s);
    });
  }
  async function worker() {
    if (!ready) ready = (async () => {
      await loadLib();
      const base = new URL("lib/tesseract/", location.href).href;
      const w = await Tesseract.createWorker("eng", 1, {
        workerPath: base + "worker.min.js",
        corePath: base + "core/",
        langPath: base + "lang/",
        gzip: true,
        workerBlobURL: false,
      });
      // a blokkon csak nagybetűk, számok és néhány jel van
      await w.setParameters({ preserve_interword_spaces: "1" });
      return w;
    })().catch(e => { ready = null; throw e; });
    return ready;
  }

  // A fotóból kivágjuk a fehér blokkot (a háttér zavarja a felismerést), aztán szürke, kontrasztos kép készül.
  async function prepare(file) {
    const bmp = await createImageBitmap(file);
    // 1) kis mintán megkeressük a blokkot: világos, szürkés (nem színes) képpontok
    const sw = 300, sh = Math.round(bmp.height * sw / bmp.width);
    const sc = document.createElement("canvas"); sc.width = sw; sc.height = sh;
    const sg = sc.getContext("2d", { willReadFrequently: true }); sg.drawImage(bmp, 0, 0, sw, sh);
    const px = sg.getImageData(0, 0, sw, sh).data;
    const white = (x, y) => { const i = (y * sw + x) * 4, r = px[i], g = px[i + 1], b2 = px[i + 2]; return Math.min(r, g, b2) > 105 && Math.max(r, g, b2) - Math.min(r, g, b2) < 45; };  // árnyékos papír is számít
    const colOk = [], rowOk = [];
    for (let x = 0; x < sw; x++) { let n = 0; for (let y = 0; y < sh; y++) n += white(x, y); colOk.push(n / sh > 0.3); }
    for (let y = 0; y < sh; y++) { let n = 0; for (let x = 0; x < sw; x++) n += white(x, y); rowOk.push(n / sw > 0.12); }
    const span = arr => { let a = arr.indexOf(true), z = arr.lastIndexOf(true); return a < 0 ? [0, arr.length - 1] : [a, z]; };
    let [x0, x1] = span(colOk), [y0, y1] = span(rowOk);
    const k0 = bmp.width / sw;
    // ha a kivágás túl kicsi lenne, maradjon az egész kép
    if ((x1 - x0) < sw * 0.2 || (y1 - y0) < sh * 0.2) { x0 = 0; x1 = sw - 1; y0 = 0; y1 = sh - 1; }
    const pad = 10;   // inkább kicsit több maradjon, mint hogy a jobb szélen lévő számok lemaradjanak
    const cx = Math.max(0, (x0 - pad) * k0), cy = Math.max(0, (y0 - pad) * k0);
    const cw = Math.min(bmp.width - cx, (x1 - x0 + 2 * pad) * k0), ch = Math.min(bmp.height - cy, (y1 - y0 + 2 * pad) * k0);
    // 2) a blokk kb. 1300 képpont szélesre nagyítva/kicsinyítve
    const k = Math.min(2.5, 1300 / cw);
    const cv = document.createElement("canvas");
    cv.width = Math.round(cw * k); cv.height = Math.round(ch * k);
    const g = cv.getContext("2d", { willReadFrequently: true });
    g.imageSmoothingQuality = "high";
    g.drawImage(bmp, cx, cy, cw, ch, 0, 0, cv.width, cv.height);
    bmp.close && bmp.close();
    const img = g.getImageData(0, 0, cv.width, cv.height), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      let y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      y = Math.max(0, Math.min(255, (y - 128) * 1.6 + 150));   // a halvány hőpapír-betűk sötétebbek lesznek
      d[i] = d[i + 1] = d[i + 2] = y;
    }
    g.putImageData(img, 0, 0);
    return cv;
  }

  // a teljes fotó szürkén, kicsinyítve (a jobb szélen lévő összegeket ez olvassa jól)
  async function prepareWhole(file) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
    const cv = document.createElement("canvas");
    cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
    const g = cv.getContext("2d", { willReadFrequently: true });
    g.drawImage(bmp, 0, 0, cv.width, cv.height); bmp.close && bmp.close();
    const img = g.getImageData(0, 0, cv.width, cv.height), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      let y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      y = Math.max(0, Math.min(255, (y - 128) * 1.5 + 140));
      d[i] = d[i + 1] = d[i + 2] = y;
    }
    g.putImageData(img, 0, 0);
    return cv;
  }

  const num = s => s == null ? null : Number(String(s).replace(/\s/g, "").replace(",", "."));
  const BRANDS = [["ROMPETROL", "Rompetrol"], ["PETROM", "Petrom"], ["OMV", "OMV"], ["MOL", "MOL"], ["LUKOIL", "Lukoil"], ["SOCAR", "Socar"], ["GAZPROM", "Gazprom"], ["AVIA", "Avia"]];

  // a felismert szövegből a tankolás adatai
  function parse(raw) {
    const text = raw.toUpperCase().replace(/[‚’`]/g, ",");
    const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
    const out = { text: raw };
    // „4.6002 L X 10.88= 50.05” → liter, egységár, összeg
    const m = text.match(/(\d{1,3}[.,]\d{1,4})\s*(?:L|LT|LITRI)\b\.?\s*[X×*]\s*(\d{1,2}[.,]\d{1,3})\s*=?\s*(\d{1,4}[.,]\d{2})/);
    if (m) { out.liters = num(m[1]); out.price = num(m[2]); out.amount = num(m[3]); }
    else {
      // ha a liter elmosódott: „X 10.88= 50.05” → egységár és összeg
      const pm = text.match(/[X×*]\s*(\d{1,2}[.,]\d{2,3})\s*=\s*(\d{1,4}[.,]\d{2})/);
      if (pm) { out.price = num(pm[1]); out.amount = num(pm[2]); }
      const l = text.match(/(\d{1,3}[.,]\d{1,4})\s*(?:L|LT|LITRI)\b/);
      if (l) out.liters = num(l[1]);
    }
    const cands = [];
    if (out.amount != null) cands.push(out.amount);
    for (const ln of lines) {
      if (/TVA|TUA|REST/.test(ln)) continue;
      const t = ln.match(/^(?:SUB)?TOTAL\b.*?(\d{1,5}[.,]\d{2})\s*$/) || ln.match(/^(?:CARD|NUMERAR|CASH)\b.*?(\d{1,5}[.,]\d{2})\s*$/);
      if (t) cands.push(num(t[1]));
    }
    if (cands.length) {
      const freq = {}; cands.forEach(v => freq[v] = (freq[v] || 0) + 1);
      out.total = +Object.entries(freq).sort((a2, b2) => b2[1] - a2[1] || cands.indexOf(+a2[0]) - cands.indexOf(+b2[0]))[0][0];
    }
    // ha a liter × egységár nem egyezik az összeggel, a liter valószínűleg rossz: az összegből számoljuk
    if (out.price && out.total && (!out.liters || Math.abs(out.liters * out.price - out.total) > 0.6)) {
      out.liters = Math.round(out.total / out.price * 100) / 100;
      out.litersGuessed = true;
    }
    // „DATA: 05-11-2026”
    const d = text.match(/DATA\s*:?\s*(\d{2})[-./](\d{2})[-./](\d{4})/) || text.match(/\b(\d{2})[-./](\d{2})[-./](20\d{2})\b/);
    if (d) {
      const dd = +d[1], mm = +d[2], yy = +d[3];
      if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) out.date = `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    }
    // benzinkút: márka + település („PUNCT DE LUCRU ORADEA”)
    const brand = BRANDS.find(([k]) => new RegExp(`\\b${k}\\b`).test(text));
    const city = text.match(/PUNCT\s+DE\s+LUCRU\s+([A-ZĂÂÎȘȚŞŢ\- ]{3,30})/);
    const cityName = city ? city[1].trim().toLowerCase().replace(/(^|[\s-])\S/g, c => c.toUpperCase()) : "";
    if (brand || cityName) out.station = [brand ? brand[1] : "", cityName].filter(Boolean).join(" ");
    return out;
  }

  // két olvasás: a kivágott blokk (a bal oldali tételsorokhoz) és a teljes kép (a jobb szélen lévő összegekhez)
  async function scan(file, onProgress) {
    const w = await worker();
    if (onProgress) onProgress(1);
    await w.setParameters({ tessedit_pageseg_mode: "4", tessedit_char_whitelist: "" });
    const a = (await w.recognize(await prepare(file))).data.text || "";
    if (onProgress) onProgress(2);
    await w.setParameters({ tessedit_pageseg_mode: "6" });
    const b = (await w.recognize(await prepareWhole(file))).data.text || "";
    return parse(a + "\n" + b);
  }

  /* ---------- km-óra a műszerfalról ---------- */
  // A kijelzőn sötét alapon világító számjegysorokat keresünk: világos foltok, számjegy méretűek,
  // egy sorban, egyforma magasak (a pontmátrixos kijelzőn a számjegyek összefolyhatnak, az is jó).
  function findRows(bmp, T) {
    const sw = 800, k = sw / bmp.width, sh = Math.round(bmp.height * k);
    const cv = document.createElement("canvas"); cv.width = sw; cv.height = sh;
    const g = cv.getContext("2d", { willReadFrequently: true }); g.drawImage(bmp, 0, 0, sw, sh);
    const d = g.getImageData(0, 0, sw, sh).data, N = sw * sh, on = new Uint8Array(N);
    for (let i = 0; i < N; i++) on[i] = Math.max(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) > T;
    const lab = new Int32Array(N), comps = [], st = [];
    for (let s0 = 0; s0 < N; s0++) if (on[s0] && !lab[s0]) {
      const id = comps.length + 1; let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0; st.push(s0); lab[s0] = id;
      while (st.length) {
        const p = st.pop(), x = p % sw, y = (p / sw) | 0; n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        for (const q of [p - 1, p + 1, p - sw, p + sw, p - sw - 1, p - sw + 1, p + sw - 1, p + sw + 1]) {
          if (q < 0 || q >= N || lab[q] || !on[q] || Math.abs(q % sw - x) > 1) continue;
          lab[q] = id; st.push(q);
        }
      }
      comps.push({ x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1, n });
    }
    const ch = comps.filter(c => c.h >= Math.max(3, sh * 0.008) && c.h <= sh * 0.2 && c.w <= sw * 0.6 &&
      c.w / c.h > 0.12 && c.w / c.h < 7 && c.n / (c.w * c.h) > 0.15).sort((a, b) => a.x0 - b.x0);
    const rows = [], used = new Set();
    for (let i = 0; i < ch.length; i++) {
      if (used.has(i)) continue;
      const row = [ch[i]]; let last = ch[i];
      for (let j = i + 1; j < ch.length; j++) {
        if (used.has(j)) continue; const c = ch[j];
        if (c.x0 - last.x1 > last.h * 0.9) continue;
        if (Math.abs((last.y0 + last.y1) / 2 - (c.y0 + c.y1) / 2) > last.h * 0.25 || Math.abs(c.h - last.h) > last.h * 0.3) continue;
        row.push(c); used.add(j); last = c;
      }
      const x0 = row[0].x0, x1 = last.x1, y0 = Math.min(...row.map(c => c.y0)), y1 = Math.max(...row.map(c => c.y1)), h = y1 - y0 + 1;
      if (x1 - x0 >= h * 2.8) rows.push({ n: row.length, box: [(x0 - h * 0.6) / k, (y0 - h * 0.35) / k, (x1 - x0 + h * 1.2) / k, h * 1.7 / k] });
    }
    return rows.sort((a, b) => b.n - a.n).slice(0, 8);
  }
  // egy sor kivágva, 120 képpont magasra nagyítva; világos írás → sötét írás fehér alapon
  function cropRow(bmp, [x, y, w, h], thr) {
    x = Math.max(0, x); y = Math.max(0, y); w = Math.min(bmp.width - x, w); h = Math.min(bmp.height - y, h);
    const k = 120 / h, cv = document.createElement("canvas");
    cv.width = Math.round(w * k); cv.height = 120;
    const g = cv.getContext("2d", { willReadFrequently: true }); g.imageSmoothingQuality = "high";
    g.drawImage(bmp, x, y, w, h, 0, 0, cv.width, cv.height);
    const img = g.getImageData(0, 0, cv.width, cv.height), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const m = Math.max(d[i], d[i + 1], d[i + 2]); d[i] = d[i + 1] = d[i + 2] = thr ? (m > thr ? 0 : 255) : 255 - m; }
    g.putImageData(img, 0, 0);
    return cv;
  }
  // 4–7 jegyű egész számok (a dátum, az óra, a tizedes napi km és a hőmérséklet kiesik); „322 913” is jó
  function kmNumbers(t) {
    t = t.replace(/(\d) (?=\d{3}(?![\d.,]))/g, "$1");
    return [...t.matchAll(/(?<![\d.,:\/-])\d{4,7}(?!\d|[.,:]\d)/g)].map(m => Number(m[0]));
  }
  // refKm: az eddigi km-állás; ennél kisebbet vagy jóval nagyobbat nem fogadunk el elsőre
  async function odometer(file, refKm, onProgress) {
    const w = await worker();
    const bmp = await createImageBitmap(file);
    const votes = new Map(), add = n => votes.set(n, (votes.get(n) || 0) + 1);
    const T = [140, 190, 225];
    for (let i = 0; i < T.length; i++) {
      if (onProgress) onProgress(i + 1, T.length);
      for (const r of findRows(bmp, T[i])) {
        for (const [thr, wl] of [[0, ""], [170, ""], [0, "0123456789 .:kmKM"]]) {
          await w.setParameters({ tessedit_pageseg_mode: "7", tessedit_char_whitelist: wl });
          kmNumbers((await w.recognize(cropRow(bmp, r.box, thr))).data.text || "").forEach(add);
        }
      }
    }
    bmp.close && bmp.close();
    const all = [...votes.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const ok = refKm > 0 ? all.filter(([n]) => n >= refKm && n <= refKm + 30000) : all.filter(([n]) => n >= 1000);
    if (ok.length) return { km: ok[0][0], sure: true };
    if (all.length) return { km: all[0][0], sure: false };
    return {};
  }

  return { scan, parse, odometer };
})();
