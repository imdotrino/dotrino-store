/**
 * Las reglas de los hilos, en UN sitio: qué gana al mezclar, qué deja un borrado y cómo se
 * compara lo que tiene cada lado.
 *
 * Lo importan DOS piezas que tienen que estar de acuerdo byte a byte: la página del almacén
 * (`store.dotrino.com`, IndexedDB del navegador) y la bóveda (`dotrino-vault`, su
 * `threads.json`). Si cada una llevara su copia, bastaría con que una cambiara el orden de
 * una comparación para que las huellas no coincidieran nunca y la sincronización se
 * repitiera para siempre sin decir por qué.
 *
 * Sin DOM y sin Node: solo `crypto.subtle` y `TextEncoder`, que están en los dos.
 *
 * Modelo:
 *   threads: { [threadKey]: Entry[] }             Entry = { id, ts, ... } opaca
 *   tombs:   { [threadKey]: { [id]: [ts, at] } }  «la versión `ts` de `id` se borró en `at`»
 *
 * La lápida guarda el `ts` de lo que se borró, no la hora del borrado: así decidir si una
 * copia que llega de otro aparato es la borrada no depende del reloj de nadie. Una versión
 * posterior (ts mayor) sí entra: se editó en otro sitio después de borrarla aquí.
 */

/** Tope de entradas por hilo que acepta cualquier lado. La página del almacén no pasa de aquí. */
export const MAX_PER_THREAD_LIMIT = 50000

/** Una lápida se olvida a los 180 días: un aparato apagado más tiempo que eso puede resucitar lo borrado. */
export const TOMB_TTL_MS = 180 * 24 * 60 * 60 * 1000

/**
 * Tope de bytes de una respuesta por partes. Con el cifrado de punta a punta (base64, ×4/3)
 * y el sobre del mensaje, queda holgado bajo el 1 MB que corta el proxio.
 */
export const PAGE_BYTES = 400_000

const encoder = new TextEncoder()
export const byteLength = (value) => encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).length

const has = (obj, key) => obj != null && Object.hasOwn(obj, key)

/** `__proto__` como clave de hilo o id reescribiría el prototipo del mapa al asignar. */
export function validKey (key) {
  return typeof key === 'string' && key.length > 0 && key !== '__proto__'
}

function assertKey (key) {
  if (!validKey(key)) throw new Error('threadKey required')
}

const idOf = (entry) => String(entry.id)

// ----- huella -----

/**
 * SHA-256 de «id TAB ts» por entrada, ordenadas por id (unidades UTF-16, igual en los dos
 * lados). Cambia si entra, sale o se reescribe una entrada: reescribir sube `ts`.
 * Las lápidas NO entran: se olvidan por fecha, y cada lado las olvida a su hora.
 */
export async function threadDigest (entries) {
  const lines = entries
    .map((e) => `${String(e.id)}\t${Number(e.ts) || 0}`)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(lines.join('\n')))
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Huella de cada hilo con entradas (o solo de `keys`, si se pasan). */
export async function digestsOf (threads, keys) {
  const out = {}
  const list = Array.isArray(keys) ? keys.filter((k) => validKey(k) && has(threads, k)) : Object.keys(threads)
  for (const k of list) {
    const arr = threads[k]
    if (!Array.isArray(arr) || arr.length === 0) continue
    out[k] = { count: arr.length, digest: await threadDigest(arr) }
  }
  return out
}

// ----- lápidas -----

export function tombOf (tombs, k, id) {
  return has(tombs, k) && has(tombs[k], String(id)) ? tombs[k][String(id)] : undefined
}

/** ¿Esta versión de la entrada es una que se borró (o anterior)? */
export function isBuried (tombs, k, entry) {
  const t = tombOf(tombs, k, entry.id)
  return !!t && (Number(entry.ts) || 0) <= t[0]
}

/** Anota un borrado. Si ya había lápida, se queda la versión más nueva y la fecha más vieja. */
export function bury (tombs, k, id, ts, at) {
  const key = String(id)
  if (!validKey(k) || key === '__proto__') return false
  const t = has(tombs, k) ? tombs[k] : (tombs[k] = {})
  const prev = has(t, key) ? t[key] : null
  const next = prev ? [Math.max(prev[0], ts), Math.min(prev[1], at)] : [ts, at]
  if (prev && prev[0] === next[0] && prev[1] === next[1]) return false
  t[key] = next
  return true
}

function unbury (tombs, k, id) {
  const key = String(id)
  if (!has(tombs, k) || !has(tombs[k], key)) return false
  delete tombs[k][key]
  if (Object.keys(tombs[k]).length === 0) delete tombs[k]
  return true
}

