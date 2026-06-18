/**
 * Cliente de @dotrino/store.
 *
 * Carga un iframe oculto con la página `store.dotrino.com` y le habla por
 * `postMessage`. El iframe persiste todo en su propio `IndexedDB` (cuota grande,
 * almacenamiento persistente), así varias instancias del messenger (web +
 * extensión + tabs) en el mismo navegador comparten los mismos hilos.
 */

let singleton = null

export class Store {
  constructor (options = {}) {
    this.storeUrl = options.storeUrl || 'https://store.dotrino.com/'
    this.timeoutMs = options.timeoutMs ?? 8000
    this._iframe = null
    this._ready = null
    this._handler = null
    this._pending = new Map()
    this._nextId = 1
  }

  static async connect (options = {}) {
    if (singleton) return singleton
    singleton = new Store(options)
    await singleton.ready()
    return singleton
  }

  static current () { return singleton }

  ready () {
    if (this._ready) return this._ready
    this._ready = new Promise((resolve, reject) => {
      const iframe = document.createElement('iframe')
      iframe.src = this.storeUrl
      iframe.style.display = 'none'
      iframe.setAttribute('aria-hidden', 'true')
      iframe.setAttribute('title', 'Dotrino message store')
      iframe.referrerPolicy = 'origin'
      this._iframe = iframe

      const timeout = setTimeout(() => {
        reject(new Error(`Store did not respond within ${this.timeoutMs}ms`))
      }, this.timeoutMs)

      this._handler = (event) => {
        if (event.source !== iframe.contentWindow) return
        const msg = event.data
        if (!msg || msg._ccs !== true) return
        if (msg.type === 'ready') { clearTimeout(timeout); resolve(this); return }
        if (msg.type === 'response') {
          const pending = this._pending.get(msg.id)
          if (!pending) return
          this._pending.delete(msg.id)
          clearTimeout(pending.timer)
          if (msg.error) pending.reject(new Error(msg.error))
          else pending.resolve(msg.result)
          return
        }
        if (msg.type === 'event') this._emit(msg.event, msg.payload)
      }
      window.addEventListener('message', this._handler)
      document.body.appendChild(iframe)
    })
    return this._ready
  }

  destroy () {
    if (this._handler) window.removeEventListener('message', this._handler)
    if (this._iframe?.parentNode) this._iframe.parentNode.removeChild(this._iframe)
    this._iframe = null
    this._handler = null
    this._ready = null
    if (singleton === this) singleton = null
  }

  _call (method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this._iframe?.contentWindow) return reject(new Error('Store not ready'))
      const id = `req_${this._nextId++}`
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error(`Store timeout for ${method}`))
      }, this.timeoutMs)
      this._pending.set(id, { resolve, reject, timer })
      this._iframe.contentWindow.postMessage(
        { _ccs: true, type: 'request', id, method, params },
        '*'
      )
    })
  }

  ping () { return this._call('ping') }

  setMaxPerThread (max) { return this._call('setMaxPerThread', { max }) }

  appendMessage (threadKey, entry) { return this._call('appendMessage', { threadKey, entry }) }

  listThread (threadKey, opts = {}) { return this._call('listThread', { threadKey, ...opts }) }

  listThreadKeys () { return this._call('listThreadKeys') }

  getThreadSummaries () { return this._call('getThreadSummaries') }

  removeThread (threadKey) { return this._call('removeThread', { threadKey }) }

  removeMessage (threadKey, id) { return this._call('removeMessage', { threadKey, id }) }

  clearAll () { return this._call('clearAll') }

  getStats () { return this._call('getStats') }

  // ----- contador de aperturas por app ("recientes" del hub) -----
  /** Registra una apertura de `appId` (típicamente el hostname de la app). */
  recordOpen (appId) { return this._call('recordOpen', { appId }) }
  /** Devuelve { [appId]: { count, ts } } con todas las aperturas registradas. */
  getOpens () { return this._call('getOpens') }
  /** Borra el contador de aperturas. */
  clearOpens () { return this._call('clearOpens') }

  // ----- export / import -----
  exportThreads () { return this._call('exportThreads') }
  importThreads (threads, mode = 'merge') { return this._call('importThreads', { threads, mode }) }

  // ----- Drive sync -----
  syncConnect (clientId) { return this._call('syncConnect', { clientId }) }
  syncDisconnect () { return this._call('syncDisconnect') }
  syncUnlock (passphrase) { return this._call('syncUnlock', { passphrase }) }
  syncLock () { return this._call('syncLock') }
  syncStatus () { return this._call('syncStatus') }
  syncNow () { return this._call('syncNow') }

  on (event, handler) {
    if (!this._listeners) this._listeners = new Map()
    if (!this._listeners.has(event)) this._listeners.set(event, new Set())
    this._listeners.get(event).add(handler)
    return () => this._listeners.get(event)?.delete(handler)
  }
  onSync (handler) { return this.on('sync', handler) }
  _emit (event, payload) {
    const set = this._listeners?.get(event); if (!set) return
    for (const h of set) { try { h(payload) } catch (e) { console.error(e) } }
  }
}
