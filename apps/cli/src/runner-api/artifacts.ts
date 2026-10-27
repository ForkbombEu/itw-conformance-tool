import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

/** Why a declared artifact failed its INITIAL publication. */
export type PublicationFailureReason = 'missing' | 'oversize' | 'unreadable' | 'unsafe_id' | 'write_failed';

/**
 * Typed internal outcome for one declared artifact that could not be
 * published. It is an aggregation input, never a wire field.
 */
export interface PublicationFailure {
  artifactId: string;
  filename: string;
  reason: PublicationFailureReason;
}

export interface PublicationOutcome {
  /** Exactly the entries the persisted manifest advertises (computed hash/size). */
  entries: ManifestEntry[];
  /** Every declared artifact of this call that was not published. */
  failures: PublicationFailure[];
  /** One human-readable limitation per failure. */
  limitations: string[];
}

/** Reads a worker-produced source file. Production uses the real filesystem. */
export type ArtifactSourceReader = (path: string) => Buffer;

export interface ArtifactStoreOptions {
  /** Internal test-only seam for the source read of initial publication. */
  readSource?: ArtifactSourceReader;
}

export function publicationFailureLimitation(failure: PublicationFailure): string {
  const name = `Evidence artifact '${failure.filename}'`;
  switch (failure.reason) {
    case 'missing':
      return `${name} is missing and was not published.`;
    case 'oversize':
      return `${name} exceeds the ${MAX_ARTIFACT_BYTES}-byte cap and was not published.`;
    case 'unreadable':
      return `${name} could not be read and was not published.`;
    case 'unsafe_id':
      return `Artifact '${failure.filename}' has an unsafe ID and was not published.`;
    case 'write_failed':
      return `${name} could not be stored and was not published.`;
  }
}

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
  private readonly readSource: ArtifactSourceReader;
  private readonly root: string;

  constructor(stateDir: string, options: ArtifactStoreOptions = {}) {
    this.root = join(stateDir, 'artifacts');
    this.readSource = options.readSource ?? ((path) => readFileSync(path));
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
   * public entries. Missing, oversized, unreadable or unstorable files yield
   * typed failures (plus a limitation each), never an entry with an empty hash
   * and never an exception for a single file. Only entries the persisted
   * manifest really advertises are returned.
   */
  finalize(runId: string, artifacts: readonly PrivateArtifact[]): PublicationOutcome {
    const dir = this.runDir(runId);
    const filesDir = join(dir, 'files');
    const existing = this.readManifest(runId);
    const published: StoredManifest['entries'] = existing ? [...existing.entries] : [];
    const copied: StoredManifest['entries'] = [];
    const failures: PublicationFailure[] = [];
    const fail = (artifact: PrivateArtifact, reason: PublicationFailureReason): void => {
      failures.push({ artifactId: artifact.artifactId, filename: artifact.filename, reason });
    };

    for (const artifact of artifacts) {
      if (!isSafeArtifactId(artifact.artifactId)) {
        fail(artifact, 'unsafe_id');
        continue;
      }
      const known = (entry: StoredManifest['entries'][number]): boolean => entry.artifact_id === artifact.artifactId;
      if (published.some(known) || copied.some(known)) continue; // immutable once published
      if (!existsSync(artifact.path)) {
        fail(artifact, 'missing');
        continue;
      }
      let content: Buffer;
      try {
        if (statSync(artifact.path).size > MAX_ARTIFACT_BYTES) {
          fail(artifact, 'oversize');
          continue;
        }
        content = this.readSource(artifact.path);
      } catch {
        fail(artifact, 'unreadable');
        continue;
      }
      if (content.length > MAX_ARTIFACT_BYTES) {
        fail(artifact, 'oversize');
        continue;
      }
      try {
        mkdirSync(filesDir, { recursive: true });
        writeAtomically(join(filesDir, artifact.artifactId), content);
      } catch {
        fail(artifact, 'write_failed');
        continue;
      }
      copied.push({
        artifact_id: artifact.artifactId,
        filename: artifact.filename,
        mime_type: artifact.mimeType,
        sha256: createHash('sha256').update(content).digest('hex'),
        size_bytes: content.length
      });
    }

    if (copied.length > 0) {
      const manifest: StoredManifest = { entries: [...published, ...copied], run_id: runId };
      try {
        writeAtomically(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
        published.push(...copied);
      } catch {
        // Without a manifest the copies are unreachable: never advertise them.
        for (const entry of copied) {
          failures.push({ artifactId: entry.artifact_id, filename: entry.filename, reason: 'write_failed' });
          removeQuietly(join(filesDir, entry.artifact_id));
        }
      }
    }

    return {
      entries: published.map((entry) => toPublicEntry(runId, entry)),
      failures,
      limitations: failures.map(publicationFailureLimitation)
    };
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

/** Writes via a private temp file and rename; a failed write leaves no temp file behind. */
function writeAtomically(target: string, content: Buffer | string): void {
  const temp = `${target}.tmp`;
  try {
    writeFileSync(temp, content, { mode: 0o600 });
    renameSync(temp, target);
  } catch (error) {
    removeQuietly(temp);
    throw error;
  }
}

/** Best-effort cleanup of an unpublished file; a path that is not a removable file is left alone. */
function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // e.g. a directory squatting on the path: nothing advertises it.
  }
}

function toPublicEntry(runId: string, entry: StoredManifest['entries'][number]): ManifestEntry {
  return { ...entry, download_url: downloadUrl(runId, entry.artifact_id) };
}
