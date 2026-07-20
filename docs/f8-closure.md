# Cierre F8 — API e integración verificable

**Fecha:** 2026-07-20  
**Estado:** COMPLETA  
**Alcance:** cierre operativo de `carrito-content-api`; sin cambios en
`carrito-front`, despliegues ni activación del Libro de Reclamaciones.

## Estado heredado F0–F7

| Fase | Estado al iniciar F8   | Evidencia                                                                    |
| ---- | ---------------------- | ---------------------------------------------------------------------------- |
| F0   | Cerrada                | Fastify, TypeScript estricto, MongoDB, configuración, errores, logging y CI. |
| F1   | Cerrada                | Importación idempotente, preflight, sanitización y verificación.             |
| F2   | Cerrada                | Golden canónico, copia contractual y test exacto del export.                 |
| F3   | Cerrada                | Lectura pública, export protegido, ETag, CORS y rate limit.                  |
| F4   | Cerrada                | Ciclo editorial por CLI y transacciones obligatorias.                        |
| F5   | Cerrada                | Contacto público, idempotencia, privacidad y base separada.                  |
| F6   | Implementada tras gate | Reclamos implementados y bloqueados por defecto hasta P1–P18.                |
| F7   | Cerrada                | Configuración fail-fast, health, shutdown, índices y runbook inicial.        |

## Entregables F8

- Aliases npm aditivos para estado, edición, publicación, export y gate golden.
- Gate F2 visible como paso separado de CI, sin duplicar archivos de prueba.
- Runbook ejecutable para instalación, configuración, DDL, migración,
  publicación, export, health y rollback no destructivo.
- Contrato HTTP de rutas públicas, protegidas y operativas, con errores.
- Contrato de build con `carrito-front`, manejo seguro de `X-Export-Key` y
  límites del consumidor actual.
- Inventario de backlog del front, sin modificar su repositorio.
- Verificación técnica completa y humo contra MongoDB efímero.

## Restricciones preservadas

- Sin commits, push, ramas, tags ni cambios de historial.
- Sin dependencias nuevas.
- Sin cambios en `content-cache.json` ni en su copia contractual.
- Sin cambios de flags o valores legales de reclamos.
- `FEATURE_COMPLAINTS_ENABLED=false` y
  `COMPLAINTS_LEGAL_GATE_CLEARED=false` permanecen como defaults.
- Sin IP/User-Agent persistidos.
- Sin tocar `carrito-front` ni su artefacto generado.
- Sin conexión de pruebas manuales a la instancia local de MongoDB del usuario.

## Backlog de carrito-front

Estos hallazgos se documentan solamente. Su corrección requiere autorización
expresa y una fase propia en `carrito-front`.

| ID          | Severidad                                                 | Hallazgo                                                                                                                                                 | Riesgo / criterio de salida                                                                                                                                                                     |
| ----------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FRONT-F8-01 | **ALTA — bloqueante de preproducción**                    | Contacto y reclamos ejecutan `console.log` con el payload/formulario, que contiene datos personales.                                                     | Exposición en consola, soporte remoto o telemetría del navegador. Eliminar esos logs y verificar que errores/constancias tampoco registren datos personales antes de conectar la API.           |
| FRONT-F8-02 | **MEDIA — bloqueante de integración de contacto**         | La página de contacto no genera ni envía `submissionId`.                                                                                                 | El contrato exige UUID v4 para idempotencia; sin él cada envío será inválido. Generarlo y conservarlo durante reintentos del mismo envío.                                                       |
| FRONT-F8-03 | **MEDIA — incompatibilidad de tipos**                     | `LegalSectionData.page` está marcado obligatorio, pero el item `legal-sections/terminos-venta` del golden no contiene `page`.                            | El tipo promete un campo ausente en datos válidos. Hacerlo opcional o modelar las variantes sin cambiar el golden.                                                                              |
| FRONT-F8-04 | **ALTA — riesgo de fuga de credencial**                   | El plugin `$api` puede adjuntar el bearer del sistema de ventas. Reutilizarlo para esta API podría enviar ese token a un servicio que no debe recibirlo. | Crear un cliente dedicado sin bearer de ventas. El export debe seguir siendo servidor-a-servidor y usar solo `X-Export-Key` en build seguro.                                                    |
| FRONT-F8-05 | **ALTA — RIESGO DE RELEASE, bloqueante de preproducción** | El build del front no falla cuando falta `app/data/generated/content-cache.json`; `useContent` continúa con contenido vacío/fallback.                    | Puede publicarse una release funcionalmente vacía. El pipeline debe exigir existencia, JSON válido, secciones requeridas y build con cache antes de publicar. No tratar como advertencia menor. |

