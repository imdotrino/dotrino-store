/**
 * RE-VENDORIZAR lo que el iframe toma de `@dotrino/identity`.
 *
 * `store.dotrino.com` se sirve ESTÁTICO —sin bundler—, así que el sincronizado con Drive
 * (`vault/sync.js` de identity: OAuth, el cifrado por frase de paso y el calendario de
 * subidas) viaja copiado en `store/vendor/identity/`. Antes vivía aquí escrito otra vez,
 * idéntico, y cualquier arreglo había que hacerlo dos veces.
 *
 * El script COPIA desde el paquete instalado y `test/vendor-up-to-date.check.mjs` FALLA
 * si alguien subió identity y no lo corrió.
 *
 *   node vendor.mjs
 */
import { copyFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const VENDORED = [
  { from: 'node_modules/@dotrino/identity/vault/sync.js', to: 'store/vendor/identity/sync.js' },
]

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const { from, to } of VENDORED) {
    await mkdir(dirname(join(here, to)), { recursive: true })
    await copyFile(join(here, from), join(here, to))
    console.log(`vendor: ${from} → ${to}`)
  }
}