/** Olvida las lápidas de hace más de `TOMB_TTL_MS`. */
export function pruneTombs (tombs, now) {
  let changed = false
  for (const k of Object.keys(tombs)) {
    for (const [id, [, at]] of Object.entries(tombs[k])) {
      if (at < now - TOMB_TTL_MS) { delete tombs[k][id]; changed = true }
    }
    if (Object.keys(tombs[k]).length === 0) { delete tombs[k]; changed = true }
  }
  return changed
}

/**
 * Aplica lápidas que llegan de otro lado: las anota y quita las entradas que entierran.
 * `incoming`: { [threadKey]: [[id, ts, at], ...] }. Devuelve los hilos cuyas entradas cambiaron.
 */
export function applyTombs (threads, tombs, incoming, now) {
  const changed = new Set()
  let tombsChanged = false
  for (const [k, list] of Object.entries(incoming || {})) {
    if (!validKey(k) || !Array.isArray(list)) continue
    for (const row of list) {
      if (!Array.isArray(row) || row.length < 2) continue
      const [id, ts, at] = row
      if (typeof ts !== 'number') continue
      if (bury(tombs, k, id, ts, typeof at === 'number' ? at : now)) tombsChanged = true
    }
    if (!has(threads, k)) continue
    const kept = threads[k].filter((e) => !isBuried(tombs, k, e))
    if (kept.length === threads[k].length) continue
    if (kept.length) threads[k] = kept; else delete threads[k]
    changed.add(k)
  }
  return { changed, tombsChanged }
}

// ----- escribir -----

/**
 * Mezcla entradas que llegan. `merge`: gana la de `ts` mayor. `upsert`: con el mismo `ts`
 * gana la que llega (es una escritura de su dueño, no una copia vieja). Lo enterrado no
 * entra. Devuelve los hilos que cambiaron.
 */
export function mergeEntries (threads, tombs, incoming, { mode = 'merge', max = MAX_PER_THREAD_LIMIT } = {}) {
  const changed = new Set()
  for (const [k, arr] of Object.entries(incoming || {})) {
    if (!validKey(k) || !Array.isArray(arr) || arr.length === 0) continue
    const current = has(threads, k) ? threads[k] : []
    const byId = new Map()
    for (const e of current) if (e && e.id != null) byId.set(idOf(e), e)
    let touched = false
    for (const e of arr) {
      if (!e || typeof e !== 'object' || e.id == null) continue
      if (isBuried(tombs, k, e)) continue
      const prev = byId.get(idOf(e))
      const ts = Number(e.ts) || 0
      const prevTs = Number(prev?.ts) || 0
      if (!prev || ts > prevTs || (mode === 'upsert' && ts === prevTs)) { byId.set(idOf(e), e); touched = true }
    }
    if (!touched) continue
    const merged = Array.from(byId.values()).sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0))
    if (merged.length > max) merged.splice(0, merged.length - max)
    threads[k] = merged
    changed.add(k)
  }
  return changed
}

/**
 * Escritura directa de una entrada (`appendMessage`): mezcla superficial con la que ya
 * estaba y quita su lápida, porque escribirla de nuevo es decir que vuelve.
 */
export function writeEntry (threads, tombs, k, entry, { max, now, newId }) {
  assertKey(k)
  if (!entry || typeof entry !== 'object') throw new Error('entry required')
  if (entry.id == null) entry.id = newId()
  if (!entry.ts) entry.ts = now
  const tombCleared = unbury(tombs, k, entry.id)
  const arr = has(threads, k) ? threads[k] : (threads[k] = [])
  const i = arr.findIndex((e) => e && e.id != null && idOf(e) === idOf(entry))
  if (i >= 0) arr[i] = { ...arr[i], ...entry }; else arr.push(entry)
  if (arr.length > max) arr.splice(0, arr.length - max)
  return { entry, tombCleared }
}

/** Borra una entrada y deja su lápida. */
export function removeEntry (threads, tombs, k, id, now) {
  if (!validKey(k) || id == null || !has(threads, k)) return 0
  const arr = threads[k]
  const i = arr.findIndex((e) => e && e.id != null && idOf(e) === String(id))
  if (i < 0) return 0
  const [gone] = arr.splice(i, 1)
  bury(tombs, k, gone.id, Number(gone.ts) || 0, now)
  if (arr.length === 0) delete threads[k]
  return 1
}

