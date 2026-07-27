# Políticas de datos — cómo se reconcilia el contenido dentro de UNA cuenta

> Pedido del dueño (2026-07-25, retomado el 2026-07-27). Es la pasada que
> [`acta-de-perfil.md §7`](../../dotrino-vault/docs/acta-de-perfil.md) dejaba abierta.
> El acta define **quién** puede leer y escribir; esto define **qué pasa cuando dos
> aparatos de la misma cuenta escribieron lo mismo por separado**.
>
> No confundir con [`vinculacion-de-cuentas.md`](../../dotrino-vault/docs/vinculacion-de-cuentas.md),
> que es entre cuentas **distintas** (dos caminos, sin fusión).
>
> ⚠️ **Sin retrocompatibilidad, por decisión del dueño (2026-07-27).** Dotrino está en pruebas:
> no hay cuentas viejas que cuidar, ni datos que preservar, ni esquema que respetar. El
> almacén arranca en una clave nueva (`threads.<pid>.v2`) y **lo anterior no se migra**. Es la
> última ventana para romper el formato sin costo: se rompe ahora y se hace bien.

---

## 0. El principio

**Ningún dato se pierde por un empate, y ningún reloj decide.** Cada tipo de dato dice de
antemano cómo se resuelve, y la regla es determinista: los mismos cambios, en cualquier orden
de llegada, dan siempre el mismo resultado.

Es la misma disciplina del acta —precedencia por `seq`, nunca por fecha— aplicada al
contenido: si el reloj decidiera, cualquier aparato con la hora mal reescribiría tu historia
sin darse cuenta.

### Lo que hay hoy, y por qué no alcanza

`dotrino-store/store/store.js` guarda `{ [threadKey]: entry[] }` y mezcla así
(`mergeThreads`, `:204`):

```js
else if ((e.ts || 0) > (prev.ts || 0)) { byId.set(e.id, e); added++ }
```

Tres problemas, en orden de gravedad:

1. **Gana el de fecha más nueva** — exactamente lo que el modelo prohíbe. Un teléfono con el
   reloj adelantado le pisa las ediciones a todos los demás, para siempre.
2. **Borrar no se propaga.** `removeMessage` (`:369`) borra local; cualquier otro aparato que
   todavía tenga la entrada la vuelve a meter en la siguiente mezcla. **Lo borrado resucita.**
3. **La cuota evicta en silencio.** `dropOldest` (`:151`) tira el 20 % más viejo ante
   `QuotaExceededError` sin decírselo a nadie.

Y un cuarto que no es del merge pero cuenta: **`opens` no se sincroniza** (`mergeForSync`
solo toca `threads`), así que el contador de aperturas es por aparato. Está bien que hoy sea
así, pero si algún día se sincroniza **no puede ser un número que se pisa** (§2, `contador`).

---

## 1. La unidad: un ítem con su política

Todo lo que se guarda es un **ítem** con un sobre de metadatos. El sobre es lo único que
necesita quien mezcla; el cuerpo es de la app.

```jsonc
{
  "id": "…",              // estable, lo pone la app (o se genera)
  "pol": "log",           // la POLÍTICA (§2). Sin ella se asume `log`.
  "wid": "AB12-CD34",     // qué LLAVE del acta escribió esto (miembro)
  "wseq": 42,             // su contador local, monotónico. Es el reloj lógico.
  "ts": 1690000000000,    // epoch ms — SOLO para mostrar y ordenar en pantalla
  "del": false,           // lápida (§3)
  "body": { /* … */ }
}
```

- **`wid` + `wseq` es el reloj que decide**; `ts` no decide nunca, ni siquiera para ordenar
  una mezcla (ordena la vista, que es otra cosa).
- **`wseq` es por miembro y monotónico**: cada llave del acta lleva su propio contador. Dos
  escrituras del mismo miembro están ordenadas entre sí; entre miembros distintos pueden ser
  **concurrentes**, y ahí es donde entra la política.
- **Idempotencia**: `(wid, wseq)` identifica una escritura. Aplicarla dos veces no cambia
  nada. Esto es lo que permite reintentar sin miedo y reanudar una copia a la mitad.

### El sobre va en claro; el cuerpo, cifrado

Cuando el store empiece a usar `sealContent`/`openContent` (existen en identity y en el vault,
todavía sin consumidores), **el `body` se cifra y el sobre no**. Si no, mezclar exigiría abrir
todo, y el vault —que guarda pero no debería leer— no podría hacer su trabajo.

Lo que eso deja ver a quien guarda: **cuántos ítems hay, de qué aparato y cuándo**. No **qué**
dicen. Es el precio de poder mezclar sin descifrar, y solo lo ven los miembros de tu propia
cuenta y tu bóveda. Se dice acá para que sea una decisión y no un descuido.

---

## 2. El catálogo de políticas (lista cerrada)

| Política | Para qué | Cómo se resuelve | La trampa que evita |
|---|---|---|---|
| **`log`** | mensajes, eventos, historial | **Unión por `id`.** Una entrada nunca se pisa: si llega otra con el mismo `id`, se queda la que ya estaba. | Que una re-entrega «actualice» un mensaje viejo. |
| **`registro`** | ajustes, una ficha, una nota | Gana el `wseq` mayor **del mismo miembro**; entre miembros concurrentes gana el **hash menor** del ítem, y **el perdedor se guarda como variante** (§4). | Perder una edición porque otro aparato tenía el reloj adelantado. |
| **`contador`** | aperturas, veces que hiciste algo | **Una casilla por miembro**; el valor es la **suma**. Cada aparato solo escribe la suya. | Que dos aparatos se pisen el número y el conteo baje. |
| **`conjunto`** | etiquetas, favoritos, listas | `add`/`del` con lápida. A igual reloj **quitar gana**. | Que lo que sacaste vuelva solo. |
| **`archivo`** | fotos, adjuntos, blobs | **Direccionado por hash**: el `id` es el hash del contenido, así que dos escrituras iguales *son* la misma. | No hay conflicto posible, por construcción. |

