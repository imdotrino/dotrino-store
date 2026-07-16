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
    // Si pasás una Identity emparejada (options.identity), el store se respalda EN tu
    // vault: el iframe (IndexedDB) queda como CACHÉ y la fuente de verdad es tu bóveda.
    // Opt-in y retrocompatible: sin identity, comportamiento idéntico al de hoy (local).
    this._identity = options.identity || null
    this._vaultMode = false
    this._vaultDirty = false // hay escrituras locales sin subir al vault (se hicieron offline)
  }

  static async connect (options = {}) {
    // El `await ready()` también va en la rama del singleton: si NO, quien llega
    // mientras el primero todavía está levantando el iframe recibe un store sin
    // conectar, postea a un iframe que aún no escucha y su primer mensaje se
    // PIERDE — la petición no falla, se queda colgada hasta el timeout (8 s).
    // `ready()` es idempotente (cachea su promesa), así que esperarla es gratis.
    // Salió al pasar @dotrino/support de jsDelivr a npm: desde entonces la app y
    // la moneda comparten este módulo (antes eran dos instancias) y corren la
    // carrera de verdad.
    if (singleton) { await singleton.ready(); return singleton }
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
        if (msg.type === 'ready') { clearTimeout(timeout); this._initProfile().then(() => this._enableVault()).finally(() => resolve(this)); return }
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

  // ----- multi-perfil (opt-in vía options.identity) -----

  /**
   * Namespacea el store por el PERFIL activo de la identidad (cada perfil = sus propios
   * hilos/aperturas). Y, al REVOCAR el acceso al vault de ese perfil, borra SOLO su store
   * (los datos vivían en el vault; la caché local de ese perfil se limpia). Cambiar de perfil
   * NO borra nada: la app recarga y vuelve a entrar acá con el nuevo perfil.
   */
  async _initProfile () {
    if (!this._identity) return
    try {
      const p = this._identity.currentProfile ? await this._identity.currentProfile() : null
      if (p?.id) { this._profileId = p.id; await this._call('setProfile', { profileId: p.id }) }
    } catch (_) { /* sin perfil → namespace por defecto */ }
    try {
      if (this._identity.onVault && !this._vaultSub) {
        this._vaultSub = this._identity.onVault((e) => {
          if (e && (e.phase === 'revoked' || e.phase === 'unpaired')) {
            this._vaultMode = false
            this._call('wipeProfile').catch(() => {})
          }
        })
      }
    } catch (_) { /* sin eventos de vault */ }
  }

  /** Borra el store del perfil activo (manual; el caso normal es automático al revocar). */
  wipeProfile () { return this._call('wipeProfile') }

  // ----- respaldo en el vault (opt-in vía options.identity) -----

  /** Comprueba el emparejamiento y reconcilia (merge idempotente por id) caché ↔ vault. */
  async _enableVault () {
    if (!this._identity) return
    try {
      const st = await this._identity.vaultStatus()
      if (!st?.paired) { this._vaultMode = false; return }
      this._vaultMode = true
      const localExp = await this._call('exportThreads')
      if (localExp?.threads && Object.keys(localExp.threads).length) {
        await this._identity.vaultStore('importThreads', { threads: localExp.threads, mode: 'merge' })
      }
      const vaultExp = await this._identity.vaultStore('exportThreads')
      if (vaultExp?.threads && Object.keys(vaultExp.threads).length) {
        await this._call('importThreads', { threads: vaultExp.threads, mode: 'merge' })
      }
      this._vaultDirty = false
    } catch (_) { this._vaultMode = false } // vault apagado → modo local (caché)
  }

  /** ¿El store está respaldado en tu vault ahora mismo? */
  get vaultBacked () { return this._vaultMode }

  /** Si hubo escrituras offline, sube la caché completa al vault (merge) en cuanto vuelve. */
  async _flushDirty () {
    if (!this._vaultMode || !this._vaultDirty) return
    try {
      const exp = await this._call('exportThreads')
      if (exp?.threads && Object.keys(exp.threads).length) await this._identity.vaultStore('importThreads', { threads: exp.threads, mode: 'merge' })
      this._vaultDirty = false
    } catch (_) { /* sigue offline */ }
  }

  /** Escritura: SIEMPRE a la caché local, y al vault si está emparejado/online. */
  async _write (method, params) {
    if (this._vaultMode) await this._flushDirty()
    const local = await this._call(method, params)
    if (this._vaultMode) {
      try { await this._identity.vaultStore(method, params) } catch (_) { this._vaultDirty = true } // offline: queda en caché, sube al reconectar
    }
    return local
  }

  /** Lectura: del vault (ve a tus otros dispositivos); si está offline, de la caché. */
  async _read (method, params) {
    if (this._vaultMode) {
      await this._flushDirty()
      try { return await this._identity.vaultStore(method, params) } catch (_) { /* offline → caché */ }
    }
    return this._call(method, params)
  }

  ping () { return this._call('ping') }

  setMaxPerThread (max) { return this._call('setMaxPerThread', { max }) }

  appendMessage (threadKey, entry) { return this._write('appendMessage', { threadKey, entry }) }

  listThread (threadKey, opts = {}) { return this._read('listThread', { threadKey, ...opts }) }

  listThreadKeys () { return this._read('listThreadKeys') }

  getThreadSummaries () { return this._read('getThreadSummaries') }

  removeThread (threadKey) { return this._write('removeThread', { threadKey }) }

  removeMessage (threadKey, id) { return this._write('removeMessage', { threadKey, id }) }

  async clearAll () {
    const r = await this._call('clearAll')
    if (this._vaultMode) { try { await this._identity.vaultStore('importThreads', { threads: {}, mode: 'replace' }) } catch (_) {} }
    return r
  }

  getStats () { return this._call('getStats') } // local: es el uso de almacenamiento del navegador

  // ----- contador de aperturas por app ("recientes" del hub) -----
  /** Registra una apertura de `appId` (típicamente el hostname de la app). */
  recordOpen (appId) { return this._write('recordOpen', { appId }) }
  /** Devuelve { [appId]: { count, ts } } con todas las aperturas registradas. */
  getOpens () { return this._read('getOpens') }
  /** Borra el contador de aperturas. */
  clearOpens () { return this._write('clearOpens') }

  // ----- export / import -----
  exportThreads () { return this._read('exportThreads') }
  importThreads (threads, mode = 'merge') { return this._write('importThreads', { threads, mode }) }

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
