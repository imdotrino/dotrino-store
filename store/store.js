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

const KEY = 'cc.store.threads.v1'          // clave del localStorage VIEJO (migración)
const IDB_NAME = 'cc-store'
const IDB_STORE = 'kv'
const IDB_KEY = 'threads.v1'
// Contador de aperturas por app ("recientes" del hub dotrino.com). Namespace
// APARTE de los hilos de mensajes: así no contamina getThreadSummaries/sync.
const OPENS_IDB_KEY = 'opens.v1'
const OPENS_LS_KEY = 'cc.store.opens.v1'
const MAX_PER_THREAD_DEFAULT = 1000
let maxPerThread = MAX_PER_THREAD_DEFAULT
let sync = null

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

// Inicializa el backend: abre IndexedDB, carga el estado y migra (una vez) los
// datos del localStorage viejo si IndexedDB está vacío. Si IndexedDB no está
// disponible (p.ej. modo privado), cae a localStorage para no perder función.
async function init () {
  try { if (navigator.storage?.persist) await navigator.storage.persist() } catch (_) { /* best-effort */ }
  try {
    idb = await openIdb()
    const stored = await idbGet(idb, IDB_KEY)
    if (stored && typeof stored === 'object') {
      state = stored
    } else {
      // Migración one-time desde el localStorage anterior.
      try {
        const raw = localStorage.getItem(KEY)
        if (raw) {
          state = JSON.parse(raw) || {}
          await idbSet(idb, IDB_KEY, state)
          console.log('[cc-store] migrado localStorage → IndexedDB')
        }
      } catch (e) { console.warn('[cc-store] migración falló:', e); state = {} }
    }
  } catch (e) {
    console.warn('[cc-store] IndexedDB no disponible, uso localStorage:', e)
    usingFallback = true
    idb = null
    try { const raw = localStorage.getItem(KEY); state = raw ? JSON.parse(raw) : {} } catch { state = {} }
  }
  // Carga el contador de aperturas (namespace aparte de los hilos).
  try {
    const stored = idb ? await idbGet(idb, OPENS_IDB_KEY) : JSON.parse(localStorage.getItem(OPENS_LS_KEY) || 'null')
    opens = (stored && typeof stored === 'object') ? stored : {}
  } catch (_) { opens = {} }
}
initPromise = init()

// Persiste el contador de aperturas. Es un mapa pequeño (acotado por el número
// de apps), así que no necesita la red de evicción de los hilos.
async function writeOpens () {
  try {
    if (!usingFallback && idb) { await idbSet(idb, OPENS_IDB_KEY, opens); return true }
    localStorage.setItem(OPENS_LS_KEY, JSON.stringify(opens)); return true
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
      try { localStorage.setItem(KEY, JSON.stringify(state)); return true }
      catch (e) {
        if (!isQuotaError(e)) { console.warn('[store] persist (ls) failed:', e); return false }
        if (!dropOldest(state, 0.2)) { console.warn('[store] quota — nada que evictar'); return false }
      }
    }
    return false
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    try { await idbSet(idb, IDB_KEY, state); return true }
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
  let changed = false
  const allKeys = new Set([...Object.keys(localThreads || {}), ...Object.keys(remoteThreads || {})])
  for (const k of allKeys) {
    const a = localThreads[k] || []
    const b = remoteThreads[k] || []
    if (b.length === 0) continue
    if (a.length === 0) { out[k] = [...b].sort((x, y) => (x.ts || 0) - (y.ts || 0)); changed = true; continue }
    const byId = new Map()
    for (const e of a) if (e?.id) byId.set(e.id, e)
    let added = 0
    for (const e of b) {
      if (!e?.id) continue
      const prev = byId.get(e.id)
      if (!prev) { byId.set(e.id, e); added++ }
      else if ((e.ts || 0) > (prev.ts || 0)) { byId.set(e.id, e); added++ }
    }
    if (added > 0) {
      const merged = Array.from(byId.values()).sort((x, y) => (x.ts || 0) - (y.ts || 0))
      if (merged.length > maxPerThread) merged.splice(0, merged.length - maxPerThread)
      out[k] = merged
      changed = true
    }
  }
  return { merged: out, changed }
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
function trimThread (arr, cap) {
  if (arr.length > cap) arr.splice(0, arr.length - cap)
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
  async importThreads ({ threads, mode = 'merge' }) {
    if (!threads || typeof threads !== 'object') throw new Error('threads required')
    if (mode === 'replace') { await persist(threads); return { mode, count: Object.keys(threads).length } }
    const local = loadAll()
    const { merged } = mergeThreads(local, threads)
    await persist(merged)
    return { mode, count: Object.keys(merged).length }
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
    maxPerThread = Math.max(1, Math.min(50000, Number(max) || MAX_PER_THREAD_DEFAULT))
    return { maxPerThread }
  },

  async appendMessage ({ threadKey, entry }) {
    if (!threadKey || typeof threadKey !== 'string') throw new Error('threadKey required')
    if (!entry || typeof entry !== 'object') throw new Error('entry required')
    if (!entry.id) entry.id = crypto.randomUUID()
    if (!entry.ts) entry.ts = Date.now()
    const data = loadAll()
    if (!data[threadKey]) data[threadKey] = []
    // Dedup por id
    const existing = data[threadKey].findIndex(e => e.id === entry.id)
    if (existing >= 0) data[threadKey][existing] = { ...data[threadKey][existing], ...entry }
    else data[threadKey].push(entry)
    trimThread(data[threadKey], maxPerThread)
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
    if (!threadKey) return { removed: 0 }
    const data = loadAll()
    const removed = data[threadKey]?.length || 0
    delete data[threadKey]
    await persist(data)
    return { removed }
  },

  async removeMessage ({ threadKey, id }) {
    if (!threadKey || !id) return { removed: 0 }
    const data = loadAll()
    const arr = data[threadKey] || []
    const before = arr.length
    data[threadKey] = arr.filter(e => e.id !== id)
    if (data[threadKey].length === 0) delete data[threadKey]
    await persist(data)
    return { removed: before - (data[threadKey]?.length || 0) }
  },

  async clearAll () {
    await persist({})
    try { localStorage.removeItem(KEY) } catch (_) { /* */ }
    return { ok: true }
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
  if (!msg || msg._ccs !== true || msg.type !== 'request') return
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
  catch (e) { reply({ error: e?.message || String(e) }) }
})

// Notify parent we are ready
if (window.parent && window.parent !== window) {
  window.parent.postMessage({ _ccs: true, type: 'ready', version: '0.1.0' }, '*')
}