/** Borra un hilo entero: una lápida por cada entrada que tenía. */
export function removeWholeThread (threads, tombs, k, now) {
  if (!validKey(k) || !has(threads, k)) return 0
  const arr = threads[k]
  for (const e of arr) if (e && e.id != null) bury(tombs, k, e.id, Number(e.ts) || 0, now)
  delete threads[k]
  return arr.length
}

// ----- leer por partes -----

/**
 * Índice de los hilos `keys`: `items` [[id, ts]] y `tombs` [[id, ts, at]], por páginas de
 * `maxBytes` como mucho. `cursor` { k, o }: hilo y posición donde siguió la página anterior.
 * Siempre sale al menos una fila, o no se avanzaría nunca.
 */
export function indexPage (threads, tombs, keys, cursor, maxBytes) {
  const indexes = {}
  let bytes = 0
  let rows = 0
  let o = Number(cursor?.o) || 0
  for (let ki = Number(cursor?.k) || 0; ki < keys.length; ki++, o = 0) {
    const k = keys[ki]
    if (!validKey(k)) continue
    const arr = has(threads, k) ? threads[k] : []
    const tl = has(tombs, k) ? Object.entries(tombs[k]) : []
    const total = arr.length + tl.length
    if (total === 0) continue
    const idx = has(indexes, k) ? indexes[k] : (indexes[k] = { items: [], tombs: [] })
    for (; o < total; o++) {
      const isItem = o < arr.length
      const row = isItem ? [arr[o].id, Number(arr[o].ts) || 0] : [tl[o - arr.length][0], ...tl[o - arr.length][1]]
      const size = byteLength(row) + 1
      if (rows > 0 && bytes + size > maxBytes) return { indexes, next: { k: ki, o } }
      ;(isItem ? idx.items : idx.tombs).push(row)
      bytes += size
      rows++
    }
  }
  return { indexes, next: null }
}

/**
 * Entradas pedidas por id: `refs` { [threadKey]: [id, ...] }. Lo que no cabe en `maxBytes`
 * vuelve en `rest` para pedirlo después; lo que no existe no vuelve.
 */
export function entriesPage (threads, refs, maxBytes) {
  const out = {}
  const rest = {}
  let bytes = 0
  let count = 0
  let full = false
  for (const [k, ids] of Object.entries(refs || {})) {
    if (!validKey(k) || !Array.isArray(ids)) continue
    if (full) { rest[k] = ids.slice(); continue }
    if (!has(threads, k)) continue
    const byId = new Map(threads[k].filter((e) => e && e.id != null).map((e) => [idOf(e), e]))
    for (let i = 0; i < ids.length; i++) {
      const e = byId.get(String(ids[i]))
      if (!e) continue
      const size = byteLength(e)
      if (count > 0 && bytes + size > maxBytes) { rest[k] = ids.slice(i); full = true; break }
      ;(has(out, k) ? out[k] : (out[k] = [])).push(e)
      bytes += size
      count++
    }
  }
  return { threads: out, rest: Object.keys(rest).length ? rest : null }
}

/** Lápidas de los ids pedidos (`refs`) y todas las de los hilos `keys`, como filas [id, ts, at]. */
export function pickTombs (tombs, refs, keys) {
  const out = {}
  const add = (k, id) => {
    const t = tombOf(tombs, k, id)
    if (!t) return
    const list = has(out, k) ? out[k] : (out[k] = [])
    if (!list.some((row) => row[0] === String(id))) list.push([String(id), ...t])
  }
  for (const [k, ids] of Object.entries(refs || {})) if (validKey(k) && Array.isArray(ids)) for (const id of ids) add(k, id)
  for (const k of keys || []) if (validKey(k) && has(tombs, k)) for (const id of Object.keys(tombs[k])) add(k, id)
  return out
}

// ----- aperturas -----

/**
 * Mezcla el contador de aperturas por app: el mayor de cada lado. No suma — sumar contaría
 * dos veces lo que ya se mezcló — y así mezclar dos veces da lo mismo que una.
 */
export function mergeOpens (opens, incoming) {
  let changed = false
  for (const [app, rec] of Object.entries(incoming || {})) {
    if (!validKey(app) || !rec || typeof rec !== 'object') continue
    const count = Number(rec.count) || 0
    const ts = Number(rec.ts) || 0
    const prev = has(opens, app) ? opens[app] : null
    const next = prev ? { count: Math.max(prev.count || 0, count), ts: Math.max(prev.ts || 0, ts) } : { count, ts }
    if (prev && prev.count === next.count && prev.ts === next.ts) continue
    opens[app] = next
    changed = true
  }
  return changed
}
