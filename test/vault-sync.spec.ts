import { test, expect, type Page } from '@playwright/test'

// El respaldo del almacén en la bóveda, contra una bóveda de mentira que usa las mismas
// reglas (`store/core.js`) y corta todo mensaje de más de 1 MB como el proxio.

const INVOICE_BYTES = 11_000   // lo que ocupa una factura de facturero en el almacén

async function open (page: Page, opts: { maxPerThread?: number, paired?: boolean, delayMs?: number } = {}) {
  await page.goto('/test/fixtures/blank.html')
  await page.evaluate(async (o) => {
    const { Store } = await import('/src/index.js' as string)
    const { createFakeVault } = await import('/test/fixtures/fake-vault.js' as string)
    const vault = createFakeVault({ paired: o.paired ?? true })
    vault.delayMs = o.delayMs ?? 0
    const events: unknown[] = []
    ;(window as any).__t = { Store, vault, events }
    const started = Date.now()
    const store = await Store.connect({ storeUrl: '/index.html', connectTimeoutMs: 8000, helloEveryMs: 100, identity: vault.identity, maxPerThread: o.maxPerThread })
    ;(window as any).__t.connectMs = Date.now() - started
    ;(window as any).__t.store = store
    store.on('vault', (e: unknown) => events.push(e))
  }, opts)
}

/** Espera a que el respaldo salga de «sincronizando» y devuelve su estado. */
async function settled (page: Page) {
  await page.waitForFunction(() => {
    const s = (window as any).__t.store.vault
    return s.state !== 'syncing'
  }, null, { timeout: 30000 })
  return page.evaluate(() => (window as any).__t.store.vault)
}

const big = (n: number, prefix = 'e', ts0 = 1) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, ts: ts0 + i, xml: 'x'.repeat(INVOICE_BYTES) }))

test('la huella de la página coincide con el vector compartido con la bóveda', async ({ page }) => {
  await open(page, { paired: false })
  const d = await page.evaluate(async () => {
    const { store } = (window as any).__t
    await store.importThreads({ t: [{ id: 'b', ts: 2 }, { id: 'a', ts: 1 }] })
    return store._call('getThreadDigests', {})
  })
  expect(d.t.digest).toBe('01599daf8046b8f94a7198d1ecbbf0a2665c246d9187f8d2bdf562cc78bf512e')
})

test('abrir el almacén no espera a la bóveda', async ({ page }) => {
  await open(page, { delayMs: 3000 })
  const t = await page.evaluate(() => ({ ms: (window as any).__t.connectMs, state: (window as any).__t.store.vault.state }))
  expect(t.ms).toBeLessThan(2500)
  expect(t.state).toBe('syncing')
  expect((await settled(page)).state).toBe('synced')
})

test('sin bóveda emparejada se dice, y sincronizar a mano lo explica', async ({ page }) => {
  await open(page, { paired: false })
  const s = await settled(page)
  expect(s).toMatchObject({ state: 'off', reason: 'not-paired' })
  const code = await page.evaluate(() => (window as any).__t.store.vaultSync().then(() => 'ok', (e: any) => e.code))
  expect(code).toBe('vault-off')
})

test('1,6 MB de facturas suben en tandas de menos de 1 MB', async ({ page }) => {
  await open(page, { maxPerThread: 50000 })
  await settled(page)
  const r = await page.evaluate(async (entries) => {
    const { store, vault } = (window as any).__t
    await store.importThreads({ 'facturero.invoices.2026-09-16': entries })
    const status = await store.vaultSync()
    return {
      status,
      inVault: vault.data.threads['facturero.invoices.2026-09-16']?.length,
      oversize: vault.oversize,
      imports: vault.calls.filter((c: any) => c.method === 'importThreads').length,
      maxRequest: Math.max(...vault.calls.map((c: any) => c.request)),
    }
  }, big(150))
  expect(r.oversize).toEqual([])
  expect(r.inVault).toBe(150)
  expect(r.imports).toBeGreaterThanOrEqual(5)
  expect(r.maxRequest).toBeLessThan(1024 * 1024)
  expect(r.status).toMatchObject({ state: 'synced', pending: 0 })
})

test('un aparato nuevo baja lo que ya estaba en la bóveda, por partes, y avisa qué cambió', async ({ page }) => {
  await open(page, { maxPerThread: 50000, delayMs: 200 })
  const r = await page.evaluate(async (entries) => {
    const { store, vault } = (window as any).__t
    vault.data.threads['facturero.invoices.2026-09-15'] = entries
    vault.data.threads['facturero.settings'] = [{ id: 'issuer:1', ts: 5, issuer: { ruc: '1790000000001' } }]
    vault.data.opens = { 'facturero.dotrino.com': { count: 7, ts: 9 } }
    await store.vaultSync()
    const list = await store.listThread('facturero.invoices.2026-09-15')
    const changed = (window as any).__t.events.filter((e: any) => e.state === 'synced').flatMap((e: any) => e.changed)
    return { count: list.length, changed, oversize: vault.oversize, opens: await store.getOpens() }
  }, big(150, 'inv'))
  expect(r.oversize).toEqual([])
  expect(r.count).toBe(150)
  expect(r.changed).toEqual(expect.arrayContaining(['facturero.invoices.2026-09-15', 'facturero.settings']))
  expect(r.opens['facturero.dotrino.com']).toMatchObject({ count: 7 })
})

