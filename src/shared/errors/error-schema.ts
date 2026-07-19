import { Type } from '@sinclair/typebox';

/** Envolvente pública única para cualquier respuesta de error. */
export const errorEnvelopeSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String(),
        message: Type.String(),
        requestId: Type.String(),
        details: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
