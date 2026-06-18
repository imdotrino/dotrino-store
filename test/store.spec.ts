import { test, expect, type Page } from '@playwright/test'

// Tests del vault `store.dotrino.com` (backend IndexedDB). Cada test usa un
// contexto fresco → IndexedDB aislado. Manejamos los handlers del vault por
// `postMessage` (igual que hace el SDK), cargando la página del vault como top.

// Inyecta `window.__call(method, params)` que habla con el handler por postMessage.
async function injectCall (page: Page) {
  await page.evaluate(() => {
    ;(window as unknown as { __call: (m: string, p?: unknown) => Promise<unknown> }).__call =
      (method: string, params?: unknown) => new Promise((resolve, reject) => {
        const id = 'r' + Math.random().toString(36).slice(2)
        const onMsg = (e: MessageEvent) => {
          const d = e.data
          if (!d || d._ccs !== true || d.type !== 'response' || d.id !== id) return
          window.removeEventListener('message', onMsg)
          if (d.error) reject(new Error(d.error)); else resolve(d.result)
        }
        window.addEventListener('message', onMsg)
        window.postMessage({ _ccs: true, type: 'request', id, method, params }, '*')
      })
  })
}

function call<T = unknown> (page: Page, method: string, params?: unknown): Promise<T> {
  return page.evaluate(
    ([m, p]) => (window as unknown as { __call: (m: string, p?: unknown) => Promise<T> }).__call(m as string, p),
    [method, params] as const,
  )
}

async function load (page: Page) {
  await page.goto('/index.html', { waitUntil: 'domcontentloaded' })
  await injectCall(page)
}

interface Entry { id: string; ts: number; text?: string }

test('append, dedup por id y listThread ordenado', async ({ page }) => {
  await load(page)
  await call(page, 'appendMessage', { threadKey: 't1', entry: { id: 'a', ts: 1, text: 'uno' } })
  await call(page, 'appendMessage', { threadKey: 't1', entry: { id: 'b', ts: 2, text: 'dos' } })
  // mismo id → actualiza, no duplica
  await call(page, 'appendMessage', { threadKey: 't1', entry: { id: 'a', ts: 1, text: 'uno-editado' } })
  const list = await call<Entry[]>(page, 'listThread', { threadKey: 't1' })
  expect(list.map((e) => e.text)).toEqual(['uno-editado', 'dos'])
})

test('appendMessage asigna id y ts si faltan', async ({ page }) => {
  await load(page)
  const entry = await call<Entry>(page, 'appendMessage', { threadKey: 't1', entry: { text: 'sin meta' } })
  expect(entry.id).toBeTruthy()
  expect(typeof entry.ts).toBe('number')
})

test('persiste en IndexedDB a través de recargas', async ({ page }) => {
  await load(page)
  await call(page, 'appendMessage', { threadKey: 'room:1', entry: { id: 'e1', ts: 1, text: 'persistente' } })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await injectCall(page)
  const list = await call<Entry[]>(page, 'listThread', { threadKey: 'room:1' })
  expect(list.map((e) => e.text)).toEqual(['persistente'])
  const stats = await call<{ backend: string }>(page, 'getStats')
  expect(stats.backend).toBe('indexeddb')
})

test('migra datos del localStorage viejo a IndexedDB (una vez)', async ({ page }) => {
  // Sembrar la clave del store anterior ANTES de que cargue store.js.
  await page.addInitScript(() => {
    localStorage.setItem('cc.store.threads.v1', JSON.stringify({
      'legacy:1': [{ id: 'L1', ts: 1, text: 'dato viejo' }],
    }))
  })
  await load(page)
  const list = await call<Entry[]>(page, 'listThread', { threadKey: 'legacy:1' })
  expect(list.map((e) => e.text)).toEqual(['dato viejo'])
  const stats = await call<{ backend: string; threadCount: number }>(page, 'getStats')
  expect(stats.backend).toBe('indexeddb')
})

