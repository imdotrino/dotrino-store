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
