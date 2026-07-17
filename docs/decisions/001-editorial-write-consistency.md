# ADR-001: Consistencia de escrituras editoriales en MongoDB

**Estado:** aceptado  
**Fecha:** 2026-07-17  
**Actualizado:** 2026-07-17 (replica set obligatorio para mutaciones)  
**Fases:** F3–F4

## Contexto

Las mutaciones editoriales deben invalidar cachés vía `contentVersion`, asignar
`tokenSeq` monótono y respetar integridad referencial. MongoDB standalone no
soporta transacciones multi-documento; un fallback con `editorialDirty` sufría
carreras con lecturas concurrentes.

## Decisión

### Persistencia única (`content.repo.ts`)

Toda lectura, escritura y DDL de `carrito_content` pasa por `ContentRepo`.
`content.collections.ts` solo expone nombres, validadores e índices (datos
puros).

### Preflight todo-o-nada

Antes de escribir: esquema TypeBox, claves naturales **únicas en el lote**,
referencias e invariantes de publicación. Sin escritura si el preflight falla.

### Transacciones obligatorias para mutaciones

`withEditorialWrite` **solo** usa transacción multi-documento (contenido +
`contentVersion` en el mismo commit).

Si el deployment no soporta transacciones → `ContentTopologyError` (no hay
fallback standalone). Operativamente: MongoDB debe ser **replica set** (puede
ser de un nodo) para CLIs editoriales y cualquier mutación.

La importación inicial (`importCache`) no usa este camino: es migración
idempotente con `--verify` por defecto.

### Lectura

`getContentVersion` lee el contador; no reconcilia flags de escritura (ya no
existen). Cachés/ETag dependen de commits transaccionales exitosos.

## Consecuencias

- Desarrollo/CI de escritura: `MongoMemoryReplSet` (1 nodo).
- Producción/local con mutaciones: iniciar mongod como replica set.
- Lectura/export sobre datos ya importados puede usar standalone.

## Alternativas descartadas

- **Dirty-flag + reconciliación en lectura:** carrera con escrituras activas.
- **Bump antes de escribir:** invalida cachés con datos incompletos.
- **Prometer atomicidad de lote en standalone:** incumplible sin transacciones.
