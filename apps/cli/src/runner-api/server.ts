import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { ArtifactStore, isSafeArtifactId } from './artifacts.js';
import { invalidRequest, RunnerError, runRequestSchema } from './contract.js';

import type { RunRequest } from './contract.js';
import type { JobManager } from './job-manager.js';

export interface RunnerDependencies {
  artifacts: ArtifactStore;
  jobManager: JobManager;
}

const JSON_LIMIT = 65536;
const CONTRACT_VERSION = '1.0';
const ENGINE_ID = 'pagopa-itwct';

export function createRunnerServer(deps: RunnerDependencies): FastifyInstance {
  const app = Fastify({ bodyLimit: JSON_LIMIT });

  // Auth middleware for /v1 routes
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.url === '/healthz') return;
    const token = process.env.CREDIMI_RUNNER_TOKEN;
    if (!token) {
      return reply.status(500).send({
        error: { code: 'SERVER_MISCONFIGURED', message: 'CREDIMI_RUNNER_TOKEN is not set' }
      });
    }
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      return reply.status(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Missing or invalid bearer token' }
      });
    }
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/v1/capabilities', async () => ({
    categories: ['presentation'],
    contract_version: CONTRACT_VERSION,
    engine: {
      fork_repository: 'https://github.com/ForkbombEu/itw-conformance-tool',
      id: ENGINE_ID,
      revision: 'unknown',
      upstream_repository: 'https://github.com/pagopa/itw-conformance-tool',
      version: '1.0'
    },
    max_timeout_ms: 900_000,
    profiles: [],
    selection_catalogue: []
  }));

  app.post('/v1/runs', async (req: FastifyRequest, reply: FastifyReply) => {
    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      throw invalidRequest('Idempotency-Key header is required');
    }

    const body = req.body as Record<string, unknown>;
    const parsed = runRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw invalidRequest(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    }

    const { replayed, snapshot } = await deps.jobManager.submit(parsed.data as RunRequest, idempotencyKey);
    return reply.status(replayed ? 200 : 202).send(snapshot);
  });

  app.get('/v1/runs/:runId', async (req: FastifyRequest) => {
    const { runId } = req.params as { runId: string };
    return deps.jobManager.getSnapshot(runId);
  });

  app.post('/v1/runs/:runId/cancel', async (req: FastifyRequest) => {
    const { runId } = req.params as { runId: string };
    return deps.jobManager.cancel(runId);
  });

  app.post('/v1/runs/cancel-by-key', async (req: FastifyRequest) => {
    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      throw invalidRequest('Idempotency-Key header is required');
    }
    return deps.jobManager.cancelByKey(idempotencyKey);
  });

  app.post('/v1/runs/:runId/interactions/:interactionId/ack', async (req: FastifyRequest) => {
    const { runId, interactionId } = req.params as { runId: string; interactionId: string };
    const body = req.body as { driver_status?: string; message?: string };
    if (!body || (body.driver_status !== 'completed' && body.driver_status !== 'failed')) {
      throw invalidRequest("driver_status must be 'completed' or 'failed'");
    }
    return deps.jobManager.acknowledge(runId, interactionId, {
      driver_status: body.driver_status,
      message: body.message
    });
  });

  app.get('/v1/runs/:runId/result', async (req: FastifyRequest) => {
    const { runId } = req.params as { runId: string };
    return deps.jobManager.getResult(runId);
  });

  app.get('/v1/runs/:runId/artifacts/:artifactId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { artifactId, runId } = req.params as { artifactId: string; runId: string };
    if (!isSafeArtifactId(artifactId)) {
      return reply.status(400).send({ error: { code: 'INVALID_REQUEST', message: 'Invalid artifact ID' } });
    }
    // Bind run_id and artifact_id
    if (!artifactId.startsWith(`${runId}:`)) {
      return reply
        .status(404)
        .send({ error: { code: 'NOT_FOUND', message: `Artifact '${artifactId}' not found in run '${runId}'` } });
    }
    const record = deps.artifacts.get(artifactId);
    if (!record) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: `Artifact '${artifactId}' not found` } });
    }
    return reply
      .status(200)
      .header('Content-Type', record.contentType)
      .header('X-Content-SHA256', record.sha256)
      .send(record.content);
  });

  // Error handler
  app.setErrorHandler((error: unknown, _req: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof RunnerError) {
      return reply.status(error.httpStatus).send({ error: { code: error.code, message: error.message } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  return app;
}
