# ADR-005: Modelo de publicación editorial

**Estado:** aceptado  
**Fecha:** 2026-07-17  
**Fases:** F3–F4

## Contexto

El contenido tiene dos ejes ortogonales:

- `status`: ciclo editorial (`draft` | `published` | `archived`).
- `isActive`: bandera del contrato que el front filtra en runtime.

El export y los bundles públicos solo incluyen `status: published`. Había riesgo
de publicar items con padres inválidos (colección archivada, locale inactivo,
asset inexistente).

## Decisión

### Visibilidad

| Superficie | Filtro |
|------------|--------|
| Export `/v1/export/content-cache` | `status === published` (incluye `isActive: false`) |
| Bundle runtime `/v1/content/:locale` | `published`; locales atendibles: `published` + `isActive` |
| CLI / importación inicial | registros del golden nacen `published` |

### Fallback de locale

Si el locale pedido no es el default, el bundle une documentos del locale
pedido con los del default cuya clave natural no exista en el pedido.
`localeCode` conserva el origen real.

### Invariantes al publicar (`setRecords` con `publish` / `setStatus('published')`)

1. Locales referenciados: existen, `published` y `isActive`.
2. Colecciones referenciadas por items: existen y `published`.
3. Assets referenciados (`ogImageSlug`, `imageAsset`, `iconAsset`): existen
   (cualquier status editorial del asset basta para la referencia; el export
   solo lo mostrará si el asset está `published`).

### Draft / archived

- Nuevo registro: `draft` salvo publicación explícita.
- `archived` saca del export y del bundle; no borra el documento.
- Preflight de lotes valida existencia siempre; invariantes de publicación
  solo si el destino es `published` (ADR-001).

## Consecuencias

- No se promete cascade al archivar un padre: re-publicar hijos fallará el
  preflight hasta corregir el padre.
- Importación del golden no aplica estas invariantes de “acto de publicar”
  (todo nace published desde un archivo ya coherente; `validateCacheSemantics`
  cubre relaciones del archivo).
