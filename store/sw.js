// Service worker de store.dotrino.com: que el almacén RESPONDA SIN CONEXIÓN (CONVENCIONES §4:
// «vive en el aparato… responde offline»). Sin esto, sin red el iframe no cargaba, ninguna
// app podía guardar, y los juegos caían en silencio a localStorage (2026-09-30).
//
// Red primero para todo: son cuatro archivos pequeños y un arreglo del almacén tiene que
// llegar en el acto; la copia de la caché solo se usa cuando no hay red.
const CACHE = 'dotrino-store-v1'
const ASSETS = ['./', './index.html', './store.js', './core.js', './sync.js']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k)
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return
  event.respondWith((async () => {
    try {
      const res = await fetch(req)
      if (res.ok) {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {})
      }
      return res
    } catch (e) {
      const hit = await caches.match(req, { ignoreSearch: true }) ||
        (req.mode === 'navigate' ? await caches.match('./index.html') : null)
      if (hit) return hit
      throw e
    }
  })())
})
