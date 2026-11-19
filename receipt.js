"use strict";
/* Tankolási blokk felismerése a telefonon (Tesseract, internet nélkül is, első használat után).
   A kép nem megy el sehova. Kiolvassa: liter, egységár, fizetett összeg, dátum, benzinkút. */
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
    await w.setParameters({ tessedit_pageseg_mode: "4" });
    const a = (await w.recognize(await prepare(file))).data.text || "";
    if (onProgress) onProgress(2);
    await w.setParameters({ tessedit_pageseg_mode: "6" });
    const b = (await w.recognize(await prepareWhole(file))).data.text || "";
    return parse(a + "\n" + b);
  }
  return { scan, parse };
})();
