/**
 * Dotrino — Drive sync module.
 *
 * Loaded by vault.js inside the identity-vault iframe. Implements:
 *   - Google OAuth (Implicit / GIS token client) for the `drive.appdata` scope
 *   - PBKDF2-derived AES-256-GCM encryption of the vault export blob
 *   - Drive REST v3 read/write of a single file in `appDataFolder`
 *   - Auto-sync scheduler: pull-on-unlock, debounced push, periodic pull,
 *     optimistic-locked push (If-Match etag) with retry-and-merge on 412
 *
 * The same module ships in the message-store repo with the only differences
 * being FILE_NAME and the merge function passed in by the caller.
 */

const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files'
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files'
const GIS_SCRIPT = 'https://accounts.google.com/gsi/client'
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata'

const PUSH_DEBOUNCE_MS = 5_000
const PUSH_HARD_INTERVAL_MS = 60_000
const PULL_INTERVAL_MS = 2 * 60_000
const PBKDF2_ITER = 600_000

// Local state keys (stored in localStorage of the vault origin)
const LS_DEVICE_ID = 'cc.sync.deviceId'
const LS_OAUTH_CLIENT = 'cc.sync.oauthClientId'
const LS_LAST_ETAG = 'cc.sync.lastEtag'
const LS_LAST_VERSIONS = 'cc.sync.deviceVersions'
// Passphrase-derived key only lives in sessionStorage (per-tab, cleared on close)
const SS_PASSPHRASE_KEY = 'cc.sync.kHexEphemeral'

// ---------- low-level helpers ----------

function bufToBase64 (buf) {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}
function base64ToBuf (b64) {
  const s = atob(b64)
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)
  return bytes.buffer
}
function getDeviceId () {
  let id = localStorage.getItem(LS_DEVICE_ID)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(LS_DEVICE_ID, id)
  }
  return id
}
function getDeviceVersions () {
  try { return JSON.parse(localStorage.getItem(LS_LAST_VERSIONS) || '{}') } catch { return {} }
}
function setDeviceVersions (v) {
  localStorage.setItem(LS_LAST_VERSIONS, JSON.stringify(v))
}

// ---------- crypto: passphrase → key, AES-GCM ----------

async function deriveKey (passphrase, salt) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  )
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  )
}

async function encryptBlob (plaintextObj, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await deriveKey(passphrase, salt)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(plaintextObj))
  )
  return {
    v: 1,
    kdf: { alg: 'PBKDF2-SHA256', iter: PBKDF2_ITER, salt: bufToBase64(salt) },
    enc: { alg: 'AES-256-GCM', iv: bufToBase64(iv), ct: bufToBase64(new Uint8Array(ct)) },
    createdAt: Date.now()
  }
}

async function decryptBlob (envelope, passphrase) {
  if (!envelope || envelope.v !== 1) throw new Error('Unsupported backup version')
  const salt = new Uint8Array(base64ToBuf(envelope.kdf.salt))
  const iv = new Uint8Array(base64ToBuf(envelope.enc.iv))
  const key = await deriveKey(passphrase, salt)
  let ptBytes
  try {
    ptBytes = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      base64ToBuf(envelope.enc.ct)
    )
  } catch {
    throw new Error('Wrong passphrase or corrupted backup')
  }
  return JSON.parse(new TextDecoder().decode(ptBytes))
}

// ---------- Google OAuth (GIS Token Client) ----------

let _gisLoaded = null
function loadGis () {
  if (_gisLoaded) return _gisLoaded
  _gisLoaded = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve()
    const s = document.createElement('script')
    s.src = GIS_SCRIPT
    s.async = true
    s.defer = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Failed to load Google Identity Services'))
    document.head.appendChild(s)
  })
  return _gisLoaded
}

let _accessToken = null
let _accessTokenExpiresAt = 0
let _tokenClient = null

async function ensureTokenClient (clientId) {
  await loadGis()
  if (_tokenClient && _tokenClient._clientId === clientId) return _tokenClient
  _tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPE,
    prompt: '',
    callback: () => {} // overridden per-request
  })
  _tokenClient._clientId = clientId
  return _tokenClient
}

async function requestAccessToken (clientId, { interactive }) {
  const client = await ensureTokenClient(clientId)
  return new Promise((resolve, reject) => {
    client.callback = (resp) => {
      if (resp?.error) return reject(new Error(resp.error))
      if (!resp?.access_token) return reject(new Error('No access_token in response'))
      _accessToken = resp.access_token
      _accessTokenExpiresAt = Date.now() + ((Number(resp.expires_in) || 3600) - 60) * 1000
      resolve({ accessToken: _accessToken, expiresAt: _accessTokenExpiresAt })
    }
    try {
      client.requestAccessToken({ prompt: interactive ? 'consent' : '' })
    } catch (e) { reject(e) }
  })
}

async function getValidAccessToken () {
  if (_accessToken && Date.now() < _accessTokenExpiresAt) return _accessToken
  const clientId = localStorage.getItem(LS_OAUTH_CLIENT)
  if (!clientId) return null
  try {
    const r = await requestAccessToken(clientId, { interactive: false })
    return r.accessToken
  } catch { return null }
}

