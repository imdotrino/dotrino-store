// Reglas de los hilos compartidas por la página del almacén y la bóveda (ver core.js).
export interface Entry { id?: string | number; ts?: number; [k: string]: any }
export type Threads = Record<string, Entry[]>
/** { [threadKey]: { [id]: [ts, at] } } */
export type Tombs = Record<string, Record<string, [number, number]>>
/** [id, ts] de una entrada · [id, ts, at] de una lápida */
export type IndexRow = [string | number, number] | [string, number, number]

export const MAX_PER_THREAD_LIMIT: number
export const TOMB_TTL_MS: number
export const PAGE_BYTES: number
export function byteLength (value: unknown): number
export function validKey (key: unknown): boolean
export function threadDigest (entries: Entry[]): Promise<string>
export function digestsOf (threads: Threads, keys?: string[]): Promise<Record<string, { count: number; digest: string }>>
export function tombOf (tombs: Tombs, k: string, id: string | number): [number, number] | undefined
export function isBuried (tombs: Tombs, k: string, entry: Entry): boolean
export function bury (tombs: Tombs, k: string, id: string | number, ts: number, at: number): boolean
export function pruneTombs (tombs: Tombs, now: number): boolean
export function applyTombs (threads: Threads, tombs: Tombs, incoming: Record<string, [string, number, number?][]> | undefined, now: number): { changed: Set<string>; tombsChanged: boolean }
export function mergeEntries (threads: Threads, tombs: Tombs, incoming: Threads | undefined, opts?: { mode?: 'merge' | 'upsert'; max?: number }): Set<string>
export function writeEntry (threads: Threads, tombs: Tombs, k: string, entry: Entry, opts: { max: number; now: number; newId: () => string }): { entry: Entry; tombCleared: boolean }
export function removeEntry (threads: Threads, tombs: Tombs, k: string, id: string | number, now: number): number
export function removeWholeThread (threads: Threads, tombs: Tombs, k: string, now: number): number
export function indexPage (threads: Threads, tombs: Tombs, keys: string[], cursor: { k: number; o: number } | null, maxBytes: number): { indexes: Record<string, { items: IndexRow[]; tombs: IndexRow[] }>; next: { k: number; o: number } | null }
export function entriesPage (threads: Threads, refs: Record<string, (string | number)[]>, maxBytes: number): { threads: Threads; rest: Record<string, (string | number)[]> | null }
export function pickTombs (tombs: Tombs, refs?: Record<string, (string | number)[]>, keys?: string[]): Record<string, [string, number, number][]>
export function mergeOpens (opens: Record<string, { count: number; ts: number }>, incoming: Record<string, { count: number; ts: number }>): boolean
