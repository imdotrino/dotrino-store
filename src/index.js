/**
 * Cliente de @dotrino/store.
 *
 * Carga un iframe oculto con la página `store.dotrino.com` y le habla por
 * `postMessage`. El iframe persiste todo en su propio `IndexedDB` (cuota grande,
 * almacenamiento persistente), así varias instancias del messenger (web +
 * extensión + tabs) en el mismo navegador comparten los mismos hilos.
 */

import { VaultSync } from './vault-sync.js'

let singleton = null

const OFF_WITHOUT_IDENTITY = Object.freeze({ state: 'off', reason: 'no-identity', error: null, lastSyncAt: null, pending: 0, tooLarge: [] })

function codeError (code, message) {
  const e = new Error(message)
  e.code = code
  return e
}

export class Store {
  constructor (options = {}) {
    this.storeUrl = options.storeUrl || 'https://store.dotrino.com/'
    this.timeoutMs = options.timeoutMs ?? 8000
    // Abrir el almacén es cargar una página por la red: se le da más margen que a una
    // petición, y mientras tanto se le pregunta (ver `_handshake`).
    this.connectTimeoutMs = options.connectTimeoutMs ?? 20000
    this.helloEveryMs = options.helloEveryMs ?? 500
    this._iframe = null
    this._ready = null
    this._handler = null
    this._pending = new Map()
    this._nextId = 1
    // Con una identidad emparejada (options.identity), lo que guardas se respalda EN tu
    // bóveda por detrás (ver `vault-sync.js`). Se lee y se escribe siempre en el navegador.
    this._identity = options.identity || null
    this._maxPerThread = options.maxPerThread ?? null
    this._vaultSync = null
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
    //
    // Y la identidad NO se ignora cuando el singleton ya existe. La moneda de
    // `<dotrino-support>` conecta SIN identidad al montarse (para contar la apertura) y
    // suele llegar antes que la app; hasta 0.9.0 la app que pedía `connect({ identity })`
    // recibía ese mismo almacén sin perfil y todo lo suyo caía, sin ningún error, en el
    // espacio común de todos los perfiles del aparato. Ahora el almacén la adopta.
    if (singleton) {
      await singleton.ready()
      if (options.maxPerThread != null) await singleton.setMaxPerThread(options.maxPerThread)
      if (options.identity) await singleton._adoptIdentity(options.identity)
      return singleton
    }
    singleton = new Store(options)
    await singleton.ready()
    return singleton
  }

  /** El perfil al que está atado el almacén, o null si se conectó sin identidad. */
  get profileId () { return this._profileId || null }

  /**
   * Ata a un perfil un almacén que ya estaba abierto sin identidad. Si ya tenía una, la
   * nueva tiene que ser del MISMO perfil: dos perfiles no comparten un almacén abierto.
   */
  async _adoptIdentity (identity) {
    if (this._identity === identity) return this._adopting
    if (this._identity) {
      const p = await identity.currentProfile()
      if (p?.id !== this._profileId) {
        throw codeError('store-identity-mismatch', `the store is already bound to profile ${this._profileId}, not to ${p?.id}`)
      }
      return
    }
    this._identity = identity
    this._adopting = this._initProfile().then(() => this._startVault()).catch((e) => {
      this._identity = null
      this._adopting = null
      this._profileId = null
      throw e
    })
    return this._adopting
  }

  static current () { return singleton }

  ready () {
    if (this._ready) return this._ready
    this._ready = this._handshake().catch((e) => {
      // Un fallo NO deja el almacén fallado para siempre: se desmonta todo para que el
      // siguiente intento —el «Reintentar» que enseña la app— levante un iframe nuevo.
      // Hasta 0.8.0 la promesa rechazada se quedaba cacheada en el singleton y ese botón
      // devolvía el mismo error sin intentar nada: un tropiezo de red duraba la sesión entera.
      this.destroy()
      throw e
    })
    return this._ready
  }

