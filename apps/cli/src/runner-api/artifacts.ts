import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import type { RunnerResult } from './contract.js';

/** One raw evidence file a worker produced, still at its private path. */
export interface PrivateArtifact {
  artifactId: string;
  filename: string;
  mimeType: string;
  path: string;
}

export type ManifestEntry = RunnerResult['artifacts'][number];

/**
 * Explicit, deterministic limits: each artifact is copied (immutable) into the
 * state root up to this size; larger files are not published. Artifacts are
 * retained with their run record; nothing is pruned automatically.
 */
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export function isSafeArtifactId(id: string): boolean {
  return SAFE_ID.test(id) && !id.includes('..');
}

const storedEntrySchema = z.strictObject({
  artifact_id: z.string().regex(SAFE_ID),
  filename: z.string().min(1).max(255),
  mime_type: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size_bytes: z.number().int().min(0)
});

const manifestSchema = z.strictObject({
  entries: z.array(storedEntrySchema),
  run_id: z.string().regex(SAFE_ID)
});
type StoredManifest = z.infer<typeof manifestSchema>;

export interface ArtifactRecord {
  content: Buffer;
  entry: ManifestEntry;
}

export class ArtifactUnavailableError extends Error {
  readonly code: 'ARTIFACT_CORRUPT' | 'ARTIFACT_MISSING';
  constructor(code: 'ARTIFACT_CORRUPT' | 'ARTIFACT_MISSING', message: string) {
    super(message);
    this.name = 'ArtifactUnavailableError';
    this.code = code;
  }
}

export function downloadUrl(runId: string, artifactId: string): string {
  return `/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`;
}

/**
 * Persistent run-scoped artifact store under `<state>/artifacts/<runId>/`:
 * an atomically published `manifest.json` plus immutable copies of the exact
 * bytes. Lookups bind BOTH the run ID and the artifact ID to that run's
 * manifest and re-verify the stored SHA-256, so they survive restarts.
 */
export class ArtifactStore {
  private readonly root: string;

  constructor(stateDir: string) {
    this.root = join(stateDir, 'artifacts');
  }

  private runDir(runId: string): string {
    if (!SAFE_ID.test(runId)) throw new Error(`Unsafe run ID: ${runId}`);
    return join(this.root, runId);
  }

  private readManifest(runId: string): StoredManifest | undefined {
    if (!SAFE_ID.test(runId)) return undefined;
    const path = join(this.runDir(runId), 'manifest.json');
    if (!existsSync(path)) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return undefined;
    }
    const parsed = manifestSchema.safeParse(raw);
    return parsed.success && parsed.data.run_id === runId ? parsed.data : undefined;
  }

  /**
   * The production finalization step: hashes the actual bytes, copies them
   * immutably, publishes the run manifest atomically and returns the exact
   * public entries. Missing, oversized or unreadable files yield explicit
   * limitations, never an entry with an empty hash.
   */
  finalize(runId: string, artifacts: readonly PrivateArtifact[]): { entries: ManifestEntry[]; limitations: string[] } {
    const dir = this.runDir(runId);
    const filesDir = join(dir, 'files');
    const existing = this.readManifest(runId);
    const stored: StoredManifest['entries'] = existing ? [...existing.entries] : [];
    const limitations: string[] = [];

    for (const artifact of artifacts) {
      if (!isSafeArtifactId(artifact.artifactId)) {
        limitations.push(`Artifact '${artifact.filename}' has an unsafe ID and was not published.`);
        continue;
      }
      if (stored.some((entry) => entry.artifact_id === artifact.artifactId)) continue; // immutable once published
      if (!existsSync(artifact.path)) {
        limitations.push(`Evidence artifact '${artifact.filename}' is missing and was not published.`);
        continue;
      }
      const size = statSync(artifact.path).size;
      if (size > MAX_ARTIFACT_BYTES) {
        limitations.push(
          `Evidence artifact '${artifact.filename}' (${size} bytes) exceeds the ${MAX_ARTIFACT_BYTES}-byte cap and was not published.`
        );
        continue;
      }
      let content: Buffer;
      try {
        content = readFileSync(artifact.path);
      } catch {
        limitations.push(`Evidence artifact '${artifact.filename}' could not be read and was not published.`);
        continue;
      }
      mkdirSync(filesDir, { recursive: true });
      const target = join(filesDir, artifact.artifactId);
      writeFileSync(`${target}.tmp`, content, { mode: 0o600 });
      renameSync(`${target}.tmp`, target);
      stored.push({
        artifact_id: artifact.artifactId,
        filename: artifact.filename,
        mime_type: artifact.mimeType,
        sha256: createHash('sha256').update(content).digest('hex'),
        size_bytes: content.length
      });
    }

    if (stored.length > 0) {
      mkdirSync(dir, { recursive: true });
      const manifest: StoredManifest = { entries: stored, run_id: runId };
      const path = join(dir, 'manifest.json');
      writeFileSync(`${path}.tmp`, JSON.stringify(manifest, null, 2), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    }

    return { entries: stored.map((entry) => toPublicEntry(runId, entry)), limitations };
  }

  /** Manifest entries of a run, as published in its RunnerResult. */
  list(runId: string): ManifestEntry[] {
    return (this.readManifest(runId)?.entries ?? []).map((entry) => toPublicEntry(runId, entry));
  }

  /** Bytes of one artifact bound to its run; undefined if the run has no such entry. */
  get(runId: string, artifactId: string): ArtifactRecord | undefined {
    if (!isSafeArtifactId(artifactId)) return undefined;
    const entry = this.readManifest(runId)?.entries.find((candidate) => candidate.artifact_id === artifactId);
    if (!entry) return undefined;
    const path = join(this.runDir(runId), 'files', artifactId);
    if (!existsSync(path)) {
      throw new ArtifactUnavailableError('ARTIFACT_MISSING', `Artifact '${artifactId}' of run '${runId}' is missing`);
    }
    const content = readFileSync(path);
    if (content.length !== entry.size_bytes || createHash('sha256').update(content).digest('hex') !== entry.sha256) {
      throw new ArtifactUnavailableError(
        'ARTIFACT_CORRUPT',
        `Artifact '${artifactId}' of run '${runId}' no longer matches its manifest hash`
      );
    }
    return { content, entry: toPublicEntry(runId, entry) };
  }
}

function toPublicEntry(runId: string, entry: StoredManifest['entries'][number]): ManifestEntry {
  return { ...entry, download_url: downloadUrl(runId, entry.artifact_id) };
}
