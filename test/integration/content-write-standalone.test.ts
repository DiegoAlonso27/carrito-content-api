import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import type { Db } from 'mongodb';
import {
  ContentWriteError,
  setRecords,
  setStatus,
} from '../../src/modules/content/content-write.js';
import { contentCollections } from '../../src/modules/content/content.collections.js';
import { ContentRepo } from '../../src/modules/content/content.repo.js';
import type { ContentMetaDoc } from '../../src/modules/content/content.types.js';

/**
 * Mutaciones editoriales exigen replica set (ADR-001). Este suite usa
 * MongoMemoryServer standalone a propósito.
 */
let mongod: MongoMemoryServer;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  db = client.db('carrito_content_standalone_test');
  await new ContentRepo(db).ensureSetup();
  await db.collection(contentCollections.locales).insertOne({
    code: 'es-PE',
    name: 'Español',
    isDefault: true,
    isActive: true,
    sortOrder: 1,
    status: 'published',
    revision: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.collection<ContentMetaDoc>(contentCollections.meta).insertOne({
    _id: 'content',
    contentVersion: 1,
    tokenSeq: 2,
  });
}, 60_000);

afterAll(async () => {
  await client.close();
  await mongod.stop();
});

describe('escrituras editoriales en Mongo standalone (ADR-001)', () => {
  it('setRecords falla con ContentWriteError y no escribe ni cambia contentVersion', async () => {
    const textsBefore = await db.collection(contentCollections.texts).countDocuments();
    const metaBefore = await db
      .collection<ContentMetaDoc>(contentCollections.meta)
      .findOne({ _id: 'content' });

    await expect(
      setRecords(db, 'texts', [
        {
          localeCode: 'es-PE',
          key: 'standalone.forbidden',
          value: 'no',
          isActive: true,
          sortOrder: 1,
        },
      ]),
    ).rejects.toThrow(/replica set/);

    await expect(
      setRecords(db, 'texts', [
        {
          localeCode: 'es-PE',
          key: 'standalone.forbidden',
          value: 'no',
          isActive: true,
          sortOrder: 1,
        },
      ]),
    ).rejects.toBeInstanceOf(ContentWriteError);

    expect(await db.collection(contentCollections.texts).countDocuments()).toBe(textsBefore);
    expect(
      await db.collection(contentCollections.texts).findOne({ key: 'standalone.forbidden' }),
    ).toBeNull();
    const metaAfter = await db
      .collection<ContentMetaDoc>(contentCollections.meta)
      .findOne({ _id: 'content' });
    expect(metaAfter?.contentVersion).toBe(metaBefore?.contentVersion);
    expect(metaAfter?.tokenSeq).toBe(metaBefore?.tokenSeq);
  });

  it('setStatus también rechaza standalone sin mutar', async () => {
    await db.collection(contentCollections.texts).insertOne({
      localeCode: 'es-PE',
      key: 'standalone.status',
      value: 'draft-doc',
      isActive: true,
      sortOrder: 2,
      status: 'draft',
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const metaBefore = await db
      .collection<ContentMetaDoc>(contentCollections.meta)
      .findOne({ _id: 'content' });

    await expect(setStatus(db, 'texts', 'es-PE/standalone.status', 'published')).rejects.toThrow(
      /replica set/,
    );
    await expect(
      setStatus(db, 'texts', 'es-PE/standalone.status', 'published'),
    ).rejects.toBeInstanceOf(ContentWriteError);

    const doc = await db.collection(contentCollections.texts).findOne({ key: 'standalone.status' });
    expect(doc?.['status']).toBe('draft');
    expect(doc?.['revision']).toBe(1);
    const metaAfter = await db
      .collection<ContentMetaDoc>(contentCollections.meta)
      .findOne({ _id: 'content' });
    expect(metaAfter?.contentVersion).toBe(metaBefore?.contentVersion);
    expect(metaAfter?.tokenSeq).toBe(metaBefore?.tokenSeq);
  });
});