// ---------- Drive REST helpers ----------

async function driveFindFile (token, fileName) {
  const q = encodeURIComponent(`name='${fileName}' and 'appDataFolder' in parents and trashed=false`)
  const url = `${DRIVE_FILES_API}?spaces=appDataFolder&q=${q}&fields=files(id,name,headRevisionId,modifiedTime)`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Drive list failed: ${res.status}`)
  const data = await res.json()
  return (data.files && data.files[0]) || null
}

async function driveDownload (token, fileId) {
  const url = `${DRIVE_FILES_API}/${fileId}?alt=media`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`Drive download failed: ${res.status}`)
  const etag = res.headers.get('ETag') || null
  const body = await res.json()
  return { body, etag }
}

async function driveCreate (token, fileName, contentObj) {
  const metadata = { name: fileName, parents: ['appDataFolder'] }
  const boundary = '-------ccsync' + Math.random().toString(36).slice(2)
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n' +
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(contentObj) + '\r\n' +
    `--${boundary}--`
  const res = await fetch(`${DRIVE_UPLOAD_API}?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body
  })
  if (!res.ok) throw new Error(`Drive create failed: ${res.status}`)
  const data = await res.json()
  return data.id
}

async function driveUpdate (token, fileId, contentObj, ifMatchEtag) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json; charset=UTF-8'
  }
  if (ifMatchEtag) headers['If-Match'] = ifMatchEtag
  const url = `${DRIVE_UPLOAD_API}/${fileId}?uploadType=media`
  const res = await fetch(url, { method: 'PATCH', headers, body: JSON.stringify(contentObj) })
  if (res.status === 412) {
    const err = new Error('etag mismatch')
    err.code = 'PRECONDITION_FAILED'
    throw err
  }
  if (!res.ok) throw new Error(`Drive update failed: ${res.status}`)
  const newEtag = res.headers.get('ETag') || null
  return { etag: newEtag }
}

// ---------- public createSync(): returns a controller wired to caller’s state ----------

/**
 * Creates a sync controller for one logical state (identity OR store).
 *
 * @param {Object} cfg
 * @param {string} cfg.fileName        - e.g. 'dotrino-identity-backup.json'
 * @param {() => Promise<Object>} cfg.exportLocal  - returns plaintext-equivalent JSON
 * @param {(merged: Object) => Promise<void>} cfg.applyMerged - apply merged state locally
 * @param {(local: Object, remote: Object) => Promise<{merged: Object, changed: boolean}>} cfg.mergeFn
 * @param {string} cfg.kind            - 'identity' | 'store' (used in plaintext header)
 */