Cerrada a propósito. Si un dato no encaja en ninguna, la conversación es «qué política le
falta al catálogo», no «qué regla especial le hago a esta app».

**Por defecto `log`** al escribir sin declarar política: es la más conservadora, nunca pisa
nada. (No es un modo de compatibilidad: los ítems del esquema viejo no se leen, se descartan
con el `v1` entero.)

---

## 3. Borrar es escribir (lápidas)

Borrar no puede ser «que no esté»: la ausencia no viaja. Borrar es **escribir un ítem con
`del: true`**, con su `wid`/`wseq` como cualquier otra escritura.

- Una lápida **gana** a las escrituras anteriores del mismo ítem, y **empata a favor del
  borrado** frente a una escritura concurrente (mismo criterio que `conjunto`): entre
  reaparecer y quedarse borrado, se queda borrado. Volver a crearlo es un gesto del usuario,
  y resucitar solo no lo es.
- **Retención de lápidas: 12 meses**, igual que la ventana del acta (`acta-de-perfil.md §1.3`).
  Un aparato apagado más tiempo que eso vuelve con ítems que el resto ya enterró; se re-admite
  su copia como si fuera nueva. Es raro, es visible, y es preferible a guardar lápidas para
  siempre.
- **La lápida no guarda el cuerpo.** Borrar tiene que borrar de verdad.

---

## 4. Nada se pierde en un empate: las variantes

Cuando dos miembros editaron el mismo `registro` de forma concurrente, la regla del hash dice
**cuál se muestra**, pero el otro **no se tira**: queda guardado como variante del mismo ítem,
marcada con quién y cuándo.

- La app puede ignorarlas (y se comporta como cualquier sistema normal), o mostrarlas
  («esto se editó en dos aparatos»).
- Las variantes se podan con el mismo criterio que las lápidas (12 meses) o cuando el usuario
  resuelve el empate eligiendo una.
- **Regla dura: ninguna política puede descartar datos en silencio.** Si una resolución
  descarta algo, o lo guarda como variante, o lo dice.

---

## 5. La cuota avisa, no evicta

`dropOldest` tira el 20 % más viejo cuando el backend se queda sin espacio, sin decir nada.
Eso es perder datos del usuario en silencio, que es justo lo que este documento existe para
impedir.

- Ante `QuotaExceededError`: **fallar la escritura con un error claro** y emitir un evento
  para que la app avise («te estás quedando sin espacio»).
- Evictar solo si el dueño lo pide, y diciéndole qué se va.
- La copia en la bóveda (que tiene disco de verdad) es la salida natural cuando el navegador
  se llena.

---

## 6. Fases

### B0 — El sobre (esquema nuevo, se rompe el viejo)

- [ ] `pol` / `wid` / `wseq` / `del` **obligatorios** en el ítem (`pol` por defecto `log` al
      escribir). Un ítem sin sobre es un error, no un caso a tolerar.
- [ ] Contador `wseq` por miembro, persistido en el store del perfil; `wid` = la huella corta
      de la llave del miembro (`keyLabel`, la misma que ya se muestra en el acta).
- [ ] **Clave nueva** `threads.<pid>.v2` y `opens.<pid>.v2`. **Nada se migra**: el `v1` se
      ignora y se borra. Sin ruta de lectura del formato viejo — es lo que evita arrastrar
      dos merges en paralelo para siempre.

### B1 — Mezcla por política

- [ ] Reemplazar `mergeThreads` (`store/store.js:204`) por un merge que **despacha por `pol`**.
- [ ] Implementar las cinco políticas de §2, cada una con su test.
- [ ] **Test de determinismo**: aplicar el mismo conjunto de escrituras en órdenes distintos
      (y por duplicado) tiene que dar el **mismo** estado, byte a byte.
- [ ] Quitar el `ts` de toda decisión de mezcla. Que quede solo para ordenar la vista.

### B2 — Lápidas

- [ ] `removeMessage` / `removeThread` escriben lápida en vez de borrar y ya.
- [ ] La mezcla honra las lápidas y **no resucita** (test explícito: borrar en A, mezclar con
      B que todavía lo tenía, y comprobar que sigue borrado).
- [ ] Poda a los 12 meses.

### B3 — Contadores

- [ ] `recordOpen` (`:260`) pasa a casilla por miembro; `getOpens` devuelve la **suma**.
- [ ] `opens` entra en `mergeForSync` (hoy solo van `threads`), ya con la política correcta.

### B4 — Variantes

- [ ] Guardar el perdedor de un empate de `registro` y exponerlo (`listVariants({ id })`).
- [ ] Resolver eligiendo una (gesto del usuario, que escribe un `registro` nuevo).

### B5 — Cuota

- [ ] `dropOldest` deja de correr solo; error claro + evento.

### B6 — Encaje con el cifrado

- [ ] Cuando el store use `sealContent`, el sobre queda **fuera** del cifrado y el `body`
      dentro. Test de que el vault puede mezclar sin poder leer.

---

## 7. Lo que esto NO resuelve

- **No es un CRDT general.** Es un catálogo corto de políticas que cubren lo que el ecosistema
  guarda. Si algún día hace falta edición colaborativa de texto en vivo, eso es otro problema
  y otra pieza.
- **No arregla el reloj de nadie.** El `ts` sigue pudiendo estar mal; simplemente deja de
  importar para decidir.
- **No sustituye al acta.** Quién puede escribir lo sigue diciendo el acta; esto solo dice qué
  pasa con lo escrito.
