import { test, expect, type Page } from '@playwright/test'

// Tests del CLIENTE (`src/index.js`): el saludo con el iframe, que es donde se rompe la
// comunicación. El servidor de test sirve el cliente en `/src/` y las páginas de prueba
// en `/test/fixtures/`, así el cliente corre en una página que NO es la del store.

type Result = string

async function connect (page: Page, options: Record<string, unknown>): Promise<Result> {
  return page.evaluate(async (opts) => {
    const path = '/src/index.js'
    const { Store } = await import(path)
    try {
      const store = await Store.connect(opts)
      return store === Store.current() ? 'ok' : 'ok:otra instancia'
    } catch (e) {
      return 'error:' + (e as Error).message
    }
  }, options)
}

test('preguntar al iframe repone un «ready» que se perdió', async ({ page }) => {
  await page.goto('/test/fixtures/blank.html')
  // Esta página del store no saluda al cargar: solo contesta si le preguntan.
  const r = await connect(page, { storeUrl: '/test/fixtures/hello-only.html', connectTimeoutMs: 8000, helloEveryMs: 100 })
  expect(r).toBe('ok')
})

test('un almacén que no contesta falla diciéndolo, y el siguiente intento vuelve a intentarlo', async ({ page }) => {
  await page.goto('/test/fixtures/blank.html')
  const first = await connect(page, { storeUrl: '/test/fixtures/silent.html', connectTimeoutMs: 900, helloEveryMs: 100 })
  expect(first).toMatch(/^error:Store did not respond within 900ms/)
  expect(first).toContain('loaded') // dice si el iframe llegó a cargar

  // El fallo NO se queda cacheado en el singleton: con el store de verdad, conecta y sirve.
  const second = await connect(page, { storeUrl: '/index.html', connectTimeoutMs: 8000, helloEveryMs: 100 })
  expect(second).toBe('ok')
  const pong = await page.evaluate(async () => {
    const path = '/src/index.js'
    const { Store } = await import(path)
    return Store.current().ping()
  })
  expect(pong).toMatchObject({ pong: true })
})

test('la página del store contesta «ready» a quien le pregunta', async ({ page }) => {
  await page.goto('/index.html', { waitUntil: 'domcontentloaded' })
  const version = await page.evaluate(() => new Promise<string>((resolve, reject) => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data
      if (!d || d._ccs !== true || d.type !== 'ready') return
      window.removeEventListener('message', onMsg)
      resolve(String(d.version))
    }
    window.addEventListener('message', onMsg)
    window.postMessage({ _ccs: true, type: 'hello' }, '*')
    setTimeout(() => reject(new Error('the store never answered the hello')), 3000)
  }))
  expect(version).toBeTruthy()
})

// ----- el perfil no se pierde por llegar tarde -----
//
// La moneda de <dotrino-support> conecta SIN identidad al montarse y suele ganar la
// carrera. Hasta 0.9.0 la app que luego pedía `connect({ identity })` recibía ese
// almacén sin perfil y guardaba en el espacio común de todos los perfiles, sin error.

test('la moneda conecta primero sin identidad y la app con identidad igual queda en su perfil', async ({ page }) => {
  await page.goto('/test/fixtures/blank.html')
  const r = await page.evaluate(async () => {
    const path = '/src/index.js'
    const { Store } = await import(path)
    const fake = (id: string) => ({ currentProfile: async () => ({ id }), onVault: () => () => {}, vaultStatus: async () => ({ paired: false }) })
    const opts = { storeUrl: '/index.html', connectTimeoutMs: 8000, helloEveryMs: 100 }

    // Lo que hace la moneda: conectar sin identidad y escribir algo.
    const coin = await Store.connect(opts)
    await coin.appendMessage('compartido', { id: 'de-la-moneda', ts: 1 })
    const beforeProfile = coin.profileId

    // Lo que hace la app, después.
    const app = await Store.connect({ ...opts, identity: fake('perfil-a') })
    const sameInstance = app === coin
    const seenByApp = await app.listThread('compartido')
    await app.appendMessage('mio', { id: 'de-a', ts: 2 })

    // Otra conexión del MISMO perfil vale; la de OTRO perfil se rechaza.
    const again = await Store.connect({ ...opts, identity: fake('perfil-a') })
    let otherError = ''
    try { await Store.connect({ ...opts, identity: fake('perfil-b') }) } catch (e) { otherError = (e as { code?: string }).code || String(e) }

    return { beforeProfile, sameInstance, profileId: app.profileId, seenByApp: seenByApp.length, again: again === app, otherError }
  })
  expect(r.beforeProfile).toBeNull()
  expect(r.sameInstance).toBe(true)
  expect(r.profileId).toBe('perfil-a')
  // Lo que escribió la moneda en el espacio común NO aparece en el perfil de la app.
  expect(r.seenByApp).toBe(0)
  expect(r.again).toBe(true)
  expect(r.otherError).toBe('store-identity-mismatch')
})

test('dos conexiones con identidad a la vez esperan las dos a quedar en el perfil', async ({ page }) => {
  await page.goto('/test/fixtures/blank.html')
  const r = await page.evaluate(async () => {
    const path = '/src/index.js'
    const { Store } = await import(path)
    const opts = { storeUrl: '/index.html', connectTimeoutMs: 8000, helloEveryMs: 100 }
    const identity = { currentProfile: async () => { await new Promise((ok) => setTimeout(ok, 200)); return { id: 'lento' } }, onVault: () => () => {}, vaultStatus: async () => ({ paired: false }) }
    await Store.connect(opts)
    const [a, b] = await Promise.all([Store.connect({ ...opts, identity }), Store.connect({ ...opts, identity })])
    return [a.profileId, b.profileId]
  })
  expect(r).toEqual(['lento', 'lento'])
})

test('una identidad sin perfil activo hace fallar la conexión en vez de caer al espacio común', async ({ page }) => {
  await page.goto('/test/fixtures/blank.html')
  const r = await page.evaluate(async () => {
    const path = '/src/index.js'
    const { Store } = await import(path)
    const opts = { storeUrl: '/index.html', connectTimeoutMs: 8000, helloEveryMs: 100 }
    const noProfile = { currentProfile: async () => null, onVault: () => () => {}, vaultStatus: async () => ({ paired: false }) }
    const out: string[] = []
    // Al abrir de cero…
    try { await Store.connect({ ...opts, identity: noProfile }); out.push('abrió') } catch (e) { out.push((e as { code?: string }).code || String(e)) }
    // …y al adoptar un almacén ya abierto sin identidad.
    await Store.connect(opts)
    try { await Store.connect({ ...opts, identity: noProfile }); out.push('adoptó') } catch (e) { out.push((e as { code?: string }).code || String(e)) }
    out.push(String(Store.current()?.profileId))
    return out
  })
  expect(r).toEqual(['store-no-profile', 'store-no-profile', 'null'])
})
