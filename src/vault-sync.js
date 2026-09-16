/**
 * RESPALDO DEL ALMACÉN EN LA BÓVEDA DEL USUARIO, por partes y a la vista.
 *
 * Hasta 0.10.0 esto movía el almacén ENTERO en un mensaje (`exportThreads`/`importThreads`),
 * y el proxio corta los mensajes en 1 MB: pasado ese tamaño la sincronización dejaba de
 * caber, el error se tragaba en un `catch` vacío y el almacén seguía «solo en este
 * navegador» sin que nadie lo supiera. Ahora:
 *
 *   · Lee y escribe SIEMPRE en el navegador: responde al instante y sin conexión.
 *   · Lo que escribes sube a la bóveda por detrás, en tandas de menos de 1 MB. Si no
 *     sube, queda `pending` y se reintenta.
 *   · Para ponerse al día compara una huella por hilo y solo trabaja los que difieren:
 *     primero el índice (id y ts), después solo las entradas que faltan en cada lado.
 *   · Los borrados dejan lápida (`store/core.js`), así no vuelven desde otro aparato.
 *   · El estado se ve (`status`): al día, sincronizando, apagado y por qué, o el error.
 *
 * Nada de lo que viaja va en claro: `identity.vaultStore` lo cifra con la clave de contenido
 * del perfil, y sin esa clave falla (`no-content-key`) en vez de mandarlo a la vista.
 */
import { byteLength } from '../store/core.js'

/** Tope de una tanda de subida. Cifrada (base64, ×4/3) y con su sobre queda bajo 1 MB. */
const PUSH_BYTES = 350_000
/** Tope de la lista de ids de una petición de entradas. */
const REF_BYTES = 150_000
/** Una entrada sola más grande que esto no cabe por el proxio, ni sola. */
const MAX_ENTRY_BYTES = 550_000
const FLUSH_DELAY_MS = 1500
const RESYNC_EVERY_MS = 5 * 60_000
const VISIBLE_GAP_MS = 60_000
const RETRY_MS = [15_000, 60_000, 5 * 60_000]

