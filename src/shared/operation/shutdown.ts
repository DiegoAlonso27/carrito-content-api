import type { FastifyBaseLogger } from 'fastify';
import { safeErrorLog } from '../logging/logger.js';

type ShutdownSignal = 'SIGINT' | 'SIGTERM';
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export interface SignalSource {
  once(signal: ShutdownSignal, listener: () => void): unknown;
  exitCode: string | number | null | undefined;
}

export interface ShutdownOptions {
  timeoutMs?: number;
  forceExit?: (code: number) => void;
}

export interface ShutdownApp {
  log: Pick<FastifyBaseLogger, 'info' | 'error' | 'fatal'>;
  close(): Promise<unknown>;
}

/** Registra un único cierre ordenado aunque lleguen varias señales. */
export function registerShutdownHandlers(
  app: ShutdownApp,
  signalSource: SignalSource = process,
  options: ShutdownOptions = {},
): void {
  let shutdownStarted = false;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const forceExit = options.forceExit ?? ((code: number) => process.exit(code));

  const shutdown = (signal: ShutdownSignal): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    app.log.info({ signal }, 'apagando');
    const escapeTimer = setTimeout(() => {
      signalSource.exitCode = 1;
      app.log.fatal({ signal, timeoutMs }, 'timeout del cierre ordenado; salida forzada');
      forceExit(1);
    }, timeoutMs);
    escapeTimer.unref();

    void app.close().then(
      () => clearTimeout(escapeTimer),
      (err: unknown) => {
        clearTimeout(escapeTimer);
        signalSource.exitCode = 1;
        app.log.error(
          { error: safeErrorLog(err, { includeStackFrames: true }) },
          'falló el cierre ordenado',
        );
      },
    );
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    signalSource.once(signal, () => shutdown(signal));
  }
}