test('lo escrito sube solo, sin sincronizar a mano', async ({ page }) => {
  await open(page)
  await settled(page)
  await page.evaluate(() => (window as any).__t.store.appendMessage('facturero.buyers', { id: 'b1', ts: 10, buyer: { id: '1710034065' } }))
  await page.waitForFunction(() => (window as any).__t.vault.data.threads['facturero.buyers']?.length === 1, null, { timeout: 10000 })
  expect((await page.evaluate(() => (window as any).__t.store.vault)).pending).toBe(0)
})

test('un borrado sin bóveda queda pendiente, sube al volver y no resucita', async ({ page }) => {
  await open(page)
  await settled(page)
  const r = await page.evaluate(async () => {
    const { store, vault } = (window as any).__t
    await store.importThreads({ 'facturero.products': [{ id: 'p1', ts: 1 }, { id: 'p2', ts: 2 }] })
    await store.vaultSync()
    const before = vault.data.threads['facturero.products'].length

    vault.offline = true
    await store.removeMessage('facturero.products', 'p1')
    const failed = await store.vaultSync().then(() => null, (e: any) => e.code)
    const whileOffline = store.vault

    vault.offline = false
    await store.vaultSync()
    return {
      before,
      failed,
      whileOffline,
      vault: vault.data.threads['facturero.products'].map((e: any) => e.id),
      local: (await store.listThread('facturero.products')).map((e: any) => e.id),
      after: store.vault,
    }
  })
  expect(r.before).toBe(2)
  expect(r.failed).toBe('vault-no-reply')
  expect(r.whileOffline).toMatchObject({ state: 'error', pending: 1, error: { code: 'vault-no-reply' } })
  expect(r.vault).toEqual(['p2'])
  expect(r.local).toEqual(['p2'])
  expect(r.after).toMatchObject({ state: 'synced', pending: 0 })
})

test('lo borrado en otro aparato se borra aquí, y lo editado después de borrarlo vuelve', async ({ page }) => {
  await open(page)
  await settled(page)
  const r = await page.evaluate(async () => {
    const { store, vault } = (window as any).__t
    await store.importThreads({ t: [{ id: 'a', ts: 1 }, { id: 'b', ts: 1 }, { id: 'c', ts: 1 }] })
    await store.vaultSync()
    // Otro aparato: borra `a`, y edita `b` (ts mayor).
    vault.data.threads.t = vault.data.threads.t.filter((e: any) => e.id !== 'a')
    vault.data.tombs.t = { a: [1, Date.now()] }
    vault.data.threads.t.find((e: any) => e.id === 'b').ts = 5
    await store.vaultSync()
    const first = (await store.listThread('t')).map((e: any) => `${e.id}@${e.ts}`)
    // Y aquí se edita `c` después: gana lo más nuevo, y sube.
    await store.appendMessage('t', { id: 'c', ts: 9 })
    await store.vaultSync()
    return { first, vault: vault.data.threads.t.map((e: any) => `${e.id}@${e.ts}`).sort() }
  })
  expect(r.first.sort()).toEqual(['b@5', 'c@1'])
  expect(r.vault).toEqual(['b@5', 'c@9'])
})

test('una bóveda vieja se nombra: hay que actualizarla', async ({ page }) => {
  await page.goto('/test/fixtures/blank.html')
  const r = await page.evaluate(async () => {
    const { Store } = await import('/src/index.js' as string)
    const { createFakeVault } = await import('/test/fixtures/fake-vault.js' as string)
    const vault = createFakeVault()
    vault.outdated = true
    const store = await Store.connect({ storeUrl: '/index.html', connectTimeoutMs: 8000, helloEveryMs: 100, identity: vault.identity })
    const code = await store.vaultSync().then(() => null, (e: any) => e.code)
    return { code, status: store.vault }
  })
  expect(r.code).toBe('vault-outdated')
  expect(r.status).toMatchObject({ state: 'error', error: { code: 'vault-outdated' } })
})

test('sin la clave de contenido no se manda nada, y se dice', async ({ page }) => {
  await page.goto('/test/fixtures/blank.html')
  const r = await page.evaluate(async () => {
    const { Store } = await import('/src/index.js' as string)
    const { createFakeVault } = await import('/test/fixtures/fake-vault.js' as string)
    const vault = createFakeVault()
    vault.noKey = true
    const store = await Store.connect({ storeUrl: '/index.html', connectTimeoutMs: 8000, helloEveryMs: 100, identity: vault.identity })
    await store.appendMessage('t', { id: 'x', ts: 1 })
    const code = await store.vaultSync().then(() => null, (e: any) => e.code)
    return { code, status: store.vault, stored: vault.data.threads.t }
  })
  expect(r.code).toBe('no-content-key')
  expect(r.status.pending).toBe(1)
  expect(r.stored).toBeUndefined()
})

test('un hilo recortado en el navegador no se vuelve a bajar en cada sincronización', async ({ page }) => {
  await open(page, { maxPerThread: 10 })
  const r = await page.evaluate(async () => {
    const { store, vault } = (window as any).__t
    vault.data.threads.chat = Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, ts: i + 1 }))
    await store.vaultSync()
    const local = (await store.listThread('chat')).map((e: any) => e.id)
    const before = vault.calls.length
    await store.vaultSync()
    const second = vault.calls.slice(before).map((c: any) => c.method)
    return { local, second, inVault: vault.data.threads.chat.length }
  })
  expect(r.local).toHaveLength(10)
  expect(r.local[9]).toBe('m29')
  expect(r.inVault).toBe(30)
  expect(r.second).not.toContain('getThreadIndexes')
  expect(r.second).not.toContain('getEntries')
})
