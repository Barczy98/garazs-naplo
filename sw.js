// Offline működés: az app fájljait a telefon eltárolja.
// Új verzió kiadásakor a CACHE nevét növelni kell.
const PREFIX = "garazs-" + new URL(self.registration.scope).pathname.replace(/[^a-z0-9]/gi, "") + "-";
const CACHE = PREFIX + "v2.9.3";
// A nagy, nem változó könyvtárak (lib/: pdf.js, Tesseract) külön tárban vannak, ami a kiadások között is megmarad.
// Ha egy könyvtár fájlja egyszer mégis változik, ezt a nevet kell növelni.
const LIB = PREFIX + "lib-1";
const FILES = ["./", "index.html", "config.js", "style.css", "app.js", "vault.js", "receipt.js", "manifest.webmanifest",
  "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png"];
const LIBS = ["lib/pdfjs/pdf.min.js", "lib/pdfjs/pdf.worker.min.js"];
// ha a hálózat ennyi idő alatt nem válaszol, a tárolt változat jön (gyenge térerőnél ne várjon az app)
const NET_WAIT = 4000;
// ha egyszer kivárta a NET_WAIT-et, a következő fél percben a többi fájl is rögtön a tárból jön (különben fájlonként újra várna)
let slowUntil = 0;

self.addEventListener("install", e => {
  e.waitUntil(Promise.all([
    caches.open(CACHE).then(c => c.addAll(FILES)),
    caches.open(LIB).then(c => Promise.all(LIBS.map(f => c.match(f).then(r => r || c.add(f)))))
  ]).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => (k.startsWith(PREFIX) && k !== CACHE && k !== LIB) || /^garazs-v\d/.test(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // könyvtárak: előbb a telefonról, csak ha még nincs meg, akkor a hálózatról (pl. a PDF-megjelenítő 1,4 MB-ja nem töltődik le minden megnyitáskor)
  if (url.origin === self.location.origin && url.pathname.includes("/lib/")) {
    e.respondWith(caches.open(LIB).then(c => c.match(req, { ignoreSearch: true }).then(r => r || fetch(req).then(res => {
      if (res.ok) c.put(req, res.clone());
      return res;
    }))));
    return;
  }
  // az app fájljai: hálózat először (így a frissítések megjönnek); ha nincs net, vagy NET_WAIT alatt nem válaszol, a tárolt változat
  const t0 = Date.now();
  const net = fetch(req).then(res => {
    if (Date.now() - t0 < NET_WAIT) slowUntil = 0;   // újra gyors a net: a következő kérések megint a hálózatról jönnek
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  });
  e.waitUntil(net.catch(() => {}));   // a lassú válasz is bekerüljön a tárba a következő indításhoz
  const stored = () => caches.match(req, { ignoreSearch: true }).then(r => r || (req.mode === "navigate" ? caches.match("index.html") : undefined));
  e.respondWith(new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done && r) { done = true; resolve(r); } };
    const timer = setTimeout(() => { slowUntil = Date.now() + 30000; stored().then(finish); }, Date.now() < slowUntil ? 0 : NET_WAIT);
    net.then(res => { clearTimeout(timer); finish(res); })
      .catch(() => { clearTimeout(timer); stored().then(r => { finish(r || Response.error()); }); });
  }));
});