export function createSync (cfg) {
  const deviceId = getDeviceId()
  let _passphrase = null // kept in module memory after unlock; mirrored to sessionStorage for tab refresh
  let _dirty = false
  let _debounceTimer = null
  let _hardTimer = null
  let _periodicTimer = null
  let _running = false
  let _lastError = null
  let _statusListeners = new Set()

  // Restore passphrase from sessionStorage if present (per-tab unlock survives refresh)
  try {
    const saved = sessionStorage.getItem(SS_PASSPHRASE_KEY)
    if (saved) _passphrase = saved
  } catch {}

  function emitStatus (status, extra = {}) {
    const payload = { kind: cfg.kind, status, ...extra, ts: Date.now() }
    for (const fn of _statusListeners) {
      try { fn(payload) } catch (e) { console.error(e) }
    }
  }

  function isUnlocked () { return !!_passphrase }

  async function unlock (passphrase) {
    if (!passphrase || passphrase.length < 8) throw new Error('Passphrase too short')
    _passphrase = passphrase
    try { sessionStorage.setItem(SS_PASSPHRASE_KEY, passphrase) } catch {}
    emitStatus('unlocked')
    // Trigger an immediate pull on unlock
    try { await pull() } catch (e) { _lastError = e; emitStatus('error', { error: e.message }) }
    startTimers()
    return { ok: true }
  }

  function lock () {
    _passphrase = null
    try { sessionStorage.removeItem(SS_PASSPHRASE_KEY) } catch {}
    stopTimers()
    emitStatus('locked')
  }

  function buildPlaintext (exported) {
    const versions = getDeviceVersions()
    versions[deviceId] = (versions[deviceId] || 0) + 1
    setDeviceVersions(versions)
    return {
      version: 1,
      kind: cfg.kind,
      exportedAt: Date.now(),
      deviceVersions: versions,
      payload: exported
    }
  }

  function dominates (localV, remoteV) {
    if (!remoteV) return true
    const all = new Set([...Object.keys(localV || {}), ...Object.keys(remoteV)])
    let strictly = false
    for (const k of all) {
      const a = localV[k] || 0
      const b = remoteV[k] || 0
      if (a < b) return false
      if (a > b) strictly = true
    }
    return strictly
  }

  async function pull () {
    if (!isUnlocked()) return { skipped: 'locked' }
    if (_running) return { skipped: 'busy' }
    _running = true
    emitStatus('syncing')
    try {
      const token = await getValidAccessToken()
      if (!token) { emitStatus('offline'); return { skipped: 'no-token' } }
      const file = await driveFindFile(token, cfg.fileName)
      if (!file) { emitStatus('synced'); return { remote: null } }
      const { body: envelope, etag } = await driveDownload(token, file.id)
      localStorage.setItem(LS_LAST_ETAG + ':' + cfg.kind, etag || '')
      const plaintext = await decryptBlob(envelope, _passphrase)
      const local = await cfg.exportLocal()
      const remoteVersions = plaintext.deviceVersions || {}
      const localVersions = getDeviceVersions()
      if (dominates(localVersions, remoteVersions)) {
        // Local already covers remote — nothing to apply, but mark dirty to push
        _dirty = true
        emitStatus('synced')
        return { applied: false, dominant: 'local' }
      }
      const { merged, changed } = await cfg.mergeFn(local, plaintext.payload)
      await cfg.applyMerged(merged)
      // Merge versions: max per device
      const mergedVersions = { ...remoteVersions }
      for (const k of Object.keys(localVersions)) {
        mergedVersions[k] = Math.max(mergedVersions[k] || 0, localVersions[k] || 0)
      }
      setDeviceVersions(mergedVersions)
      if (changed) _dirty = true
      emitStatus('synced')
      return { applied: true, changed }
    } catch (e) {
      _lastError = e
      emitStatus('error', { error: e.message })
      throw e
    } finally {
      _running = false
    }
  }

  async function push (retries = 3) {
    if (!isUnlocked()) return { skipped: 'locked' }
    if (!_dirty) return { skipped: 'clean' }
    if (_running) return { skipped: 'busy' }
    _running = true
    emitStatus('syncing')
    try {
      const token = await getValidAccessToken()
      if (!token) { emitStatus('offline'); return { skipped: 'no-token' } }
      const local = await cfg.exportLocal()
      const plaintext = buildPlaintext(local)
      const envelope = await encryptBlob(plaintext, _passphrase)
      const existing = await driveFindFile(token, cfg.fileName)
      if (!existing) {
        await driveCreate(token, cfg.fileName, envelope)
        _dirty = false
        emitStatus('synced')
        return { created: true }
      }
      const lastEtag = localStorage.getItem(LS_LAST_ETAG + ':' + cfg.kind) || null
      try {
        const { etag } = await driveUpdate(token, existing.id, envelope, lastEtag)
        localStorage.setItem(LS_LAST_ETAG + ':' + cfg.kind, etag || '')
        _dirty = false
        emitStatus('synced')
        return { updated: true }
      } catch (e) {
        if (e.code === 'PRECONDITION_FAILED' && retries > 0) {
          emitStatus('conflict')
          _running = false // pull() needs the slot
          await pull()
          _running = true
          return push(retries - 1)
        }
        throw e
      }
    } catch (e) {
      _lastError = e
      emitStatus('error', { error: e.message })
      throw e
    } finally {
      _running = false
    }
  }

  function markDirty () {
    _dirty = true
    if (!isUnlocked()) return
    if (_debounceTimer) clearTimeout(_debounceTimer)
    _debounceTimer = setTimeout(() => {
      push().catch(() => {})
    }, PUSH_DEBOUNCE_MS)
  }

  function startTimers () {
    if (_hardTimer) clearInterval(_hardTimer)
    if (_periodicTimer) clearInterval(_periodicTimer)
    _hardTimer = setInterval(() => { if (_dirty) push().catch(() => {}) }, PUSH_HARD_INTERVAL_MS)
    _periodicTimer = setInterval(() => { pull().catch(() => {}) }, PULL_INTERVAL_MS)
  }

  function stopTimers () {
    if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null }
    if (_hardTimer) { clearInterval(_hardTimer); _hardTimer = null }
    if (_periodicTimer) { clearInterval(_periodicTimer); _periodicTimer = null }
  }

  // Push pending writes when the tab becomes visible again (mobile / bg)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && _dirty && isUnlocked()) {
      push().catch(() => {})
    }
  })
  window.addEventListener('online', () => {
    if (_dirty && isUnlocked()) push().catch(() => {})
  })

  return {
    onStatus (fn) { _statusListeners.add(fn); return () => _statusListeners.delete(fn) },
    isUnlocked,
    isConnected: () => !!localStorage.getItem(LS_OAUTH_CLIENT),
    async connectGoogle (clientId) {
      if (!clientId) throw new Error('clientId required')
      localStorage.setItem(LS_OAUTH_CLIENT, clientId)
      const r = await requestAccessToken(clientId, { interactive: true })
      emitStatus('connected')
      return r
    },
    async disconnectGoogle () {
      _accessToken = null
      _accessTokenExpiresAt = 0
      localStorage.removeItem(LS_OAUTH_CLIENT)
      stopTimers()
      emitStatus('disconnected')
    },
    unlock,
    lock,
    pull,
    push,
    markDirty,
    getStatus () {
      return {
        kind: cfg.kind,
        connected: !!localStorage.getItem(LS_OAUTH_CLIENT),
        unlocked: isUnlocked(),
        dirty: _dirty,
        lastError: _lastError ? _lastError.message : null
      }
    }
  }
}
