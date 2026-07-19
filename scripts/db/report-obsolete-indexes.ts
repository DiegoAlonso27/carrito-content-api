/** Reporte de solo lectura: nunca ejecuta dropIndex ni otro DDL. */
import { ContentRepo } from '../../src/modules/content/content.repo.js';
import { findObsoleteContactIndexes } from '../../src/modules/contact/contact.repo.js';
import { findObsoleteComplaintsIndexes } from '../../src/modules/complaints/complaints.repo.js';
import { loadConfig } from '../../src/shared/config/env.js';
import { closeMongo, createMongoContext } from '../../src/shared/db/mongo.js';

const config = loadConfig();
const mongo = createMongoContext(config);

try {
  const [content, contact, complaints] = await Promise.all([
    new ContentRepo(mongo.contentDb).findObsoleteIndexes(),
    findObsoleteContactIndexes(mongo.formsDb),
    findObsoleteComplaintsIndexes(mongo.formsDb),
  ]);
  const obsolete = [
    ...content.map((index) => `${config.MONGO_DB_CONTENT}.${index.collection}.${index.name}`),
    ...contact.map((name) => `${config.MONGO_DB_FORMS}.contact_messages.${name}`),
    ...complaints.map((name) => `${config.MONGO_DB_FORMS}.complaints.${name}`),
  ];

  if (obsolete.length === 0) {
    console.log('OK: no se detectaron índices obsoletos conocidos.');
  } else {
    console.warn('Índices obsoletos detectados; NO se eliminó ninguno:');
    for (const name of obsolete) console.warn(`  - ${name}`);
    console.warn('Cualquier dropIndex requiere revisión y decisión explícita del operador.');
  }
} finally {
  await closeMongo(mongo);
}
