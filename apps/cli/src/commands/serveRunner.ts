import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { ArtifactStore } from '../runner-api/artifacts.js';
import { JobManager } from '../runner-api/job-manager.js';
import { JobStore } from '../runner-api/job-store.js';
import { validateProfile } from '../runner-api/profiles.js';
import { createRunnerServer } from '../runner-api/server.js';

export interface ServeRunnerOptions {
  host: string;
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

  const profilesPath = resolve(options.profiles);
  if (!existsSync(profilesPath)) {
    throw new Error(`Profiles file not found: ${profilesPath}`);
  }

  const stateDir = resolve(options.stateDir);

  // Load and validate profiles
  const { readFileSync } = await import('node:fs');
  const raw = JSON.parse(readFileSync(profilesPath, 'utf-8')) as { profiles?: unknown[] };
  const profiles = (raw.profiles ?? []).map((p) => validateProfile(p));

  // Setup job store and manager
  const store = new JobStore(stateDir);
  if (!store.acquireRootLock('serve-runner')) {
    throw new Error(`State directory ${stateDir} is already locked by another process`);
  }

  const artifacts = new ArtifactStore();
  const execute = async (ctx: { abortSignal: AbortSignal; request: any; runId: string; runRoot: string }) => {
    const { createNativeExecutor } = await import('../runner-api/native-worker.js');
    const profile = profiles[0];
    if (!profile) throw new Error('No profile loaded');
    const nativeExecutor = createNativeExecutor({
      profile,
      request: ctx.request
    });
    const evidence = await nativeExecutor(ctx as never);

    // Register real artifacts
    for (const artifactPath of evidence.privateArtifactPaths) {
      const basename = artifactPath.split('/').pop() ?? 'artifact';
      const artifactId = `${ctx.runId}:${basename}`;
      artifacts.registerFile(artifactId, basename, 'application/json', artifactPath);
    }

    return evidence;
  };
  const jobManager = new JobManager({ execute: execute as never, store });
  const app = createRunnerServer({ artifacts, jobManager });

  await app.listen({ host: options.host, port });
  const url = `http://${options.host}:${port}`;

  const close = async (): Promise<void> => {
    await jobManager.shutdown();
    await app.close();
  };

  return { close, url };
}
