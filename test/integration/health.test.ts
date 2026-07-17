import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeTestConfig } from '../helpers/test-config.js';

let mongod: MongoMemoryServer;
let app: FastifyInstance;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  app = buildApp(makeTestConfig({ MONGO_URI: mongod.getUri() }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await mongod.stop();
});

describe('humo con MongoDB real (memoria)', () => {
  it('readiness responde 200 cuando ambas bases responden al ping', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('liveness responde 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
  });
});