test('listThreadKeys y getThreadSummaries', async ({ page }) => {
  await load(page)
  await call(page, 'appendMessage', { threadKey: 'A', entry: { id: 'a1', ts: 1 } })
  await call(page, 'appendMessage', { threadKey: 'A', entry: { id: 'a2', ts: 2, text: 'last' } })
  await call(page, 'appendMessage', { threadKey: 'B', entry: { id: 'b1', ts: 1 } })
  const keys = await call<string[]>(page, 'listThreadKeys')
  expect(keys.sort()).toEqual(['A', 'B'])
  const sum = await call<Record<string, { count: number; lastEntry: Entry }>>(page, 'getThreadSummaries')
  expect(sum.A.count).toBe(2)
  expect(sum.A.lastEntry.id).toBe('a2')
  expect(sum.B.count).toBe(1)
})

test('removeMessage y removeThread', async ({ page }) => {
  await load(page)
  await call(page, 'appendMessage', { threadKey: 't', entry: { id: 'x', ts: 1 } })
  await call(page, 'appendMessage', { threadKey: 't', entry: { id: 'y', ts: 2 } })
  const r1 = await call<{ removed: number }>(page, 'removeMessage', { threadKey: 't', id: 'x' })
  expect(r1.removed).toBe(1)
  let list = await call<Entry[]>(page, 'listThread', { threadKey: 't' })
  expect(list.map((e) => e.id)).toEqual(['y'])
  const r2 = await call<{ removed: number }>(page, 'removeThread', { threadKey: 't' })
  expect(r2.removed).toBe(1)
  list = await call<Entry[]>(page, 'listThread', { threadKey: 't' })
  expect(list).toEqual([])
})

test('clearAll vacía todo', async ({ page }) => {
  await load(page)
  await call(page, 'appendMessage', { threadKey: 't', entry: { id: 'x', ts: 1 } })
  await call(page, 'clearAll')
  const keys = await call<string[]>(page, 'listThreadKeys')
  expect(keys).toEqual([])
})

test('setMaxPerThread recorta lo más viejo', async ({ page }) => {
  await load(page)
  await call(page, 'setMaxPerThread', { max: 3 })
  for (let i = 0; i < 6; i++) {
    await call(page, 'appendMessage', { threadKey: 't', entry: { id: 'e' + i, ts: i } })
  }
  const list = await call<Entry[]>(page, 'listThread', { threadKey: 't' })
  expect(list.map((e) => e.id)).toEqual(['e3', 'e4', 'e5'])
})

test('importThreads merge y replace', async ({ page }) => {
  await load(page)
  await call(page, 'appendMessage', { threadKey: 't', entry: { id: 'a', ts: 1 } })
  // merge: agrega sin perder lo existente
  await call(page, 'importThreads', { threads: { t: [{ id: 'b', ts: 2 }], otro: [{ id: 'c', ts: 1 }] }, mode: 'merge' })
  let list = await call<Entry[]>(page, 'listThread', { threadKey: 't' })
  expect(list.map((e) => e.id).sort()).toEqual(['a', 'b'])
  // replace: reemplaza todo el estado
  await call(page, 'importThreads', { threads: { z: [{ id: 'z1', ts: 1 }] }, mode: 'replace' })
  const keys = await call<string[]>(page, 'listThreadKeys')
  expect(keys).toEqual(['z'])
})

test('getStats reporta backend indexeddb y cuota', async ({ page }) => {
  await load(page)
  await call(page, 'appendMessage', { threadKey: 't', entry: { id: 'a', ts: 1, text: 'hola' } })
  const stats = await call<{ backend: string; totalBytes: number; quota: number | null; threadCount: number }>(page, 'getStats')
  expect(stats.backend).toBe('indexeddb')
  expect(stats.totalBytes).toBeGreaterThan(0)
  expect(stats.threadCount).toBe(1)
  // En Chromium la cuota de IndexedDB es enorme (no el techo de ~5MB de localStorage).
  expect(stats.quota === null || stats.quota > 50 * 1024 * 1024).toBeTruthy()
})