  /**
   * El saludo con el iframe. Además de escuchar su `ready`, se le PREGUNTA cada
   * `helloEveryMs`: si ese mensaje se perdió —o si la página tardó en cargar—, la
   * siguiente pregunta lo repone, sin recargar nada. Si ni así contesta, se lanza
   * diciendo si el iframe llegó a cargar.
   */
  _handshake () {
    return new Promise((resolve, reject) => {
      const iframe = document.createElement('iframe')
      iframe.src = this.storeUrl
      iframe.style.display = 'none'
      iframe.setAttribute('aria-hidden', 'true')
      iframe.setAttribute('title', 'Dotrino message store')
      iframe.referrerPolicy = 'origin'
      this._iframe = iframe
      this._loaded = false
      iframe.addEventListener('load', () => { this._loaded = true })

      const stopAsking = () => { clearTimeout(timeout); clearInterval(this._hello); this._hello = null }
      const timeout = setTimeout(() => {
        stopAsking()
        reject(new Error(`Store did not respond within ${this.connectTimeoutMs}ms (${this.storeUrl} ${this._loaded ? 'loaded' : 'never loaded'})`))
      }, this.connectTimeoutMs)

      this._handler = (event) => {
        if (event.source !== iframe.contentWindow) return
        const msg = event.data
        if (!msg || msg._ccs !== true) return
        if (msg.type === 'ready') {
          stopAsking()
          // Si no se puede atar al perfil, abrir falla: un almacén que responde pero guarda
          // en el espacio de otro es peor que uno que no abre.
          // La bóveda NO se espera: abrir el almacén es local, y ponerse al día con ella
          // puede tardar lo que tarde la red. Su estado se ve en `vault` y en el evento.
          this._applyMaxPerThread()
            .then(() => this._initProfile())
            .then(() => { this._startVault(); resolve(this) }, reject)
          return
        }
        if (msg.type === 'response') {
          const pending = this._pending.get(msg.id)
          if (!pending) return
          this._pending.delete(msg.id)
          clearTimeout(pending.timer)
          if (msg.error) pending.reject(msg.code ? codeError(msg.code, msg.error) : new Error(msg.error))
          else pending.resolve(msg.result)
          return
        }
        if (msg.type === 'event') this._emit(msg.event, msg.payload)
      }
      window.addEventListener('message', this._handler)
      document.body.appendChild(iframe)
      this._hello = setInterval(() => {
        try { iframe.contentWindow?.postMessage({ _ccs: true, type: 'hello' }, '*') } catch (_) { /* aún sin cargar */ }
      }, this.helloEveryMs)
    })
  }

  destroy () {
    this._vaultSync?.stop('destroyed')
    this._vaultSync = null
    if (this._handler) window.removeEventListener('message', this._handler)
    if (this._iframe?.parentNode) this._iframe.parentNode.removeChild(this._iframe)
    clearInterval(this._hello)
    this._hello = null
    this._iframe = null
    this._handler = null
    this._ready = null
    this._adopting = null
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
    // Sin perfil NO se sigue: antes caía al espacio por defecto y mezclaba los datos de
    // todos los perfiles del aparato sin decir nada.
    if (typeof this._identity.currentProfile !== 'function') {
      throw codeError('store-no-profile', 'the identity passed to the store has no currentProfile()')
    }
    const p = await this._identity.currentProfile()
    if (!p?.id) throw codeError('store-no-profile', 'the identity has no active profile')
    const r = await this._call('setProfile', { profileId: p.id })
    if (r?.profileId !== p.id) throw codeError('store-no-profile', `the store did not switch to profile ${p.id}`)
    this._profileId = p.id
    if (typeof this._identity.onVault === 'function' && !this._vaultSub) {
      this._vaultSub = this._identity.onVault((e) => {
        if (!e) return
        if (e.phase === 'paired' || e.phase === 'adopted') { this._vaultSync?.start(); return }
        // SOLTAR LA BÓVEDA NO ES QUE TE ECHEN, y hasta 0.7.0 las dos cosas borraban
        // igual: `vaultUnpair()` es una decisión del dueño —«esta cuenta se queda en
        // este aparato»— y se llevaba por delante todos sus hilos sin avisar. El
        // borrado es solo para la expulsión, que llega FIRMADA (`revoked`) y sí deja
        // huérfana la caché: esos datos vivían en una cuenta que ya no es de aquí.
        if (e.phase === 'unpaired') { this._vaultSync?.stop('not-paired'); return }
        if (e.phase === 'revoked') {
          this._vaultSync?.stop('revoked')
          this._call('wipeProfile').catch((err) => console.error('[dotrino-store] wipe after revocation failed:', err))
        }
      })
    }
  }

