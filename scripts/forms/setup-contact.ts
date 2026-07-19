/**
 * Aprovisiona la colección `contact_messages` en `carrito_forms`:
 * validador $jsonSchema e índice único de idempotencia (`submissionId`).
 * Idempotente: correrlo varias veces no duplica nada.
 *
 * Uso:
 *   npx tsx scripts/forms/setup-contact.ts
 *
 * Pensado para ejecutarse con una cuenta de migración (con permisos DDL),
 * DISTINTA de la cuenta de ejecución del servidor API, que solo necesita
 * INSERT/SELECT sobre `contact_messages` (mismo patrón de dos cuentas del
 * contrato heredado, formularios-backend-csharp.md §5.1). El servidor
 * jamás ejecuta esta migración por sí mismo (ver contact.repo.ts).
 */
import { MongoClient } from 'mongodb';
import { loadConfig } from '../../src/shared/config/env.js';
import {
  ensureContactSetup,
  findObsoleteContactIndexes,
} from '../../src/modules/contact/contact.repo.js';

const config = loadConfig();
const uri = config.MONGO_URI_FORMS.length > 0 ? config.MONGO_URI_FORMS : config.MONGO_URI;
const client = new MongoClient(uri);

try {
  const db = client.db(config.MONGO_DB_FORMS);
  await ensureContactSetup(db);
  console.log(
    `OK: ${config.MONGO_DB_FORMS}.contact_messages listo (validador e índices aplicados).`,
  );
  const obsolete = await findObsoleteContactIndexes(db);
  for (const name of obsolete) {
    console.warn(`ÍNDICE OBSOLETO NO ELIMINADO: contact_messages.${name}`);
  }
} finally {
  await client.close();
}