Además, `sync-content.mjs` sigue leyendo SQL Server y los formularios no llaman
a esta API. Es integración pendiente, no un defecto que F8 pueda corregir sin
modificar el front.

## Evidencia de compatibilidad observada

Sobre el checkout local de `carrito-front` en `docs/forms-backend-plan`:

- el tipo `ContentCache` contiene las nueve secciones del export;
- el cache generado presente tenía conteos `1/16/13/62/33/17/83/225`;
- el contenido editorial coincidía con el golden al excluir timestamp y tokens
  técnicos;
- el archivo completo difería en `generatedAtUtc` y tokens SQL, por lo que no
  se presentó como igualdad exacta;
- no se escribió ningún archivo del front.

La garantía exacta corresponde al flujo de esta API: importar el golden y
exportarlo mediante el mismo builder, cubierto por `test:golden`.

## Evidencia de golden

Hash SHA-256 inicial de ambos archivos:

```text
2D37E66835CE49A1F7B918CB877501BB4A2FBB278F255BA4AC9117D04C166BF4
```

| Archivo                                   | Hash final                                                         | Estado  |
| ----------------------------------------- | ------------------------------------------------------------------ | ------- |
| `content-cache.json`                      | `2D37E66835CE49A1F7B918CB877501BB4A2FBB278F255BA4AC9117D04C166BF4` | Intacto |
| `test/contract/golden/content-cache.json` | `2D37E66835CE49A1F7B918CB877501BB4A2FBB278F255BA4AC9117D04C166BF4` | Intacto |

## Resultados de verificación

| Verificación            | Resultado                                                          |
| ----------------------- | ------------------------------------------------------------------ |
| `npm run typecheck`     | PASS — TypeScript terminó con código 0.                            |
| `npm run lint`          | PASS — ESLint terminó con código 0.                                |
| `npm run format`        | PASS — todos los archivos comprobados usan formato Prettier.       |
| `npm run test:golden`   | PASS — 1 archivo, 10 tests.                                        |
| `npm test`              | PASS — 17 archivos, 163 tests.                                     |
| `npm run build`         | PASS — `tsc -p tsconfig.build.json`, código 0.                     |
| Humo MongoDB efímero    | PASS — replica set efímero; no usó MongoDB local.                  |
| Revisión final del diff | PASS — `git diff --check` sin errores; solo archivos F8 esperados. |

El humo ejecutado levantó `MongoMemoryReplSet` y cubrió:

- `migrate:cache --dry-run`, importación y `verifyCache`;
- `content:status`, creación draft, publicación y archivado mediante los CLIs;
- export igual al golden salvo `generatedAtUtc` después de archivar el registro
  efímero;
- `/health/live` y `/health/ready` con `200`;
- locales, bundle y colección publicada con `200`;
- contacto sintético con `201` y DTO sin campos personales;
- reclamos bloqueados: JSON `503 COMPLAINTS_DISABLED` y multipart `415`.

El proceso no leyó el `.env` local, no usó `127.0.0.1:27017` y eliminó su
directorio temporal al finalizar.

## Decisiones pendientes antes de producción

- Resolver los cinco bloqueos del front anteriores en una fase autorizada.
- Confirmar la rama/release real de `carrito-front` contra la que se integrará.
- Provisionar usuarios Mongo mínimos y distintos para contenido/formularios.
- Configurar CORS, reverse proxy, servicio y secretos en el entorno real.
- Mantener reclamos fuera de servicio hasta cerrar P1–P18, incluyendo correo,
  retención, acceso a firma/adjuntos y textos legales.
- Ejecutar un despliegue y rollback ensayados; F8 solo documenta el
  procedimiento y no toca producción.
