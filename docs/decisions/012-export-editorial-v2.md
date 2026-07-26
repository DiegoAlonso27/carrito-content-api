# ADR-012: Export editorial v2 (snapshot versionado)

**Estado:** aceptado
**Fecha:** 2026-07-26
**Fases:** Track B / Fase 3 (`editorial-export-v2`)

## Contexto

El doc 08 pide un export completo versionado con `version`, `generatedAtUtc`,
manifest por documento, checksum SHA-256, ETag, retención y rollback.

La restricción dura es que `GET /v1/export/content-cache` es el contrato que
`carrito-front` consume **en build** y que su golden es el gate central del
proyecto. No puede cambiar hasta el cutover.

## Decisión

### Endpoint nuevo, en paralelo

`GET /v1/export/editorial/:locale`, misma autenticación servidor-a-servidor
(`X-Export-Key`). El endpoint vigente no cambia de forma, de orden de claves ni
de ETag. Un test de integración lo comprueba: tras publicar snapshots
editoriales, `/v1/export/content-cache` sigue siendo byte-idéntico al golden y
conserva su ETag.

### El snapshot se almacena, no se construye al vuelo

Publicar es una operación explícita (`editorial:snapshot --publish`) que
construye, valida, firma y **guarda** el artefacto en `editorial_snapshots`. El
endpoint sirve el snapshot activo.

Esa inversión es el centro de la decisión y de ella salen las cuatro
propiedades pedidas:

| Propiedad  | Cómo se obtiene                                              |
| ---------- | ------------------------------------------------------------ |
| Versionado | `v1`, `v2`… monotónico por locale                            |
| ETag       | la versión activa; solo cambia al publicar o revertir        |
| Retención  | los snapshots anteriores siguen almacenados                  |
| Rollback   | activar otra versión ya validada; no se reconstruye nada     |

Si el endpoint construyera al vuelo, el artefacto servido no sería el mismo que
pasó el gate: bastaría una edición en la base para cambiar lo que ve el front
sin que nadie publicara nada.

### Hashes y verificación

- Cada documento del manifest lleva `hash` (SHA-256 del documento en JSON
  canónico con claves ordenadas), `size`, `state` y `refs`.
- El snapshot lleva un `checksum` global sobre todo el cuerpo salvo el propio
  campo.
- `verifySnapshotIntegrity` recalcula ambos. Se ejecuta al publicar (sobre lo
  recién construido), al revertir (sobre lo almacenado) y al cargar el snapshot
  en memoria para servirlo.

Publicar se rechaza ante: hash inconsistente, referencia faltante, identidad
duplicada (`id` o URL canónica repetida) y schema incompatible. Servir se
rechaza si el snapshot activo no supera la verificación: un documento
manipulado directamente en MongoDB no llega al front.

### Qué entra al snapshot

Solo documentos `published`. Dentro de cada destino:

- se excluyen bloques deshabilitados, en `draft` o `archived`;
- se filtran los medios cuyo asset no esté publicado o cuyos derechos estén sin
  verificar, arrastrando su gemelo de texto para no desalinear la galería;
- las listas de referencias se filtran a lo publicado y, si quedan vacías, el
  bloque se omite;
- una galería que queda vacía **sí** se exporta: el front tiene estado vacío y
  ocultarla escondería que faltan derechos.

El contenido se resuelve por locale con fallback al default, marcado con
`isFallback` para que la interfaz no afirme que hay traducción (doc 07).

### Retención

Se conservan las últimas 5 versiones por locale. La activa y la inmediatamente
anterior nunca se descartan, aunque el límite fuera menor. La poda se reporta en
la salida del CLI: nada desaparece en silencio.

### Auditoría

Publicar y revertir exigen `--operator` y `--reason`, que se almacenan con el
snapshot (doc 08: el rollback registra operador y motivo).

## Consecuencias

- Convivencia de dos exports hasta el cutover, con costes distintos: el flat se
  reconstruye por `contentVersion`; el editorial solo cambia al publicar.
- El almacenamiento crece con cada versión (≈ cientos de KB con 32 destinos);
  la retención lo acota.
- Publicar exige replica set, igual que el resto de mutaciones (ADR-001).
