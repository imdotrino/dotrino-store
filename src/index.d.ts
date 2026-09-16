export interface ThreadEntry {
  id?: string
  ts?: number
  [k: string]: any
}

export interface StoreOptions {
  storeUrl?: string
  /** Tope de cada petición al iframe (por defecto 8000). */
  timeoutMs?: number
  /** Tope para abrir el almacén, que es cargar una página por la red (por defecto 20000). */
  connectTimeoutMs?: number
  /** Cada cuánto se le pregunta al iframe mientras se espera su `ready` (por defecto 500). */
  helloEveryMs?: number
  /**
   * Identidad de @dotrino/identity: ata el almacén al PERFIL activo (y lo respalda en su
   * bóveda si está emparejada). Si el almacén ya estaba abierto sin identidad, lo adopta;
   * si estaba atado a otro perfil, `connect` lanza con `code: 'store-identity-mismatch'`.
   * Si la identidad no tiene perfil activo, lanza con `code: 'store-no-profile'`.
   */
  identity?: {
    currentProfile (): Promise<{ id: string } | null>
    [k: string]: any
  }
}

export interface ThreadSummary {
  lastEntry: ThreadEntry | null
  count: number
}

export interface ThreadStats {
  count: number
  bytes: number
}

/** Una entrada del contador de aperturas por app. */
export interface AppOpen {
  count: number
  ts: number
}

export interface StoreStats {
  totalBytes: number
  threadCount: number
  threads: Record<string, ThreadStats>
  /** Motor de persistencia activo del vault ('indexeddb' salvo fallback). */
  backend?: 'indexeddb' | 'localStorage'
  /** Bytes usados por el origen (navigator.storage.estimate), si disponible. */
  usage?: number | null
  /** Cuota total del origen en bytes (estimación del navegador), si disponible. */
  quota?: number | null
  /** true si el almacenamiento es persistente (no-evictable). */
  persisted?: boolean | null
}

export class Store {
  constructor (options?: StoreOptions)
  static connect (options?: StoreOptions): Promise<Store>
  static current (): Store | null
  /** Perfil al que está atado el almacén; null si se conectó sin identidad. */
  readonly profileId: string | null
  ready (): Promise<Store>
  destroy (): void
  ping (): Promise<{ pong: true; version: string }>
  setMaxPerThread (max: number): Promise<{ maxPerThread: number }>
  appendMessage (threadKey: string, entry: ThreadEntry): Promise<ThreadEntry>
  listThread (
    threadKey: string,
    opts?: { limit?: number; before?: number }
  ): Promise<ThreadEntry[]>
  listThreadKeys (): Promise<string[]>
  getThreadSummaries (): Promise<Record<string, ThreadSummary>>
  removeThread (threadKey: string): Promise<{ removed: number }>
  removeMessage (threadKey: string, id: string): Promise<{ removed: number }>
  clearAll (): Promise<{ ok: true }>
  getStats (): Promise<StoreStats>
  /** Registra una apertura de `appId` (típicamente el hostname de la app). */
  recordOpen (appId: string): Promise<AppOpen>
  /** Devuelve { [appId]: { count, ts } } con todas las aperturas registradas. */
  getOpens (): Promise<Record<string, AppOpen>>
  /** Borra el contador de aperturas. */
  clearOpens (): Promise<{ ok: true }>
  exportThreads (): Promise<{ threads: Record<string, ThreadEntry[]> }>
  importThreads (
    threads: Record<string, ThreadEntry[]>,
    mode?: 'merge' | 'replace'
  ): Promise<{ mode: string; count: number }>
  syncConnect (clientId: string): Promise<{ accessToken: string; expiresAt: number }>
  syncDisconnect (): Promise<void>
  syncUnlock (passphrase: string): Promise<{ ok: boolean }>
  syncLock (): Promise<void>
  syncStatus (): Promise<SyncStatus>
  syncNow (): Promise<SyncStatus>
  on (event: 'sync', handler: (event: SyncEvent) => void): () => void
  onSync (handler: (event: SyncEvent) => void): () => void
}

export interface SyncStatus {
  kind?: 'identity' | 'store'
  connected: boolean
  unlocked: boolean
  dirty: boolean
  lastError?: string | null
}

export interface SyncEvent {
  kind: 'identity' | 'store'
  status: 'connected' | 'disconnected' | 'unlocked' | 'locked' | 'syncing' | 'synced' | 'conflict' | 'offline' | 'error'
  error?: string
  ts: number
}
