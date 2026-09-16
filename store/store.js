// Dotrino — Message Store iframe.
//
// Persistencia en `localStorage` de este origen, así todas las instancias
// del messenger en el mismo navegador (web, extensión, otra pestaña) ven
// los mismos hilos.
//
// Esquema:
//   `cc.store.threads`  → JSON `{ [threadKey: string]: ThreadEntry[] }`
//
// El threadKey lo decide la app que llama (típicamente la pubkey JWK del
// contacto). Las entradas son objetos opacos para este store; solo se le
// pide tener `id` y `ts` para deduplicación y sort.

// Lo que esta página anuncia al saludar. No es la versión del paquete npm: es la del
// diálogo por `postMessage`, que solo sube cuando ese diálogo cambia.
const STORE_VERSION = '0.3.0'

// Polyfill de crypto.randomUUID: en contextos no seguros (p.ej. cuando este
// iframe se carga desde una página padre HTTP o desde un contexto sin secure
// context) `crypto.randomUUID` puede no existir aunque `crypto.subtle` sí.
// Construimos un UUIDv4 con `getRandomValues`, que está disponible siempre.
if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
  crypto.randomUUID = function () {
    const b = new Uint8Array(16)
    crypto.getRandomValues(b)
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`
  }
}

// Diagnóstico: imprime contexto al arrancar para entender en qué condiciones
// vive este iframe (secure context, top-level accessible, etc.).
try {
  let topOrigin = null
  try { topOrigin = window.top.location.origin } catch (_) { topOrigin = '(cross-origin, blocked)' }
  console.log('[cc-store] context', {
    origin: location.origin,
    href: location.href,
    isSecureContext: window.isSecureContext,
    inIframe: window !== window.top,
    topOrigin,
    cryptoRandomUUID: typeof crypto?.randomUUID === 'function',
    cryptoSubtle: !!crypto?.subtle,
    userAgent: navigator.userAgent
  })
} catch (e) { console.warn('[cc-store] context log failed', e) }

import { createSync } from './sync.js'
import * as core from './core.js'

const KEY = 'cc.store.threads.v1'          // clave del localStorage VIEJO (migración)
const IDB_NAME = 'cc-store'
const IDB_STORE = 'kv'
const IDB_KEY = 'threads.v1'
// Contador de aperturas por app ("recientes" del hub dotrino.com). Namespace
// APARTE de los hilos de mensajes: así no contamina getThreadSummaries/sync.
const OPENS_IDB_KEY = 'opens.v1'
const OPENS_LS_KEY = 'cc.store.opens.v1'
// Lápidas de lo borrado (ver `core.js`): sin ellas, un borrado vuelve desde la bóveda o
// desde otro aparato en la siguiente sincronización.
const TOMBS_IDB_KEY = 'tombs.v1'
const MAX_PER_THREAD_DEFAULT = 1000
let maxPerThread = MAX_PER_THREAD_DEFAULT
let sync = null
// Multi-perfil: el store se namespacea por el perfil activo. El cliente llama `setProfile`
// (con el id que da @dotrino/identity) ni bien conecta. Cada perfil = sus propios hilos/aperturas.
let _pid = null
const threadsKey = () => _pid ? `threads.${_pid}.v1` : IDB_KEY
const opensKey = () => _pid ? `opens.${_pid}.v1` : OPENS_IDB_KEY
const tombsKey = () => _pid ? `tombs.${_pid}.v1` : TOMBS_IDB_KEY

// ----- persistencia en IndexedDB -------------------------------------------
//
// Antes todo vivía en `localStorage` de este origen (~5 MB, compartido por todas
// las apps del ecosistema, con evicción del más viejo al llenarse). Ahora el
// backend es **IndexedDB**: cuota dinámica (cientos de MB–GB según disco), sin el
// techo de 5 MB. Pedimos `navigator.storage.persist()` para que el almacenamiento
// sea **no-evictable**. La API (postMessage) y el sync no cambian.
//
// Modelo: una copia en memoria (`state`) del mapa `{threadKey: ThreadEntry[]}`,
// idéntico al esquema anterior, persistida como un único registro en IndexedDB.

let idb = null
let state = {}            // copia de trabajo en memoria
let opens = {}            // { [appId]: { count, ts } } — contador de aperturas
let tombs = {}            // { [threadKey]: { [id]: [ts, at] } } — lo borrado
let usingFallback = false // true si IndexedDB no está disponible (→ localStorage)
let initPromise = null

function isQuotaError (e) {
  return e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014 || /quota/i.test(e.message || ''))
}
function bytesOfString (s) { return new Blob([s]).size }

function openIdb () {
  return new Promise((resolve, reject) => {
    let req
    try { req = indexedDB.open(IDB_NAME, 1) } catch (e) { reject(e); return }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
function idbGet (db, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly')
    const r = tx.objectStore(IDB_STORE).get(key)
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}
function idbSet (db, key, val) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite')
    tx.objectStore(IDB_STORE).put(val, key)
    tx.oncomplete = () => resolve(true)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/**
 * ADOPTA LO QUE GUARDÓ LA VERSIÓN ANTERIOR A IndexedDB.
 *
 * Esto existió, y el 2026-06-25 el commit que metió el namespace por perfil se lo
 * llevó por delante sin que nadie lo notara: a partir de ahí, todo el que tenía hilos
 * en `cc.store.threads.v1` los perdía EN SILENCIO al actualizar. La prueba que lo
 * detectaba llevaba desde entonces en rojo porque nadie corría la suite.
 *
 * Se adopta para el perfil que lo mire primero, y la clave vieja se borra: no había
 * varios perfiles cuando se escribió, así que esos datos son de uno solo y duplicarlos
 * en cada cuenta sería peor que perderlos.
 */
async function adoptarLegado (lsKey, actual) {
  if (actual && Object.keys(actual).length) return actual   // ya hay algo: no se pisa
  let viejo = null
  try { const raw = localStorage.getItem(lsKey); viejo = raw ? JSON.parse(raw) : null } catch (_) { return actual }
  if (!viejo || typeof viejo !== 'object' || !Object.keys(viejo).length) return actual
  try { localStorage.removeItem(lsKey) } catch (_) { /* se adopta igual */ }
  console.log('[cc-store] adopted what the version before IndexedDB had saved:', lsKey)
  return viejo
}

// Inicializa el backend: abre IndexedDB, carga el estado y adopta (una vez) los
// datos del localStorage viejo si IndexedDB está vacío. Si IndexedDB no está
// disponible (p.ej. modo privado), cae a localStorage para no perder función.
async function init () {
  try { if (navigator.storage?.persist) await navigator.storage.persist() } catch (_) { /* best-effort */ }
  try {
    idb = await openIdb()
    const stored = await idbGet(idb, threadsKey())
    state = (stored && typeof stored === 'object') ? stored : {}
    state = await adoptarLegado(KEY, state)
    if (Object.keys(state).length) await idbSet(idb, threadsKey(), state).catch(() => {})
  } catch (e) {
    console.warn('[cc-store] IndexedDB no disponible, uso localStorage:', e)
    usingFallback = true
    idb = null
    try { const raw = localStorage.getItem(threadsKey()); state = raw ? JSON.parse(raw) : {} } catch { state = {} }
    state = await adoptarLegado(KEY, state)
  }
  // Carga el contador de aperturas (namespace aparte de los hilos).
  try {
    const stored = idb ? await idbGet(idb, opensKey()) : JSON.parse(localStorage.getItem(opensKey()) || 'null')
    opens = (stored && typeof stored === 'object') ? stored : {}
  } catch (_) { opens = {} }
  if (opensKey() !== OPENS_LS_KEY) opens = await adoptarLegado(OPENS_LS_KEY, opens)
  await loadTombs()
}

async function loadTombs () {
  const stored = idb ? await idbGet(idb, tombsKey()) : JSON.parse(localStorage.getItem(tombsKey()) || 'null')
  tombs = (stored && typeof stored === 'object') ? stored : {}
  if (core.pruneTombs(tombs, Date.now())) await writeTombs()
}

// Las lápidas se escriben con los hilos: si no se guardan, el borrado resucita al sincronizar.
// Por eso aquí un fallo se LANZA, no se anota y se sigue.
async function writeTombs () {
  if (!usingFallback && idb) { await idbSet(idb, tombsKey(), tombs); return }
  localStorage.setItem(tombsKey(), JSON.stringify(tombs))
}
initPromise = init()

// Persiste el contador de aperturas. Es un mapa pequeño (acotado por el número
// de apps), así que no necesita la red de evicción de los hilos.
async function writeOpens () {
  try {
    if (!usingFallback && idb) { await idbSet(idb, opensKey(), opens); return true }
    localStorage.setItem(opensKey(), JSON.stringify(opens)); return true
  } catch (e) { console.warn('[store] persist opens failed:', e); return false }
}

function loadAll () { return state }

function dropOldest (data, fraction = 0.2) {
  // Aplana todas las entradas, ordena por ts asc, descarta los primeros N%.
  // Solo se usa como red de seguridad ante QuotaExceededError (muy raro en IDB).
  const flat = []
  for (const [k, arr] of Object.entries(data)) {
    for (const e of arr) flat.push({ k, ts: e.ts || 0, id: e.id })
  }
  if (flat.length === 0) return false
  flat.sort((a, b) => a.ts - b.ts)
  const toDrop = Math.max(1, Math.floor(flat.length * fraction))
  const drop = new Set(flat.slice(0, toDrop).map(x => x.k + '|' + x.id))
  for (const k of Object.keys(data)) {
    data[k] = data[k].filter(e => !drop.has(k + '|' + e.id))
    if (data[k].length === 0) delete data[k]
  }
  return true
}

// Escribe el estado al backend. Async (IndexedDB). Mantiene la red de evicción
// solo si el backend devolviera QuotaExceededError.
async function writeState () {
  if (usingFallback || !idb) {
    for (let attempt = 0; attempt < 8; attempt++) {
      try { localStorage.setItem(threadsKey(), JSON.stringify(state)); return true }
      catch (e) {
        if (!isQuotaError(e)) { console.warn('[store] persist (ls) failed:', e); return false }
        if (!dropOldest(state, 0.2)) { console.warn('[store] quota — nada que evictar'); return false }
      }
    }
    return false
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    try { await idbSet(idb, threadsKey(), state); return true }
    catch (e) {
      if (!isQuotaError(e)) { console.warn('[store] persist (idb) failed:', e); return false }
      if (!dropOldest(state, 0.2)) { console.warn('[store] quota — nada que evictar'); return false }
    }
  }
  return false
}

// Reemplaza el estado y lo persiste. Async para garantizar durabilidad antes de
// responder al llamador. `silent` evita marcar el sync como sucio (al aplicar
// merges venidos del propio sync).
async function persist (data, { silent = false } = {}) {
  state = data
  const ok = await writeState()
  if (ok && !silent && sync) sync.markDirty()
  return ok
}

// ----- merge for sync -----

function mergeThreads (localThreads, remoteThreads) {
  const out = { ...localThreads }
  const changed = core.mergeEntries(out, tombs, remoteThreads, { mode: 'merge', max: maxPerThread })
  return { merged: out, changed: changed.size > 0 }
}

async function exportLocalForSync () {
  return { threads: loadAll() }
}

async function applyMergedFromSync (mergedState) {
  if (mergedState && mergedState.threads) {
    await persist(mergedState.threads, { silent: true })
  }
}

async function mergeForSync (local, remote) {
  if (!remote) return { merged: local, changed: false }
  const { merged, changed } = mergeThreads(local.threads || {}, remote.threads || {})
  return { merged: { threads: merged }, changed }
}

// ----- handlers -----

const handlers = {
  async ping () { return { pong: true, version: '0.4.0' } },

  // ----- contador de aperturas por app (tab "Recientes" del hub) -----
  // Cross-app: cada app del ecosistema (vía <dotrino-support>) registra su
  // propia apertura aquí; el hub dotrino.com lee el agregado. 100% local al
  // navegador, sin servidor ni terceros.
  async recordOpen ({ appId }) {
    if (!appId || typeof appId !== 'string') throw new Error('appId required')
    const prev = opens[appId]
    opens[appId] = { count: (prev?.count || 0) + 1, ts: Date.now() }
    await writeOpens()
    return opens[appId]
  },

  /** Devuelve { [appId]: { count, ts } } para construir la lista de recientes. */
  async getOpens () {
    return { ...opens }
  },

  async clearOpens () {
    opens = {}
    await writeOpens()
    return { ok: true }
  },

  // ----- export / import (used by sync, also exposed to apps) -----

  async exportThreads () { return { threads: loadAll() } },
  /**
   * `merge`: gana el `ts` mayor. `upsert`: con el mismo `ts` gana lo que llega. `tombs`
   * ({ [threadKey]: [[id, ts, at]] }) entierra antes de mezclar. `changed`: los hilos que
   * cambiaron, para que quien sincroniza sepa qué avisar.
   */
  async importThreads ({ threads = {}, tombs: incomingTombs, mode = 'merge' }) {
    if (!threads || typeof threads !== 'object') throw new Error('threads required')
    if (mode === 'replace') { await persist(threads); return { mode, count: Object.keys(threads).length, changed: Object.keys(threads) } }
    if (mode !== 'merge' && mode !== 'upsert') throw new Error(`unknown import mode: ${mode}`)
    const data = loadAll()
    const buried = core.applyTombs(data, tombs, incomingTombs, Date.now())
    const merged = core.mergeEntries(data, tombs, threads, { mode, max: maxPerThread })
    const changed = new Set([...buried.changed, ...merged])
    if (buried.tombsChanged) await writeTombs()
    if (changed.size) await persist(data)
    return { mode, count: Object.keys(data).length, changed: [...changed] }
  },

  // ----- sincronizar con la bóveda por partes (lo usa el cliente, ver src/vault-sync.js) -----

  async getThreadDigests ({ keys } = {}) { return core.digestsOf(loadAll(), keys) },

  /** Índice completo (ids, ts y lápidas) de los hilos pedidos, y el tope por hilo vigente. */
  async getThreadIndexes ({ keys }) {
    if (!Array.isArray(keys)) throw new Error('keys required')
    return { indexes: core.indexPage(loadAll(), tombs, keys, null, Infinity).indexes, max: maxPerThread }
  },

  /** Las entradas pedidas por id y las lápidas de `tombRefs` / de los hilos `tombKeys`. */
  async getEntries ({ refs, tombRefs, tombKeys }) {
    return { threads: core.entriesPage(loadAll(), refs, Infinity).threads, tombs: core.pickTombs(tombs, tombRefs, tombKeys) }
  },

  async mergeOpens ({ opens: incoming }) {
    if (core.mergeOpens(opens, incoming)) await writeOpens()
    return { ...opens }
  },

  // ----- Drive sync -----

  async syncConnect ({ clientId }) {
    if (!sync) throw new Error('sync not ready')
    return sync.connectGoogle(clientId)
  },
  async syncDisconnect () { if (sync) return sync.disconnectGoogle() },
  async syncUnlock ({ passphrase }) {
    if (!sync) throw new Error('sync not ready')
    return sync.unlock(passphrase)
  },
  async syncLock () { if (sync) return sync.lock() },
  async syncStatus () { return sync ? sync.getStatus() : { connected: false, unlocked: false, dirty: false } },
  async syncNow () {
    if (!sync) throw new Error('sync not ready')
    await sync.pull(); await sync.push(); return sync.getStatus()
  },


  async setMaxPerThread ({ max }) {
    maxPerThread = Math.max(1, Math.min(core.MAX_PER_THREAD_LIMIT, Number(max) || MAX_PER_THREAD_DEFAULT))
    return { maxPerThread }
  },

  async appendMessage ({ threadKey, entry }) {
    const data = loadAll()
    const { tombCleared } = core.writeEntry(data, tombs, threadKey, entry, { max: maxPerThread, now: Date.now(), newId: () => crypto.randomUUID() })
    if (tombCleared) await writeTombs()
    await persist(data)
    return entry
  },

  async listThread ({ threadKey, limit, before }) {
    if (!threadKey) return []
    const data = loadAll()
    let arr = data[threadKey] || []
    if (typeof before === 'number') arr = arr.filter(e => (e.ts || 0) < before)
    if (typeof limit === 'number' && limit > 0) arr = arr.slice(-limit)
    return arr
  },

  async listThreadKeys () {
    return Object.keys(loadAll())
  },

  /**
   * Devuelve { [threadKey]: { lastEntry, count } } para construir la sidebar
   * de la app sin tener que pedir cada hilo entero.
   */
  async getThreadSummaries () {
    const data = loadAll()
    const out = {}
    for (const [k, arr] of Object.entries(data)) {
      out[k] = {
        lastEntry: arr.length ? arr[arr.length - 1] : null,
        count: arr.length
      }
    }
    return out
  },

  async removeThread ({ threadKey }) {
    const data = loadAll()
    const removed = core.removeWholeThread(data, tombs, threadKey, Date.now())
    if (removed) { await writeTombs(); await persist(data) }
    return { removed }
  },

  async removeMessage ({ threadKey, id }) {
    const data = loadAll()
    const removed = core.removeEntry(data, tombs, threadKey, id, Date.now())
    if (removed) { await writeTombs(); await persist(data) }
    return { removed }
  },

  /** Borra todos los hilos del perfil, con lápida: `keys` son los que había, para propagarlo. */
  async clearAll () {
    const data = loadAll()
    const keys = Object.keys(data)
    const now = Date.now()
    for (const k of keys) core.removeWholeThread(data, tombs, k, now)
    await writeTombs()
    await persist({})
    try { localStorage.removeItem(threadsKey()) } catch (_) { /* */ }
    return { ok: true, keys }
  },

  // ----- multi-perfil -----
  // El cliente fija el perfil activo ni bien conecta (con el id de @dotrino/identity); cada
  // perfil tiene sus propios hilos/aperturas. Cambiar de perfil NO borra nada (recarga y re-init).
  async setProfile ({ profileId }) {
    const pid = profileId || null
    if (pid === _pid) return { ok: true, profileId: _pid }
    _pid = pid
    if (idb) {
      const t = await idbGet(idb, threadsKey()); state = (t && typeof t === 'object') ? t : {}
      const o = await idbGet(idb, opensKey()); opens = (o && typeof o === 'object') ? o : {}
    } else {
      try { state = JSON.parse(localStorage.getItem(threadsKey()) || '{}') || {} } catch { state = {} }
      try { opens = JSON.parse(localStorage.getItem(opensKey()) || '{}') || {} } catch { opens = {} }
    }
    await loadTombs()
    return { ok: true, profileId: _pid }
  },

  // Borra SOLO el store del perfil activo. Se llama cuando el vault REVOCA el acceso de
  // ese perfil (los datos vivían en el vault; la cache local de ESE perfil se limpia). Los
  // demás perfiles quedan intactos.
  async wipeProfile () {
    state = {}; opens = {}; tombs = {}
    try {
      if (idb) { await idbSet(idb, threadsKey(), {}); await idbSet(idb, opensKey(), {}); await idbSet(idb, tombsKey(), {}) }
      else { localStorage.removeItem(threadsKey()); localStorage.removeItem(opensKey()); localStorage.removeItem(tombsKey()) }
    } catch (_) { /* best-effort */ }
    return { ok: true, profileId: _pid }
  },

  /** Tamaño total + por hilo. Útil para mostrar "uso de almacenamiento". */
  async getStats () {
    const data = loadAll()
    const totalBytes = bytesOfString(JSON.stringify(data))
    const threads = {}
    for (const [k, arr] of Object.entries(data)) {
      threads[k] = {
        count: arr.length,
        bytes: bytesOfString(JSON.stringify(arr))
      }
    }
    // Cuota real del origen (IndexedDB): `usage`/`quota` en bytes y si el
    // almacenamiento es persistente (no-evictable). `backend` indica el motor.
    let usage = null
    let quota = null
    let persisted = null
    try {
      if (navigator.storage?.estimate) { const est = await navigator.storage.estimate(); usage = est.usage ?? null; quota = est.quota ?? null }
      if (navigator.storage?.persisted) persisted = await navigator.storage.persisted()
    } catch (_) { /* best-effort */ }
    return {
      totalBytes, threadCount: Object.keys(data).length, threads,
      backend: usingFallback ? 'localStorage' : 'indexeddb',
      usage, quota, persisted
    }
  }
}

// ----- bootstrap -----

sync = createSync({
  fileName: 'dotrino-store-backup.json',
  kind: 'store',
  exportLocal: exportLocalForSync,
  applyMerged: applyMergedFromSync,
  mergeFn: mergeForSync
})

sync.onStatus((payload) => {
  if (window.parent && window.parent !== window) {
    try { window.parent.postMessage({ _ccs: true, type: 'event', event: 'sync', payload }, '*') } catch {}
  }
})

window.addEventListener('message', async (event) => {
  const msg = event.data
  if (!msg || msg._ccs !== true) return
  // «¿Estás?» de quien nos carga: el `ready` de más abajo se manda una sola vez, al
  // cargar, y quien no lo reciba se queda esperando para siempre. Esto lo repone sin
  // recargar el iframe (el cliente pregunta mientras espera).
  if (msg.type === 'hello') {
    event.source?.postMessage({ _ccs: true, type: 'ready', version: STORE_VERSION }, event.origin)
    return
  }
  if (msg.type !== 'request') return
  const { id, method, params } = msg
  const reply = (payload) => event.source?.postMessage(
    { _ccs: true, type: 'response', id, ...payload },
    event.origin
  )
  const handler = handlers[method]
  if (!handler) return reply({ error: `Unknown method: ${method}` })
  try {
    await initPromise            // backend (IndexedDB) listo antes de servir
    reply({ result: await handler(params || {}) })
  }
  catch (e) { reply({ error: e?.message || String(e), code: e?.code || null }) }
})

// Notify parent we are ready
if (window.parent && window.parent !== window) {
  window.parent.postMessage({ _ccs: true, type: 'ready', version: STORE_VERSION }, '*')
}
