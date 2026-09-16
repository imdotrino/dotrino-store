// Bóveda de mentira para las pruebas del cliente: las MISMAS reglas (`store/core.js`, que es
// lo que importa la bóveda de verdad) detrás de una `identity` falsa, y el corte de 1 MB del
// proxio. Lo que pase de ese tamaño no llega: aquí falla y queda anotado en `oversize`, para
// que una prueba pueda exigir que no pasó nunca.
import * as core from '/store/core.js'

const FRAME_BYTES = 1024 * 1024

// Cifrado de punta a punta (base64 del texto cifrado) más el sobre firmado y el cert.
const frameOf = (value) => Math.ceil(core.byteLength(value ?? null) * 4 / 3) + 4096

function codeError (code, message) {
  return Object.assign(new Error(message), { code })
}

export function createFakeVault ({ paired = true } = {}) {
  const data = { threads: {}, tombs: {}, opens: {} }
  const vault = {
    data,
    calls: [],
    oversize: [],
    offline: false,
    outdated: false,
    noKey: false,
    delayMs: 0,
  }
  const clamp = (n) => Math.min(Math.max(Number(n) || core.PAGE_BYTES, 1024), core.PAGE_BYTES)
  const methods = {
    getThreadDigests: ({ keys } = {}) => core.digestsOf(data.threads, keys),
    getThreadIndexes: ({ keys, cursor, maxBytes }) => core.indexPage(data.threads, data.tombs, keys, cursor, clamp(maxBytes)),
    getEntries: ({ refs, maxBytes }) => core.entriesPage(data.threads, refs, clamp(maxBytes)),
    importThreads: ({ threads = {}, tombs, mode = 'merge' }) => {
      const buried = core.applyTombs(data.threads, data.tombs, tombs, Date.now())
      const merged = core.mergeEntries(data.threads, data.tombs, threads, { mode, max: core.MAX_PER_THREAD_LIMIT })
      return { mode, count: Object.keys(data.threads).length, changed: [...new Set([...buried.changed, ...merged])] }
    },
    mergeOpens: ({ opens }) => { core.mergeOpens(data.opens, opens); return { ...data.opens } },
    clearOpens: () => { data.opens = {}; return { ok: true } },
    appendMessage: ({ threadKey, entry }) => core.writeEntry(data.threads, data.tombs, threadKey, entry, { max: core.MAX_PER_THREAD_LIMIT, now: Date.now(), newId: () => crypto.randomUUID() }).entry,
    removeMessage: ({ threadKey, id }) => ({ removed: core.removeEntry(data.threads, data.tombs, threadKey, id, Date.now()) }),
    listThread: ({ threadKey }) => data.threads[threadKey] || [],
  }
  vault.identity = {
    currentProfile: async () => ({ id: vault.profileId }),
    onVault: (fn) => { vault.emitVault = fn; return () => {} },
    vaultStatus: async () => ({ paired: vault.paired }),
    vaultStore: async (method, args) => {
      const request = frameOf(args)
      vault.calls.push({ method, request })
      if (vault.delayMs) await new Promise((r) => setTimeout(r, vault.delayMs))
      if (vault.noKey) throw codeError('no-content-key', 'this device does not hold the profile content key yet')
      if (vault.offline) throw codeError('vault-no-reply', 'the vault did not reply (is it running?)')
      if (vault.outdated && !['appendMessage', 'removeMessage', 'listThread', 'importThreads'].includes(method)) {
        throw codeError('store-unknown-method', 'store: invalid method')
      }
      if (request > FRAME_BYTES) { vault.oversize.push({ method, bytes: request }); throw codeError('vault-no-reply', 'request over 1 MB') }
      const result = await methods[method](JSON.parse(JSON.stringify(args ?? {})))
      const response = frameOf(result)
      if (response > FRAME_BYTES) { vault.oversize.push({ method, bytes: response, response: true }); throw codeError('vault-no-reply', 'response over 1 MB') }
      return JSON.parse(JSON.stringify(result ?? null))
    },
  }
  vault.paired = paired
  vault.profileId = 'perfil-' + Math.random().toString(36).slice(2)
  return vault
}
