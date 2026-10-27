import { resolve } from 'node:path';

import { ArtifactStore } from '../runner-api/artifacts.js';
import { JobManager, type ExecuteContext, type ExecutionEvidence } from '../runner-api/job-manager.js';
import { JobStore } from '../runner-api/job-store.js';
import { resolveEngineIdentity } from '../runner-api/native-launch.js';
import { createNativeExecutor, processGroupAlive, type ProcessAdapter } from '../runner-api/native-worker.js';
import { loadProfileCatalogue } from '../runner-api/profiles.js';
import { createRunnerServer } from '../runner-api/server.js';

export interface ServeRunnerOptions {
  host: string;
  /** Internal low-level subprocess boundary; production uses real OS processes. */
  processAdapter?: ProcessAdapter;
  port: number;
  profiles: string;
  stateDir: string;
}

export interface ServeRunnerHandle {
  close(): Promise<void>;
  url: string;
}

export async function serveRunner(options: ServeRunnerOptions): Promise<ServeRunnerHandle> {
  const token = process.env.CREDIMI_RUNNER_TOKEN;
  if (!token) {
    throw new Error('CREDIMI_RUNNER_TOKEN environment variable is required');
  }

  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }

  if (!options.profiles) throw new Error('--profiles is required');
  // Validate every startup input before taking ownership or opening a listener.
  const catalogue = loadProfileCatalogue(options.profiles);
  const identity = resolveEngineIdentity();
  const stateDir = resolve(options.stateDir);

  const store = new JobStore(stateDir);
  if (!store.acquireRootLock()) {
    throw new Error(`State directory ${stateDir} is already locked by another process (${store.lockHolder()})`);
  }

  try {
    const artifacts = new ArtifactStore();
    const execute = async (ctx: ExecuteContext): Promise<ExecutionEvidence> => {
      const profile = catalogue.get(ctx.request.profile_id);
      if (!profile) throw new Error(`Unknown profile_id '${ctx.request.profile_id}'`);
      const nativeExecutor = createNativeExecutor({ processAdapter: options.processAdapter, profile });
      const evidence = await nativeExecutor(ctx);

      // Register real artifacts
      for (const artifactPath of evidence.privateArtifactPaths) {
        const basename = artifactPath.split('/').pop() ?? 'artifact';
        const artifactId = `${ctx.runId}:${basename}`;
        artifacts.registerFile(artifactId, basename, 'application/json', artifactPath);
      }

      return evidence;
    };
    // Validate/migrate/index records only after ownership is established.
    const jobManager = new JobManager({ execute, store });
    for (const record of store.quarantinedRecords()) {
      process.stderr.write(`Quarantined corrupt run record ${record.file}: ${record.reason}\n`);
    }
    jobManager.recoverInterruptedRuns(processGroupAlive);
    const app = createRunnerServer({ artifacts, catalogue, engine: identity.engine, jobManager });

    try {
      await app.listen({ host: options.host, port });
    } catch (error) {
      await app.close().catch(() => undefined);
      throw error;
    }
    const address = app.server.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;
    const url = `http://${options.host}:${boundPort}`;

    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= (async () => {
        await app.close();
        await jobManager.shutdown();
        store.releaseRootLock();
      })();
      return closing;
    };

    return { close, url };
  } catch (error) {
    // Startup failed after taking ownership: release only our own lock.
    store.releaseRootLock();
    throw error;
  }
}

/** Closes the runner on SIGINT/SIGTERM so owned locks, listeners and native children are cleaned up. */
export function installRunnerSignalHandlers(handle: ServeRunnerHandle, onClosed: (code: number) => void): () => void {
  const onSignal = (): void => {
    handle.close().then(
      () => onClosed(0),
      () => onClosed(1)
    );
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return () => {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  };
}