function codeError (code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

const emptyDirty = () => ({ ids: new Map(), tombIds: new Map(), tombKeys: new Set(), clearOpens: false })

function dirtyCount (d) {
  let n = d.tombKeys.size + (d.clearOpens ? 1 : 0)
  for (const set of d.ids.values()) n += set.size
  for (const set of d.tombIds.values()) n += set.size
  return n
}

function addTo (map, k, id) {
  if (!map.has(k)) map.set(k, new Set())
  map.get(k).add(String(id))
}

function mergeDirty (into, from) {
  for (const [k, set] of from.ids) for (const id of set) addTo(into.ids, k, id)
  for (const [k, set] of from.tombIds) for (const id of set) addTo(into.tombIds, k, id)
  for (const k of from.tombKeys) into.tombKeys.add(k)
  into.clearOpens = into.clearOpens || from.clearOpens
}

const toObject = (map) => Object.fromEntries([...map].map(([k, set]) => [k, [...set]]))
const nonEmpty = (obj) => Object.keys(obj).length > 0

/**
 * Qué hay que mover de un hilo, mirando solo los índices de los dos lados.
 * `max`: el tope por hilo del navegador. Si el hilo ya está lleno, no se baja lo que el
 * recorte tiraría en cuanto llegara (volvería a faltar y se bajaría otra vez, siempre).
 */
export function planThread (local, remote, max) {
  const L = local || { items: [], tombs: [] }
  const R = remote || { items: [], tombs: [] }
  const lItems = new Map(L.items.map(([id, ts]) => [String(id), ts]))
  const rItems = new Map(R.items.map(([id, ts]) => [String(id), ts]))
  const lTombs = new Map(L.tombs.map(([id, ts]) => [String(id), ts]))
  const rTombs = new Map(R.tombs.map((row) => [String(row[0]), row]))
  const plan = { pushIds: [], pushTombs: [], pullIds: [], pullTombs: [] }

  for (const [id, ts] of lTombs) {
    const r = rItems.get(id)
    if (r !== undefined && r <= ts) plan.pushTombs.push(id)
  }
  for (const [id, row] of rTombs) {
    const l = lItems.get(id)
    if (l !== undefined && l <= row[1]) plan.pullTombs.push([id, row[1], row[2]])
  }
  for (const [id, ts] of lItems) {
    const rt = rTombs.get(id)
    if (rt && ts <= rt[1]) continue
    const r = rItems.get(id)
    if (r === undefined || ts > r) plan.pushIds.push(id)
  }
  const full = lItems.size >= max
  let oldest = Infinity
  if (full) for (const ts of lItems.values()) if (ts < oldest) oldest = ts
  for (const [id, ts] of rItems) {
    const lt = lTombs.get(id)
    if (lt !== undefined && ts <= lt) continue
    const l = lItems.get(id)
    if (l !== undefined ? ts > l : !(full && ts < oldest)) plan.pullIds.push(id)
  }
  return plan
}

/** Parte entradas y lápidas en tandas de `maxBytes`. Lo que no cabe ni solo va aparte, en `tooLarge`. */
export function batches (threads = {}, tombs = {}, maxBytes = PUSH_BYTES) {
  const out = []
  const tooLarge = []
  let cur = null
  let bytes = 0
  const add = (kind, k, item) => {
    const size = byteLength(item) + 1
    if (size > MAX_ENTRY_BYTES) { tooLarge.push({ threadKey: k, id: String(item.id), bytes: size }); return }
    if (!cur || bytes + size > maxBytes) { cur = { threads: {}, tombs: {} }; out.push(cur); bytes = 0 }
    if (!cur[kind][k]) cur[kind][k] = []
    cur[kind][k].push(item)
    bytes += size
  }
  for (const [k, list] of Object.entries(tombs)) for (const row of list) add('tombs', k, row)
  for (const [k, list] of Object.entries(threads)) for (const e of list) add('threads', k, e)
  return { batches: out, tooLarge }
}

/** Parte `{ threadKey: ids }` en pedidos de `maxBytes` de ids como mucho. */
function chunkRefs (refs, maxBytes) {
  const out = []
  let cur = null
  let bytes = 0
  for (const [k, ids] of Object.entries(refs)) {
    for (const id of ids) {
      const size = byteLength(id) + 4
      if (!cur || bytes + size > maxBytes) { cur = {}; out.push(cur); bytes = 0 }
      if (!cur[k]) { cur[k] = []; bytes += byteLength(k) }
      cur[k].push(id)
      bytes += size
    }
  }
  return out
}

export class VaultSync {
  /**
   * @param {object} o
   * @param {(method: string, params?: object) => Promise<any>} o.call  pedir a la página del almacén
   * @param {object} o.identity  @dotrino/identity (vaultStatus, vaultStore)
   * @param {(status: object, extra?: object) => void} o.emit
   */
  constructor ({ call, identity, emit }) {
    this._call = call
    this._identity = identity
    this._emit = emit
    this._status = { state: 'off', reason: 'starting', error: null, lastSyncAt: null, pending: 0, tooLarge: [] }
    this._dirty = emptyDirty()
    this._marks = new Map()
    this._queue = Promise.resolve()
    this._reconcileQueued = false
    this._flushQueued = false
    this._retry = 0
    this._started = false
    this._lastAttempt = 0
  }

  get status () { return { ...this._status, error: this._status.error && { ...this._status.error }, tooLarge: [...this._status.tooLarge] } }

  _set (patch, extra) {
    this._status = { ...this._status, ...patch }
    this._emit(this.status, extra)
  }

  _setPending () {
    const pending = dirtyCount(this._dirty)
    if (pending !== this._status.pending) this._set({ pending })
  }

  /** Mira si hay bóveda y, si la hay, se pone al día. No lanza: el resultado queda en `status`. */
  async start () {
    this._set({ state: 'syncing', reason: null, error: null })
    try {
      if (typeof this._identity.vaultStatus !== 'function' || typeof this._identity.vaultStore !== 'function') {
        throw codeError('identity-without-vault', 'the identity passed to the store cannot talk to a vault')
      }
      const st = await this._identity.vaultStatus()
      if (!st?.paired) { this.stop('not-paired'); return this.status }
    } catch (e) {
      this._set({ state: 'error', error: { code: e?.code || null, message: e?.message || String(e) } })
      this._scheduleRetry(() => this.start())
      return this.status
    }
    this._started = true
    this._listen()
    return this.run()
  }

  /** Deja de sincronizar (se soltó la bóveda, o te echaron). Lo pendiente ya no tiene adónde ir. */
  stop (reason) {
    this._started = false
    this._unlisten()
    clearTimeout(this._flushTimer)
    clearTimeout(this._retryTimer)
    this._dirty = emptyDirty()
    this._marks.clear()
    this._set({ state: 'off', reason, error: null, pending: 0 })
  }

  _listen () {
    if (this._listening || typeof document === 'undefined') return
    this._listening = true
    this._onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - this._lastAttempt >= VISIBLE_GAP_MS) this.run()
    }
    document.addEventListener('visibilitychange', this._onVisible)
    this._interval = setInterval(() => {
      if (document.visibilityState === 'visible') this.run()
    }, RESYNC_EVERY_MS)
  }

  _unlisten () {
    if (!this._listening) return
    this._listening = false
    document.removeEventListener('visibilitychange', this._onVisible)
    clearInterval(this._interval)
  }

  _scheduleRetry (fn = () => this.run()) {
    clearTimeout(this._retryTimer)
    const wait = RETRY_MS[Math.min(this._retry, RETRY_MS.length - 1)]
    this._retry++
    this._retryTimer = setTimeout(fn, wait)
  }

  /** Olvida qué hilos se dieron por conciliados (p. ej. cambió el tope por hilo). */
  resetMarks () { this._marks.clear() }

  /** Anota lo que se acaba de escribir en el navegador, para subirlo. */
  noteWrite (method, params, result) {
    if (!this._started) return
    const d = this._dirty
    if (method === 'appendMessage') addTo(d.ids, params.threadKey, result.id)
    else if (method === 'importThreads') {
      for (const [k, list] of Object.entries(params.threads || {})) {
        for (const e of list || []) if (e && e.id != null) addTo(d.ids, k, e.id)
      }
    } else if (method === 'removeMessage') addTo(d.tombIds, params.threadKey, params.id)
    else if (method === 'removeThread') d.tombKeys.add(params.threadKey)
    else if (method === 'clearAll') for (const k of result.keys || []) d.tombKeys.add(k)
    else if (method === 'clearOpens') d.clearOpens = true
    else return
    this._setPending()
    clearTimeout(this._flushTimer)
    this._flushTimer = setTimeout(() => this._queueFlush(), FLUSH_DELAY_MS)
  }

  /** Ponerse al día con la bóveda. Nunca lanza: devuelve el `status` en que quedó. */
  run () {
    if (!this._started) return Promise.resolve(this.status)
    if (!this._reconcileQueued) {
      this._reconcileQueued = true
      this._queue = this._queue.then(async () => {
        this._reconcileQueued = false
        this._lastAttempt = Date.now()
        clearTimeout(this._retryTimer)
        this._set({ state: 'syncing', error: null, tooLarge: [] })
        try {
          const changed = await this._reconcile()
          this._retry = 0
          this._set({ state: 'synced', error: null, lastSyncAt: Date.now() }, { changed })
        } catch (e) {
          this._fail(e)
        }
      })
    }
    return this._queue.then(() => this.status)
  }

  _queueFlush () {
    if (!this._started || this._flushQueued || this._reconcileQueued) return
    this._flushQueued = true
    this._queue = this._queue.then(async () => {
      this._flushQueued = false
      try {
        await this._flush()
        if (this._status.state === 'error') this.run()   // lo que falló antes no era solo esto
        else this._set({ state: 'synced', lastSyncAt: Date.now() })
      } catch (e) {
        this._fail(e)
      }
    })
  }

  _fail (e) {
    // El error queda en el estado, que es lo que enseña la app: no se traga, se enseña.
    console.warn('[dotrino-store] vault sync failed:', e)
    this._set({ state: 'error', error: { code: e?.code || null, message: e?.message || String(e) } })
    this._scheduleRetry()
  }

  async _vault (method, args) {
    try {
      return await this._identity.vaultStore(method, args)
    } catch (e) {
      if (e?.code === 'store-unknown-method') throw codeError('vault-outdated', `the vault does not know "${method}": it has to be updated`)
      throw e
    }
  }

  async _push (threads, tombs, mode) {
    const { batches: list, tooLarge } = batches(threads, tombs, PUSH_BYTES)
    for (const batch of list) await this._vault('importThreads', { threads: batch.threads, tombs: batch.tombs, mode })
    return tooLarge
  }

  /** Sube lo escrito desde la última vez. Si falla, vuelve a quedar pendiente entero. */
  async _flush () {
    const d = this._dirty
    if (dirtyCount(d) === 0) return
    this._dirty = emptyDirty()
    try {
      const local = await this._call('getEntries', { refs: toObject(d.ids), tombRefs: toObject(d.tombIds), tombKeys: [...d.tombKeys] })
      const tooLarge = await this._push(local.threads, local.tombs, 'upsert')
      if (d.clearOpens) await this._vault('clearOpens', {})
      if (tooLarge.length) this._set({ tooLarge: [...this._status.tooLarge, ...tooLarge] })
    } catch (e) {
      mergeDirty(this._dirty, d)
      throw e
    } finally {
      this._setPending()
    }
  }

  async _reconcile () {
    await this._flush()
    const [remote, local] = await Promise.all([this._vault('getThreadDigests', {}), this._call('getThreadDigests', {})])
    const keys = []
    for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      const pair = `${local[k]?.digest || ''}|${remote[k]?.digest || ''}`
      if (local[k]?.digest === remote[k]?.digest) { this._marks.delete(k); continue }
      if (this._marks.get(k) === pair) continue
      keys.push(k)
    }
    const changed = keys.length ? await this._reconcileThreads(keys) : []
    const opens = await this._vault('mergeOpens', { opens: await this._call('getOpens') })
    await this._call('mergeOpens', { opens })
    return changed
  }

  async _reconcileThreads (keys) {
    const local = await this._call('getThreadIndexes', { keys })
    const remote = {}
    let cursor = null
    do {
      const page = await this._vault('getThreadIndexes', { keys, cursor })
      for (const [k, idx] of Object.entries(page.indexes)) {
        if (!remote[k]) remote[k] = { items: [], tombs: [] }
        for (const row of idx.items) remote[k].items.push(row)
        for (const row of idx.tombs) remote[k].tombs.push(row)
      }
      cursor = page.next
    } while (cursor)

    const push = { refs: {}, tombRefs: {} }
    const pull = { refs: {}, tombs: {} }
    for (const k of keys) {
      const plan = planThread(local.indexes[k], remote[k], local.max)
      if (plan.pushIds.length) push.refs[k] = plan.pushIds
      if (plan.pushTombs.length) push.tombRefs[k] = plan.pushTombs
      if (plan.pullIds.length) pull.refs[k] = plan.pullIds
      if (plan.pullTombs.length) pull.tombs[k] = plan.pullTombs
    }

    // Primero SUBIR: si el navegador recorta al bajar, lo que solo estaba aquí ya está a salvo.
    if (nonEmpty(push.refs) || nonEmpty(push.tombRefs)) {
      const out = await this._call('getEntries', { refs: push.refs, tombRefs: push.tombRefs })
      const tooLarge = await this._push(out.threads, out.tombs, 'merge')
      if (tooLarge.length) this._set({ tooLarge: [...this._status.tooLarge, ...tooLarge] })
    }

    const changed = new Set()
    if (nonEmpty(pull.tombs)) {
      const r = await this._call('importThreads', { threads: {}, tombs: pull.tombs, mode: 'merge' })
      for (const k of r.changed) changed.add(k)
    }
    for (const chunk of chunkRefs(pull.refs, REF_BYTES)) {
      let refs = chunk
      while (refs) {
        const page = await this._vault('getEntries', { refs })
        const r = await this._call('importThreads', { threads: page.threads, mode: 'merge' })
        for (const k of r.changed) changed.add(k)
        refs = page.rest
      }
    }

    // Lo que siga distinto después de esto se explica por un recorte (un lado tiene más
    // de lo que el otro guarda): se anota para no repetir el trabajo mientras ninguno cambie.
    const [l2, r2] = await Promise.all([this._call('getThreadDigests', { keys }), this._vault('getThreadDigests', { keys })])
    for (const k of keys) {
      if (l2[k]?.digest === r2[k]?.digest) this._marks.delete(k)
      else this._marks.set(k, `${l2[k]?.digest || ''}|${r2[k]?.digest || ''}`)
    }
    return [...changed]
  }
}
