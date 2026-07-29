# Registros de decisiones de arquitectura (ADR)

Cada decisión de arquitectura significativa se registra en un archivo
`0NN-titulo-corto.md`. Solo se registran decisiones **confirmadas** (por el
código o por el equipo); las propuestas se discuten primero y se registran
cuando se aceptan.

Encabezado de cada archivo (formato vigente en este repositorio):

```
# ADR-0NN: Título corto

**Estado:** aceptado
**Fecha:** AAAA-MM-DD
**Fases:** F1 | F2 | … | Track B / Fase N
```

seguido de **Contexto**, **Decisión** y **Consecuencias**.

## Índice

| ADR | Título | Estado | Fecha | Fases |
|---|---|---|---|---|
| [001](001-editorial-write-consistency.md) | Consistencia de escrituras editoriales en MongoDB | aceptado | 2026-07-17 | F3–F4 |
| [002](002-export-protection.md) | Protección y serialización del export `/v1/export/content-cache` | aceptado | 2026-07-17 | F2–F3 |
| [003](003-forms-credentials-production.md) | Separación de credenciales de formularios en producción | aceptado | 2026-07-17 | F1 / F5 |
| [004](004-content-cache-golden-source.md) | Fuente única del contrato `content-cache.json` | aceptado | 2026-07-17 | F2 |
| [005](005-publication-model.md) | Modelo de publicación editorial | aceptado | 2026-07-17 | F3–F4 |
| [006](006-isolate-contact-f5.md) | Formulario de contacto (F5) y kill-switch operativo | aceptado — F5 cerrado | 2026-07-17 | F5 |
| [007](007-complaints-feature-gate.md) | Libro de Reclamaciones (F6) implementado tras gate de fase | aceptado — F6 implementado, deshabilitado por gate legal | 2026-07-17 | F6 |
| [008](008-f7-index-reconciliation.md) | Índices alineados con consultas y reconciliación no destructiva | aceptado | 2026-07-19 | F7 |
| [009](009-openapi-docs.md) | Documentación OpenAPI 3.1 con Swagger UI | aceptado (actualizado 2026-07-29: nueve rutas y exclusión del editor interno) | 2026-07-20 | posterior a F8 |
| [010](010-phone-country-contract.md) | Teléfono con país en campo aparte (contacto y Libro) | aceptado — en implementación | 2026-07-25 | endurecimiento post-F5/F6 (paridad de validaciones front/API) |
| [011](011-modelo-editorial-bloques.md) | Modelo editorial por bloques (Track B) | aceptado | 2026-07-26 | Track B / Fase 2 (`editorial-api-model`) |
| [012](012-export-editorial-v2.md) | Export editorial v2 (snapshot versionado) | aceptado | 2026-07-26 | Track B / Fase 3 (`editorial-export-v2`) |
| [013](013-editor-editorial-interno.md) | Editor editorial interno opt-in tras allowlist de IP | aceptado | 2026-07-29 | posterior a Track B — endurecimiento operativo |

Ningún ADR de este repositorio ha sido reemplazado ni declarado obsoleto: la
cadena es acumulativa. Las relaciones que sí existen entre ellos:

- **[013](013-editor-editorial-interno.md) → [009](009-openapi-docs.md)**: el
  editor interno se excluye a propósito del spec OpenAPI, así que con el editor
  encendido el spec deja de ser el inventario completo de la superficie HTTP.
- **[012](012-export-editorial-v2.md) → [009](009-openapi-docs.md)**: el export
  editorial añadió la novena ruta documentada.
- **[013](013-editor-editorial-interno.md) → [004](004-content-cache-golden-source.md)**:
  publicar desde el editor desincroniza el golden hasta que se reexporte y se
  commitee.
- **[013](013-editor-editorial-interno.md)** reutiliza el modelo de publicación
  de [005](005-publication-model.md) y hereda la exigencia de replica set de
  [001](001-editorial-write-consistency.md).
- **[006](006-isolate-contact-f5.md)** y **[007](007-complaints-feature-gate.md)**
  se apoyan en la separación de credenciales de
  [003](003-forms-credentials-production.md);
  **[010](010-phone-country-contract.md)** endurece el contrato de ambos.

Convenciones: numeración incremental de **3 dígitos**; una decisión por archivo;
si una decisión cambia se crea un ADR nuevo que reemplaza al anterior (no se
edita la historia) y las correcciones puntuales se añaden como notas de
actualización **fechadas**, conservando el cuerpo original.

## Citación cruzada con `carrito-front`

El otro repositorio del monorepo, **carrito-front**, mantiene su propio índice
en `docs/decisions/README.md` con numeración de **4 dígitos** (`0001`–`0012`) y
una plantilla propia (`docs/decisions/template.md`).

**Los números colisionan.** `ADR-004` de este repositorio (fuente única del
golden `content-cache.json`) no tiene nada que ver con `ADR-0004` de
`carrito-front` (separación de configuración por runtime); `ADR-010` de aquí
(teléfono con país) no es `ADR-0010` de allá (content-cache versionado). La
diferencia de dígitos no basta como desambiguación: se escriben y se leen
demasiado parecido.

**Regla: cítese siempre con el nombre del repositorio.** «ADR-004 de
`carrito-content-api`», «ADR-0010 de `carrito-front`». Nunca solo por el
número, ni siquiera dentro del propio repositorio cuando la frase menciona al
otro. Los enlaces relativos solo se usan **dentro** de un mismo repositorio:
una referencia cruzada se escribe por nombre, sin enlace, porque los dos repos
se clonan por separado.
