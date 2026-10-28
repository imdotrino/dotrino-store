/**
 * EL TOPE DEL RESPALDO (dueño, 2026-10-28): 25 MB por cuenta, sale lo más viejo de la app que
 * más ocupa, y lo que sale no es una lápida: sube el suelo del hilo y el aparato deja de subirlo.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as core from '../store/core.js'

const entry = (id, ts, kb) => ({ id, ts, body: 'x'.repeat(kb * 1024) })

test('pasado el tope, cede primero la app que más ocupa, por lo más viejo', () => {
  const threads = {
    chat: [entry('m1', 1, 40), entry('m2', 2, 40), entry('m3', 5, 40)],
    'facturero.invoices': [entry('f1', 0, 10)]
  }
  const owners = { chat: 'messenger.dotrino.com', 'facturero.invoices': 'facturero.dotrino.com' }
  const floors = {}
  const r = core.enforceQuota(threads, owners, floors, { maxBytes: 100 * 1024 })
  assert.deepEqual(threads.chat.map((e) => e.id), ['m2', 'm3'], 'sale m1, el más viejo del messenger')
  assert.deepEqual(threads['facturero.invoices'].map((e) => e.id), ['f1'], 'la factura, más vieja todavía, se queda')
  assert.equal(floors.chat, 1)
  assert.equal(r.evicted, 1)
  assert.ok(r.bytes <= 100 * 1024)
})

test('lo que está bajo el suelo no vuelve a entrar ni cuenta en la huella', async () => {
  const threads = { chat: [entry('m2', 2, 1)] }
  const floors = { chat: 1 }
  core.mergeEntries(threads, {}, { chat: [entry('m1', 1, 1), entry('m4', 4, 1)] }, { floors })
  assert.deepEqual(threads.chat.map((e) => e.id), ['m2', 'm4'])
  // El aparato tiene además m1 (lo conserva): con el suelo, su huella es la de la bóveda.
  const device = { chat: [entry('m1', 1, 1), ...threads.chat] }
  assert.equal((await core.digestsOf(device, null, floors)).chat.digest, (await core.digestsOf(threads)).chat.digest)
})

test('dos bóvedas con lo mismo borran lo mismo', () => {
  const make = () => ({ a: [entry('1', 1, 30), entry('2', 3, 30)], b: [entry('3', 2, 30)] })
  const x = make(); const y = make(); const fx = {}; const fy = {}
  core.enforceQuota(x, {}, fx, { maxBytes: 50 * 1024 })
  core.enforceQuota(y, {}, fy, { maxBytes: 50 * 1024 })
  assert.deepEqual(x, y)
  assert.deepEqual(fx, fy)
  assert.equal(core.mergeFloors(fx, { a: 0 }), false, 'un suelo más bajo no baja el que hay')
})
