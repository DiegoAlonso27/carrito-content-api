import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/app.js';
import type { ShutdownApp, SignalSource } from '../../src/shared/operation/shutdown.js';
import { registerShutdownHandlers } from '../../src/shared/operation/shutdown.js';
import { makeTestConfig } from '../helpers/test-config.js';

afterEach(() => {
  vi.useRealTimers();
});

function fakeSignalSource(): {
  source: SignalSource;
  listeners: Map<string, () => void>;
} {
  const listeners = new Map<string, () => void>();
  return {
    listeners,
    source: {
      exitCode: undefined,
      once(signal, listener) {
        listeners.set(signal, listener);
      },
    },
  };
}

function controlledShutdownApp(close: () => Promise<unknown>): {
  app: ReturnType<typeof buildApp>;
  shutdownApp: ShutdownApp;
} {
  const app = buildApp(makeTestConfig());
  return { app, shutdownApp: { log: app.log, close } };
}

describe('cierre por señales', () => {
  it('inicia app.close una sola vez aunque lleguen SIGINT y SIGTERM', async () => {
    const { source, listeners } = fakeSignalSource();
    const close = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
    const { app, shutdownApp } = controlledShutdownApp(close);

    registerShutdownHandlers(shutdownApp, source);
    listeners.get('SIGINT')?.();
    listeners.get('SIGTERM')?.();
    await Promise.resolve();

    expect(close).toHaveBeenCalledOnce();
    expect(source.exitCode).toBeUndefined();

    await app.close();
  });

  it('marca exitCode 1 si app.close rechaza', async () => {
    const { source, listeners } = fakeSignalSource();
    const close = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error('fallo controlado'));
    const { app, shutdownApp } = controlledShutdownApp(close);

    registerShutdownHandlers(shutdownApp, source);
    listeners.get('SIGTERM')?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(source.exitCode).toBe(1);

    await app.close();
  });

  it('fuerza salida 1 si app.close no resuelve dentro del timeout', async () => {
    vi.useFakeTimers();
    const { source, listeners } = fakeSignalSource();
    const close = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => new Promise<unknown>(() => undefined));
    const { app, shutdownApp } = controlledShutdownApp(close);
    const fatalSpy = vi.spyOn(app.log, 'fatal').mockImplementation(() => undefined);
    const forceExit = vi.fn<(code: number) => void>();

    registerShutdownHandlers(shutdownApp, source, { timeoutMs: 10_000, forceExit });
    listeners.get('SIGINT')?.();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(forceExit).toHaveBeenCalledWith(1);
    expect(source.exitCode).toBe(1);

    fatalSpy.mockRestore();
    vi.useRealTimers();
    await app.close();
  });
});
