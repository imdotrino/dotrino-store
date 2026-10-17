/**
 * La copia de `store/vendor/` es la del `@dotrino/identity` instalado. Si falla: `node vendor.mjs`.
 * (No se llama *.test.mjs para que Playwright, que barre `test/`, no la recoja.)
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VENDORED } from '../vendor.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

for (const { from, to } of VENDORED) {
  test(`${to} matches ${from}`, async () => {
    assert.equal(await readFile(join(root, to), 'utf8'), await readFile(join(root, from), 'utf8'),
      `${to} is out of date: run node vendor.mjs`)
  })
}
