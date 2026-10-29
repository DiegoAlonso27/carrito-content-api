# ADR-014: Firma manuscrita opcional en el alta de reclamo

**Estado:** aceptado
**Fecha:** 2026-09-08
**Fases:** endurecimiento post-F6 (contrato compartido con `carrito-front`)

## Contexto

El alta de reclamo (`POST /v1/complaints`) exigía la parte multipart
`consumerSignaturePng`: sin ella el parser devolvía
`400 VALIDATION_ERROR` con `consumerSignaturePng: ['la firma del consumidor es
obligatoria']` (ADR-007 de `carrito-content-api`, §5.8 del contrato heredado).

El rediseño del Libro de Reclamaciones en `carrito-front` retiró el canvas de
firma de la UI pública: el trazo dibujado con el dedo o el ratón no aporta
prueba de autoría y era el control con peor tasa de finalización de la hoja.
Sin canvas no hay PNG que enviar, así que el endpoint quedaba inalcanzable
desde la única UI que lo consume.

Las dos salidas descartadas:

- **Enviar un PNG en blanco generado por el cliente.** `validateSignaturePng`
  rechaza el canvas vacío a propósito (umbral de tinta), así que habría que
  dibujar algo sintético: un registro que afirma un trazo que nadie hizo. Se
  descarta por falsedad del registro, no por dificultad técnica.
- **Dejar el endpoint como estaba y posponer el retiro del canvas.** Traslada
  el problema a la UI sin resolverlo.

## Decisión

**La parte `consumerSignaturePng` pasa a ser opcional.** Lo que dejó de ser un
error es su *ausencia*; cuando viene, sigue sujeta exactamente a las mismas
validaciones (cota de tamaño en el parseo, firma mágica, decodificación con
`pngjs`, dimensiones y trazo no vacío).

El bloque `signature` del documento persistido **no desaparece**: se convierte
en el *sello de la hoja*, con dos métodos.

| Campo | Con trazo | Sin trazo |
|---|---|---|
| `method` | `TRAZO_MANUSCRITO` | `CONFIRMACION_ELECTRONICA` |
| `contentType` | `image/png` | `null` |
| `sizeBytes` | bytes del PNG | `null` |
| `content` | PNG (nunca en DTO/logs/correo) | `null` |
| `contentHash` | SHA-256 del PNG | `null` |
| `signedDocumentHash` | SHA-256 de la hoja canónica | **igual** |
| `documentVersion` | `'1'` | **igual** |
| `signedAtUtc` | instante del alta | **igual** |

Tres consecuencias del diseño que hacen que esto no debilite nada:

1. **La hoja canónica nunca incluyó los bytes de la firma** (`buildCanonicalSheet`
   sella proveedor, consumidor, apoderado, servicio, detalle, confirmación y la
   lista de adjuntos). El sello de integridad `signedDocumentHash` y
   `DOCUMENT_VERSION = '1'` se calculan igual con trazo y sin él: no hay cambio
   de versión del documento canónico ni migración de registros.
2. **La aceptación sigue registrada.** `confirmation` guarda `confirmed: true`,
   la versión del texto aceptado (`COMPLAINTS_CONFIRMATION_TEXT_VERSION`) y el
   instante. Eso es lo que `CONFIRMACION_ELECTRONICA` nombra.
3. **La idempotencia sigue distinguiendo contenidos.** `matchesExistingSubmission`
   compara `contentHash` incluyendo el caso `null === null`: reenviar el mismo
   `submissionId` *con* firma después de uno *sin* firma (o al revés) sigue
   siendo `409 IDEMPOTENCY_CONFLICT`, no un reintento válido.

Cambios en el contrato HTTP publicado (OpenAPI):

- `consumerSignaturePng` deja de ser propiedad requerida del multipart.
- `signature.method` pasa de `Type.Literal('TRAZO_MANUSCRITO')` a la unión de
  los dos literales.
- `signature.contentHash` pasa de `string` a `string | null`.

`COMPLAINTS_SIGNATURE_MAX_BYTES` se conserva: sigue acotando la firma cuando se
envía. El gate legal `FEATURE_COMPLAINTS_ENABLED` /
`COMPLAINTS_LEGAL_GATE_CLEARED` de ADR-007 de `carrito-content-api` **no se
toca**; esta decisión no habilita nada.

## Consecuencias

- **Rompe a un consumidor que leyera `signature.contentHash` como `string`.** El
  único consumidor conocido es `carrito-front`, que solo lee `code` de la
  constancia; se declara igualmente porque el response schema es contrato
  publicado.
- **P16 (suficiencia legal de la firma) sigue abierto** y ahora es más visible:
  el registro ya no afirma un trazo manuscrito cuando no lo hubo. Si legal
  exige trazo para cerrar el gate, la vuelta atrás es reponer el `throw` del
  parser y volver a `Type.Literal` en el schema — sin migración de datos,
  porque los registros previos conservan su método y su hash.
- **P18 (política del binario de firma) queda con menos superficie**: los altas
  sin trazo no guardan binario, así que la proyección `signature.content: 0` y
  el aislamiento de la cuenta Mongo aplican sobre menos registros.
- El correo de constancia dice ahora «Aceptación del consumidor: `<método>`,
  hash …» en vez de afirmar siempre «Firma … registrada».

## Cambio cruzado con `carrito-front`

Esta decisión cruza la frontera front ↔ content-api y está documentada en
**ambos** repositorios. Del lado de `carrito-front`:
`docs/decisions/0030-libro-de-reclamaciones-wizard-sin-firma.md` (retiro del
canvas, `signaturePng` opcional en `submitComplaint` y salida de `hasSignature`
de `validateComplaintForm`).

## Verificación

`test/integration/complaints.test.ts`, describe «firma manuscrita opcional
(ADR-014)»: 201 sin la parte de firma con `method: CONFIRMACION_ELECTRONICA`,
`contentHash: null` y binario `null` en Mongo; reintento sin firma → 200;
mismo `submissionId` que llega después con firma → 409. Los casos previos de
PNG inválido y canvas vacío siguen en verde.
