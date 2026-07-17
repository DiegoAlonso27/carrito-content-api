# ADR-007: Libro de Reclamaciones (F6) implementado tras gate de fase

**Estado:** aceptado — F6 implementado, deshabilitado por gate legal
**Fecha:** 2026-07-17
**Fases:** F6

## Contexto

El Libro de Reclamaciones (Perú) es parte del alcance del proyecto (AGENTS.md).
Su contrato funcional se hereda de
`formularios-backend-csharp.md` (§4 POST /api/reclamos, §5 persistencia), un
plan para BFF C# + SQL Server que aquí se adapta a Fastify + TypeScript +
MongoDB. Ese contrato deja **18 decisiones legales/operativas abiertas**
(P1–P18, §10): suficiencia legal de la firma (P16), política de la imagen de
firma (P18), política de adjuntos (P14), infraestructura de correo (P2), plazo
de respuesta y texto de confirmación (P1), formato del código (P10), etc.

AGENTS.md fija que el endpoint permanece tras `FEATURE_COMPLAINTS_ENABLED=false`
hasta cerrar el gate legal, y que su activación es un cambio de configuración
aprobado por el usuario, nunca un despliegue.

## Decisión

1. **Se implementa el módulo completo** (`src/modules/complaints/`) — hoja del
   Anexo I, firma manuscrita (PNG del trazo, validada con `pngjs`: firma
   mágica + decodificación + trazo no vacío), adjuntos del consumidor
   (multipart, allowlist por firma mágica), hash canónico de la hoja
   (`SignedDocumentHash`) y del PNG (`SignatureContentHash`), idempotencia por
   `submissionId`, honeypot, rate limit, código no predecible y correo de
   constancia — pero **detrás del gate de fase**.

2. **`FEATURE_COMPLAINTS_ENABLED` default `false`.** Con el flag en `false` el
   plugin registra únicamente un responder **503 `COMPLAINTS_DISABLED`** que no
   toca Mongo, el repo ni el parser multipart. El flag NO se cambia a `true` en
   este trabajo: exige cerrar P1–P18 y autorización explícita del usuario.
   Además, habilitar el Libro exige el **acuse explícito
   `COMPLAINTS_LEGAL_GATE_CLEARED=true`** (el flag de fase por sí solo no basta):
   sin él, activar el Libro detiene el arranque. En producción se exige también
   la infraestructura de correo de constancia (P2) y credenciales propias de
   `carrito_forms`.

3. **Ningún valor legal se asume en código.** Proveedor (P8), plazo (P1), texto
   de confirmación (P1/P16), tamaño de firma (P18) y política de adjuntos (P14)
   son configuración por env, obligatoria **solo** cuando el flag está activo.
   `loadConfig` falla al arrancar si el flag es `true` y falta cualquiera —
   segunda barrera contra la activación accidental.

4. **Código de reclamo seguro y no predecible.** Se descarta el correlativo
   secuencial del plan C# (`SEQUENCE`, P10) por adivinable; se genera
   `LR-<año>-<12 símbolos Crockford Base32>` con CSPRNG (`crypto`). El formato
   legal final se confirma en el MR 1; la no-predictibilidad es innegociable.

5. **Atomicidad vía documento único.** MongoDB standalone no tiene
   transacciones multi-documento, así que el reclamo se persiste como **un
   solo documento** (hoja + firma + adjuntos + dispatch): `insertOne` es la
   unidad «todo o nada» del plan (§5.8). Implica que el total de adjuntos debe
   quedar bajo el límite de 16 MB de BSON — los límites por defecto son
   conservadores y se validan antes de insertar.

6. **Correo sin colas (límite duro AGENTS.md).** No hay worker de reintentos ni
   hosted-service: el envío es best-effort **inline** tras persistir, con
   `nodemailer` (autorizado). SMTP vacío ⇒ transporte no-op y dispatch
   `pendiente`. Un fallo de correo nunca revierte el reclamo (§5.6).

7. **Fuera de alcance (§14 del plan):** descargos, firma del proveedor y
   transiciones de estado del «servicio encargado futuro» — requieren
   autenticación/autorización inexistentes en fase 1. El alta pública solo crea
   `PENDIENTE`.

## Dependencias nuevas (autorizadas por el usuario)

- `@fastify/multipart` — recepción de `files[]` + `consumerSignaturePng`.
- `pngjs` — validación/decodificación del PNG de firma (equivalente Node de la
  lib aprobada en P5; detecta canvas vacío, que la firma mágica sola no puede).
- `nodemailer` (+ `@types/*`) — correo de constancia (P2).

## Endurecimiento tras revisión de código

- **IP fuera de logs.** El serializador `req` por defecto de Fastify incluye
  `remoteAddress`/`remotePort`; se reemplazó por uno que solo emite
  id/método/ruta (`src/shared/logging/logger.ts`). Aplica a toda la API (F5
  incluido). Regla dura AGENTS.md: logs sin datos personales, sin IP.
- **Binarios no se leen en runtime.** Las lecturas del repo proyectan sin
  `signature.content` ni `attachments.content`: la cuenta de ejecución nunca
  carga el PNG de firma ni los adjuntos en una lectura. El aislamiento fuerte
  (que la cuenta Mongo no pueda leerlos) es privilegio de BD y se define al
  cerrar P18.
- **El correo nunca invalida el alta.** El envío inline y la actualización del
  dispatch están aislados: `dispatchReceipt` no lanza; un fallo de SMTP o de
  persistencia del estado deja el reclamo válido y responde 201, nunca 500.
- **Honeypot en ambos sitios.** Se detecta `website` tanto en el JSON `payload`
  (contrato heredado) como en la parte multipart.
- **Schemas de error.** La ruta declara schema de respuesta para 400/413/429/
  500/503, no solo para el éxito: la barrera anti-fuga de Fastify cubre todas
  las salidas.

## Consecuencias

- El endpoint no acepta reclamos hasta cerrar P1–P18 y activar el flag: hoy
  responde 503. Recibir reclamos sin capacidad de atenderlos sería un
  incumplimiento en sí mismo.
- El artefacto de firma (PNG del trazo) es dato personal altamente sensible:
  se persiste como binario, nunca sale por DTO, logs ni correo (solo
  metadatos/hashes). Cifrado en reposo, retención y acceso al binario quedan
  pendientes del MR 1 (P18).
- La colección `complaints` se aprovisiona con `scripts/forms/setup-complaints.ts`
  (cuenta de migración); el runtime nunca ejecuta DDL.
- Riesgos legales pendientes registrados: P1, P2, P8, P10, P14, P16, P17, P18.
