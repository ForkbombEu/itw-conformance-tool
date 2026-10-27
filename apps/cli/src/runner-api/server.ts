import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { ArtifactStore, isSafeArtifactId } from './artifacts.js';
import { invalidRequest, RunnerError, runRequestSchema } from './contract.js';

import type { RunRequest, RunnerResult } from './contract.js';
import type { JobManager } from './job-manager.js';
import type { ProfileCatalogue } from './profiles.js';

export interface RunnerDependencies {
  artifacts: ArtifactStore;
  catalogue: ProfileCatalogue;
  engine: RunnerResult['engine'];
  jobManager: JobManager;
}

const JSON_LIMIT = 65536;
const CONTRACT_VERSION = '1.0';

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

  // Capabilities describe the startup-loaded catalogue; no paths or secrets.
  app.get('/v1/capabilities', async () => {
    const profiles = deps.catalogue.publicDescriptors();
    return {
      categories: [...new Set(profiles.map((profile) => profile.category))],
      contract_version: CONTRACT_VERSION,
      engine: deps.engine,
      max_timeout_ms: 900_000,
      profiles,
      selection_catalogue: [...new Set(profiles.flatMap((profile) => profile.allowed_selection_ids))]
    };
  });

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

    const request: RunRequest = parsed.data;
    // Reject what the worker cannot execute before any job is accepted.
    deps.catalogue.preflight(request);
    const { replayed, snapshot } = await deps.jobManager.submit(request, idempotencyKey);
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
    const body = req.body as { driver_status?: unknown; message?: unknown } | undefined;
    if (!body || (body.driver_status !== 'completed' && body.driver_status !== 'failed')) {
      throw invalidRequest("driver_status must be 'completed' or 'failed'");
    }
    if (body.message !== undefined && (typeof body.message !== 'string' || body.message.length > 2_048)) {
      throw invalidRequest('message must be a string of at most 2048 characters');
    }
    const extraKeys = Object.keys(body).filter((key) => key !== 'driver_status' && key !== 'message');
    if (extraKeys.length > 0) throw invalidRequest(`Unknown ACK fields: ${extraKeys.join(', ')}`);
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
