# ADR-001: Consistencia de escrituras editoriales en MongoDB

**Estado:** aceptado  
**Fecha:** 2026-07-17  
**Actualizado:** 2026-07-17 (reconciliación `editorialDirty`)  
**Fases:** F3–F4

## Contexto

Las mutaciones editoriales (CLIs `scripts/content/`) deben:

1. Invalidar cachés en memoria y ETags vía `meta.contentVersion`.
2. Asignar `tokenSeq` monótono por cambio (`revision` → `rowVersionToken`).
3. Respetar integridad referencial y reglas de publicación.

MongoDB en este proyecto puede desplegarse como **standalone** (plan F7). Las
transacciones multi-documento requieren replica set.

Hallazgos de auditoría (A2–A4): lotes parcialmente escritos, desincronización
entre contenido y `contentVersion`, publicación sin validar padres.

## Decisión

### Persistencia única (`content.repo.ts`)

Toda lectura/escritura de `carrito_content` pasa por `ContentRepo`. La lógica
de dominio vive en `content-write.ts` y `content-read.ts` (sin capa `*service*`).

### Preflight todo-o-nada (A2, A4)

Antes de la primera escritura de un lote, `setRecords` / `setStatus`:

- Valida esquema TypeBox de todos los registros.
- Carga referencias en bloque (locales, colecciones, assets).
- Comprueba existencia mínima (draft o published).
- Si el estado destino es `published`, exige padres `published` y locale
  `published` + `isActive`; assets referenciados deben existir.

Un fallo de preflight aborta sin tocar MongoDB.

### `contentVersion` acoplado a la escritura (A3)

`ContentRepo.withEditorialWrite`:

1. **Preferido:** transacción multi-documento (contenido + `meta.contentVersion`
   en el mismo commit) cuando el deployment es replica set.
2. **Fallback (standalone):**
   1. Marca `meta.editorialDirty = true`.
   2. Aplica las escrituras del lote.
   3. `$inc contentVersion` y `editorialDirty = false` en la misma actualización
      de meta.

### Reconciliación verificable (riesgo residual cerrado)

Si el proceso cae entre (2) y (3), `editorialDirty` permanece `true`.

Toda lectura de versión (`getContentVersion`, usada por export y bundles)
detecta el flag y ejecuta un compare-and-swap:

- filtro `{ editorialDirty: true }`
- `$inc: { contentVersion: 1 }, $set: { editorialDirty: false }`

Efecto: la siguiente petición invalidará ETag/caché en memoria y reconstruirá
desde Mongo (que ya tiene el contenido escrito). Un bump “de más” tras dirty
sin escrituras es inocuo (solo adelanta la versión).

### Importación

`importCache` usa el mismo repositorio pero no participa del ciclo editorial
runtime; es migración idempotente con meta inicial (`editorialDirty: false`).

## Consecuencias

- Replica set en producción: consistencia fuerte por transacción.
- Standalone: soportado con dirty-flag + reconciliación en lectura; no hace
  falta intervención manual tras un crash a mitad de escritura.
- Nuevas escrituras editoriales deben usar `withEditorialWrite`.

## Alternativas descartadas

- **Bump de versión antes de escribir:** invalida cachés con datos incompletos.
- **Versión por documento:** rompe el contrato actual de ETag global.
- **Prometer atomicidad de lote sin transacción ni preflight:** incumple
  AGENTS.md y la auditoría F4.
- **Solo mitigación operativa manual:** insuficiente frente al hallazgo A3.
