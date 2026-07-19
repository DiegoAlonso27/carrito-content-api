import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { ContentRepo } from '../../src/modules/content/content.repo.js';
import { contentCollections } from '../../src/modules/content/content.collections.js';
import {
  contactCollections,
  ensureContactSetup,
  findObsoleteContactIndexes,
} from '../../src/modules/contact/contact.repo.js';
import {
  complaintsCollections,
  ensureComplaintsSetup,
  findObsoleteComplaintsIndexes,
} from '../../src/modules/complaints/complaints.repo.js';
import { listedIndexNames } from '../../src/shared/db/indexes.js';

let mongod: MongoMemoryServer;
let client: MongoClient;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

describe('índices gestionados F7', () => {
  it('crea solo índices usados y reporta obsoletos sin eliminarlos', async () => {
    const contentDb = client.db('carrito_content');
    const formsDb = client.db('carrito_forms');
    const contentRepo = new ContentRepo(contentDb);

    await contentRepo.ensureSetup();
    await ensureContactSetup(formsDb);
    await ensureComplaintsSetup(formsDb);

    const itemNames = listedIndexNames(
      await contentDb.collection(contentCollections.items).listIndexes().toArray(),
    );
    expect(itemNames).toContain('ix_items_locale_status');
    expect(itemNames).not.toContain('ix_items_col_locale_status_sort');

    const contactNames = listedIndexNames(
      await formsDb.collection(contactCollections.messages).listIndexes().toArray(),
    );
    expect(contactNames).toContain('ux_contact_messages_submission_id');
    expect(contactNames).not.toContain('ix_contact_messages_created_at');

    const complaintNames = listedIndexNames(
      await formsDb.collection(complaintsCollections.complaints).listIndexes().toArray(),
    );
    expect(complaintNames).toContain('ux_complaints_submission_id');
    expect(complaintNames).toContain('ux_complaints_code');
    expect(complaintNames).not.toContain('ix_complaints_created_at');

    await contentDb
      .collection(contentCollections.items)
      .createIndex(
        { collectionSlug: 1, localeCode: 1, status: 1, sortOrder: 1 },
        { name: 'ix_items_col_locale_status_sort' },
      );
    await formsDb
      .collection(contactCollections.messages)
      .createIndex({ createdAtUtc: -1 }, { name: 'ix_contact_messages_created_at' });
    await formsDb
      .collection(complaintsCollections.complaints)
      .createIndex({ createdAtUtc: -1 }, { name: 'ix_complaints_created_at' });

    await expect(contentRepo.findObsoleteIndexes()).resolves.toEqual([
      { collection: contentCollections.items, name: 'ix_items_col_locale_status_sort' },
    ]);
    await expect(findObsoleteContactIndexes(formsDb)).resolves.toEqual([
      'ix_contact_messages_created_at',
    ]);
    await expect(findObsoleteComplaintsIndexes(formsDb)).resolves.toEqual([
      'ix_complaints_created_at',
    ]);

    const namesAfterReport = listedIndexNames(
      await formsDb.collection(contactCollections.messages).listIndexes().toArray(),
    );
    expect(namesAfterReport).toContain('ix_contact_messages_created_at');
  });
});