  /** Borra el store del perfil activo (manual; el caso normal es automático al revocar). */
  wipeProfile () { return this._call('wipeProfile') }

  // ----- respaldo en la bóveda (con options.identity) -----

  /** Arranca el respaldo por detrás. No se espera ni lanza: su estado está en `vault`. */
  _startVault () {
    if (!this._identity) return
    if (!this._vaultSync) {
      this._vaultSync = new VaultSync({
        call: (method, params) => this._call(method, params),
        identity: this._identity,
        emit: (status, extra) => this._emit('vault', { ...status, changed: extra?.changed || [] })
      })
    }
    this._vaultSync.start()
  }

  /**
   * Estado del respaldo en la bóveda:
   * `state`: `off` (con `reason`: `no-identity` · `not-paired` · `revoked`) · `syncing` ·
   * `synced` · `error` (con `error.code` y `error.message`). `pending`: cambios de este
   * navegador que aún no llegaron a la bóveda. `lastSyncAt`: la última vez que quedó al día.
   */
  get vault () { return this._vaultSync ? this._vaultSync.status : { ...OFF_WITHOUT_IDENTITY } }

  /** ¿Lo guardado está en tu bóveda ahora mismo, sin nada pendiente? */
  get vaultBacked () {
    const s = this.vault
    return s.state === 'synced' && s.pending === 0
  }

  /**
   * Ponerse al día con la bóveda ahora (el «Sincronizar» de una app). Lanza con el código
   * del error si no se pudo; sin bóveda emparejada lanza `vault-off`.
   */
  async vaultSync () {
    if (!this._vaultSync) throw codeError('vault-off', 'the store was opened without an identity')
    const status = await this._vaultSync.run()
    if (status.state === 'off') throw codeError('vault-off', `the vault backup is off (${status.reason})`)
    if (status.state === 'error') throw codeError(status.error.code || 'vault-sync-failed', status.error.message)
    return status
  }

  /** Escritura: en el navegador, y se anota para subirla a la bóveda por detrás. */
  async _write (method, params) {
    const result = await this._call(method, params)
    this._vaultSync?.noteWrite(method, params, result)
    return result
  }

  ping () { return this._call('ping') }

  async _applyMaxPerThread () {
    if (this._maxPerThread == null) return
    const r = await this._call('setMaxPerThread', { max: this._maxPerThread })
    this._appliedMax = r.maxPerThread
  }

  async setMaxPerThread (max) {
    const r = await this._call('setMaxPerThread', { max })
    if (r.maxPerThread !== this._appliedMax) {
      this._appliedMax = r.maxPerThread
      // Con otro tope, lo que se dio por conciliado por culpa del recorte ya no lo está.
      if (this._vaultSync) { this._vaultSync.resetMarks(); this._vaultSync.run() }
    }
    return r
  }

  appendMessage (threadKey, entry) { return this._write('appendMessage', { threadKey, entry }) }

  listThread (threadKey, opts = {}) { return this._call('listThread', { threadKey, ...opts }) }

  listThreadKeys () { return this._call('listThreadKeys') }

  getThreadSummaries () { return this._call('getThreadSummaries') }

  removeThread (threadKey) { return this._write('removeThread', { threadKey }) }

  removeMessage (threadKey, id) { return this._write('removeMessage', { threadKey, id }) }

  /** Borra todos los hilos del perfil; en la bóveda también (con lápidas, por detrás). */
  clearAll () { return this._write('clearAll') }

  getStats () { return this._call('getStats') } // local: es el uso de almacenamiento del navegador

  // ----- contador de aperturas por app ("recientes" del hub) -----
  /** Registra una apertura de `appId` (típicamente el hostname de la app). */
  recordOpen (appId) { return this._write('recordOpen', { appId }) }
  /** Devuelve { [appId]: { count, ts } } con todas las aperturas registradas. */
  getOpens () { return this._call('getOpens') }
  /** Borra el contador de aperturas. */
  clearOpens () { return this._write('clearOpens') }

  // ----- export / import -----
  exportThreads () { return this._call('exportThreads') }
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
