import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ArtifactStore,
  ArtifactUnavailableError,
  isSafeArtifactId,
  MAX_ARTIFACT_BYTES
} from '../../runner-api/artifacts.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'itwct-artifacts-'));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

function file(name: string, content: string | Buffer): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe('ArtifactStore (persistent, run-scoped)', () => {
  it('finalizes real bytes into a manifest entry with the actual SHA-256 and size', () => {
    const store = new ArtifactStore(join(dir, 'state'));
    const path = file('native-results.json', 'hello world');
    const { entries, limitations } = store.finalize('run-1', [
      { artifactId: 'native-results', filename: 'native-results.json', mimeType: 'application/json', path }
    ]);
    expect(limitations).toEqual([]);
    expect(entries).toEqual([
      {
        artifact_id: 'native-results',
        download_url: '/v1/runs/run-1/artifacts/native-results',
        filename: 'native-results.json',
        mime_type: 'application/json',
        sha256: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
        size_bytes: 11
      }
    ]);
    expect(JSON.stringify(entries)).not.toContain(dir);
  });

  it('survives a restart and binds both run and artifact ID', () => {
    const stateDir = join(dir, 'state');
    const bytes = Buffer.from('{"exact":"bytes"}\n');
    new ArtifactStore(stateDir).finalize('run-1', [
      { artifactId: 'native-results', filename: 'n.json', mimeType: 'application/json', path: file('n.json', bytes) }
    ]);
    const reopened = new ArtifactStore(stateDir);
    expect(reopened.get('run-1', 'native-results')?.content).toEqual(bytes);
    expect(reopened.get('run-2', 'native-results')).toBeUndefined();
    expect(reopened.get('run-1', 'other')).toBeUndefined();
    expect(reopened.list('run-1')[0]?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('never publishes an empty hash: missing and oversized files become limitations', () => {
    const store = new ArtifactStore(join(dir, 'state'));
    const { entries, limitations } = store.finalize('run-1', [
      { artifactId: 'missing', filename: 'missing.json', mimeType: 'application/json', path: join(dir, 'nope') },
      {
        artifactId: 'huge',
        filename: 'huge.bin',
        mimeType: 'application/octet-stream',
        path: file('huge.bin', Buffer.alloc(MAX_ARTIFACT_BYTES + 1))
      }
    ]);
    expect(entries).toEqual([]);
    expect(limitations).toHaveLength(2);
  });

  it('detects a corrupted stored copy instead of serving it', () => {
    const stateDir = join(dir, 'state');
    const store = new ArtifactStore(stateDir);
    store.finalize('run-1', [
      { artifactId: 'native-results', filename: 'n.json', mimeType: 'application/json', path: file('n.json', 'x') }
    ]);
    writeFileSync(join(stateDir, 'artifacts', 'run-1', 'files', 'native-results'), 'tampered');
    expect(() => store.get('run-1', 'native-results')).toThrow(ArtifactUnavailableError);
    rmSync(join(stateDir, 'artifacts', 'run-1', 'files', 'native-results'));
    expect(() => store.get('run-1', 'native-results')).toThrow(/missing/);
  });
});

// R17: the real publisher boundary. Every declared artifact that fails its
// INITIAL publication is reported as a typed failure (never only a string),
// is not advertised and cannot be downloaded.
describe('ArtifactStore initial publication failures (R17, real filesystem)', () => {
  const declared = (artifactId: string, path: string) => ({
    artifactId,
    filename: `${artifactId}.json`,
    mimeType: 'application/json',
    path
  });

  it('a successful publication has no failures', () => {
    const store = new ArtifactStore(join(dir, 'state'));
    const outcome = store.finalize('run-1', [declared('native-results', file('ok.json', '{}'))]);
    expect(outcome.failures).toEqual([]);
    expect(outcome.entries).toHaveLength(1);
  });

  it('missing source → typed missing failure, nothing advertised', () => {
    const store = new ArtifactStore(join(dir, 'state'));
    const outcome = store.finalize('run-1', [declared('native-results', join(dir, 'absent.json'))]);
    expect(outcome.failures).toEqual([
      { artifactId: 'native-results', filename: 'native-results.json', reason: 'missing' }
    ]);
    expect(outcome.entries).toEqual([]);
    expect(outcome.limitations).toHaveLength(1);
    expect(store.get('run-1', 'native-results')).toBeUndefined();
  });

  it('unreadable source (chmod 000) → typed unreadable failure', () => {
    const path = file('locked.json', '{"secret":true}');
    chmodSync(path, 0o000);
    try {
      const store = new ArtifactStore(join(dir, 'state'));
      const outcome = store.finalize('run-1', [declared('native-results', path)]);
      expect(outcome.failures.map((f) => f.reason)).toEqual(['unreadable']);
      expect(outcome.entries).toEqual([]);
      expect(store.list('run-1')).toEqual([]);
    } finally {
      chmodSync(path, 0o600);
    }
  });

  it('oversize source (sparse file, production cap unchanged) → typed oversize failure', () => {
    const path = join(dir, 'sparse.bin');
    writeFileSync(path, '');
    truncateSync(path, MAX_ARTIFACT_BYTES + 1);
    const store = new ArtifactStore(join(dir, 'state'));
    const outcome = store.finalize('run-1', [declared('native-results', path)]);
    expect(outcome.failures.map((f) => f.reason)).toEqual(['oversize']);
    expect(outcome.entries).toEqual([]);
  });

  it('a copy write error is a typed write_failed failure, not an exception; other artifacts still publish', () => {
    const stateDir = join(dir, 'state');
    // A directory squatting on the temp copy path makes the real write fail.
    mkdirSync(join(stateDir, 'artifacts', 'run-1', 'files', 'native-results.tmp'), { recursive: true });
    const store = new ArtifactStore(stateDir);
    const okBytes = Buffer.from('{"ok":true}');
    const outcome = store.finalize('run-1', [
      declared('native-results', file('n.json', '{}')),
      declared('session-log', file('s.json', okBytes))
    ]);
    expect(outcome.failures.map((f) => [f.artifactId, f.reason])).toEqual([['native-results', 'write_failed']]);
    expect(outcome.entries.map((e) => e.artifact_id)).toEqual(['session-log']);
    expect(outcome.entries[0]?.sha256).toBe(createHash('sha256').update(okBytes).digest('hex'));
    expect(store.get('run-1', 'native-results')).toBeUndefined();
    expect(store.get('run-1', 'session-log')?.content).toEqual(okBytes);
  });

  it('a manifest write error advertises nothing new and reports every new copy as write_failed', () => {
    const stateDir = join(dir, 'state');
    mkdirSync(join(stateDir, 'artifacts', 'run-1', 'manifest.json.tmp'), { recursive: true });
    const store = new ArtifactStore(stateDir);
    const outcome = store.finalize('run-1', [declared('native-results', file('n.json', '{}'))]);
    expect(outcome.failures.map((f) => f.reason)).toEqual(['write_failed']);
    expect(outcome.entries).toEqual([]);
    expect(existsSync(join(stateDir, 'artifacts', 'run-1', 'manifest.json'))).toBe(false);
    expect(store.list('run-1')).toEqual([]);
  });

  it('the named internal source-reader seam reports an injected read failure as unreadable', () => {
    const path = file('n.json', '{}');
    const store = new ArtifactStore(join(dir, 'state'), {
      readSource: (source) => {
        if (source === path) throw new Error('EIO: injected read failure');
        return readFileSync(source);
      }
    });
    const outcome = store.finalize('run-1', [declared('native-results', path)]);
    expect(outcome.failures.map((f) => f.reason)).toEqual(['unreadable']);
    expect(outcome.entries).toEqual([]);
  });
});

describe('isSafeArtifactId', () => {
  it('accepts safe IDs', () => {
    expect(isSafeArtifactId('native-results')).toBe(true);
    expect(isSafeArtifactId('abc-def_123.json')).toBe(true);
  });

  it('rejects traversal and separators', () => {
    expect(isSafeArtifactId('../evil')).toBe(false);
    expect(isSafeArtifactId('..')).toBe(false);
    expect(isSafeArtifactId('a/b')).toBe(false);
    expect(isSafeArtifactId('run:1')).toBe(false);
    expect(isSafeArtifactId('')).toBe(false);
  });
});
