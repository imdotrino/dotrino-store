# @dotrino/store

> **Parte del ecosistema [Dotrino](https://dotrino.com).** Dotrino es un ecosistema de aplicaciones centradas en la privacidad de los datos: tu información es tuya, y las decisiones sobre ella también — qué compartes, con quién, cuándo y por qué. Sin anuncios, sin cookies, sin rastreo de datos, sin vender tu identidad a nadie.

Almacén compartido de hilos de mensajes para el ecosistema [Dotrino](https://github.com/imdotrino).

Mismo patrón que [dotrino-identity](https://github.com/imdotrino/dotrino-identity): un iframe oculto servido desde `store.dotrino.com` mantiene los datos en su propio almacenamiento. Cualquier app del ecosistema (web messenger, extensión Chrome, futura app móvil PWA) que cargue este iframe en el mismo navegador comparte los mismos hilos.

## Almacenamiento: IndexedDB (desde v0.3.0)

El backend del vault es **IndexedDB** (antes `localStorage`):

- **Cuota grande y dinámica** según el disco (cientos de MB a GB), en vez del techo de ~5 MB de `localStorage`. Desaparece el riesgo de evicción del más viejo al llenarse el bucket compartido del origen.
- Pide **`navigator.storage.persist()`** → almacenamiento **persistente / no-evictable** (best-effort).
- **Migración automática** una sola vez: si hay datos en el `localStorage` anterior (`cc.store.threads.v1`), se copian a IndexedDB en el primer arranque.
- Si IndexedDB no está disponible (p. ej. modo privado), cae a `localStorage` para no perder funcionalidad.
- 100% local: no requiere cuenta ni terceros. (El **sync** opcional a tu Google Drive sigue aparte, cifrado y off por defecto.)
- `getStats()` reporta `backend`, `usage`, `quota` y `persisted`.

## Por qué un subdominio aparte

- Los mensajes son volumen mucho mayor que las claves/contactos. Mantenerlos fuera del vault de identidad evita saturar ese almacenamiento.
- Cada origen tiene su propia cuota. Subdominios distintos = aislar y sumar cuotas.
- Permite evolucionar el schema de mensajería sin tocar el de identidad (más estable).

## API

```js
import { Store } from '@dotrino/store'

const store = await Store.connect()  // singleton — carga el iframe oculto

// El threadKey lo decide la app (típicamente la pubkey del contacto)
await store.appendMessage(contactPubkey, {
  dir: 'out',
  text: 'hola',
  ts: Date.now()
  // id se autogenera si no lo pasas
})

const entries = await store.listThread(contactPubkey, { limit: 50 })

const summaries = await store.getThreadSummaries()
// → { [pubkey]: { lastEntry, count } }   para sidebar de conversaciones

await store.removeThread(contactPubkey)
await store.clearAll()                    // borrar todo el almacén

const stats = await store.getStats()
// → { totalBytes, threadCount, threads: { [k]: { count, bytes } },
//     backend: 'indexeddb', usage, quota, persisted }
```

## Abrir el almacén: el saludo (desde 0.9.0)

`Store.connect()` carga el iframe y espera su `ready`. Ese mensaje se manda **una sola vez**, al cargar la página: si se pierde, o si la página tarda más que el tope, quien esperaba se queda sin almacén y la app enseña «No se pudo abrir tu almacén». Qué cambió:

- **El cliente pregunta, además de escuchar.** Mientras espera manda `{ _ccs: true, type: 'hello' }` al iframe cada `helloEveryMs` (500 ms por defecto) y la página contesta `ready`. Un `ready` perdido deja de ser definitivo.
- **Abrir tiene su propio tope**: `connectTimeoutMs` (20 s), aparte del de cada petición (`timeoutMs`, 8 s). Abrir es cargar una página por la red; una petición no.
- **Un fallo ya no dura toda la sesión.** Hasta 0.8.0 la promesa rechazada se quedaba cacheada en el singleton, así que cualquier reintento —el botón «Reintentar» que enseñan las apps— devolvía el mismo error sin intentar nada. Ahora el fallo desmonta el iframe y el siguiente `connect()` levanta uno nuevo.
- **El error dice qué pasó**: `Store did not respond within 20000ms (https://store.dotrino.com/ never loaded)`.

## Un almacén por perfil: `connect({ identity })` (desde 0.10.0)

Con `identity` (de `@dotrino/identity`), el almacén se ata al **perfil activo**: cada perfil del aparato tiene sus propios hilos, y si el perfil está emparejado con una bóveda, el almacén se respalda en ella.

```js
const store = await Store.connect({ identity })
store.profileId   // 'p2419686e' — o null si se conectó sin identidad
```

- **Llegar tarde ya no deja sin perfil.** El almacén es un singleton por página, y la moneda de `<dotrino-support>` lo abre **sin** identidad al montarse para contar la apertura; suele llegar antes que la app. Hasta 0.9.0, la app que después pedía `connect({ identity })` recibía ese almacén sin perfil y todo lo suyo iba, **sin ningún error**, al espacio común de todos los perfiles del aparato. Ahora el almacén abierto **adopta** la identidad antes de devolverse.
- **Otro perfil se rechaza.** Si el almacén ya está atado a un perfil y llega una identidad de otro, `connect` lanza con `code: 'store-identity-mismatch'`.
- **Sin perfil no se abre.** Si la identidad no tiene perfil activo, `connect` lanza con `code: 'store-no-profile'`. Antes se caía al espacio por defecto en silencio.

## Garantías

- **Per-thread cap**: 1000 mensajes por defecto, configurable con `setMaxPerThread(n)`. El más antiguo se descarta al añadir uno nuevo si pasa el cap.
- **Eviction global ante `QuotaExceededError`**: solo como red de seguridad (con IndexedDB es prácticamente inalcanzable). Descarta el 20% más antiguo a través de todos los hilos y reintenta hasta 8 veces.
- **No sale del navegador**: nunca se hace fetch, no hay servidor, no hay analytics (salvo el sync opcional a tu Drive, off por defecto).

## Deploy

GitHub Actions despliega a `store.dotrino.com` cuando cambia algo en `store/`. El bundle del iframe es estático (HTML + JS, sin build).

## Schema

IndexedDB `cc-store` → object store `kv` → key `threads.v1`:

```
value: JSON { [threadKey: string]: ThreadEntry[] }
```

Las entradas son objetos opacos para el store; solo se les pide `id` y `ts` para deduplicación y ordenamiento.

## Tests

```bash
npm install
npm test        # Playwright: sirve el vault y ejercita los handlers vía postMessage
                # (IndexedDB real: append/list/dedup, persistencia, migración, stats…)
```

## Auto-sync con Google Drive (0.2.0+)

Backup cifrado y sync multi-dispositivo de los hilos contra `appDataFolder` de Google Drive. Mismo modelo y API que [`@dotrino/identity`](https://github.com/imdotrino/dotrino-identity#auto-sync-con-google-drive-080) — los mensajes se cifran con AES-256-GCM (clave derivada por PBKDF2 600 000 iter de la passphrase) antes de subirse, así que Google solo ve bytes opacos.

```js
await store.syncConnect(clientId)              // OAuth popup (scope: drive.appdata)
await store.syncUnlock('mi-passphrase')        // ≥12 chars
store.onSync(ev => console.log(ev.status))    // syncing | synced | offline | conflict | error
await store.syncNow()                          // forzar pull+push
```

**Merge de hilos**: unión por `id`, dedup, last-writer por `ts`, ordena ascendente, aplica `maxPerThread` después del merge. Append-only así que el merge es trivial — si dos dispositivos añaden mensajes a la vez, el resultado contiene los dos sets sin pérdida.

Nuevos métodos también para export/import manual:

```js
const { threads } = await store.exportThreads()
await store.importThreads(threads, 'merge')   // o 'replace'
```
