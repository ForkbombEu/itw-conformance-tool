import { describe, expect, it } from 'vitest';

import { ArtifactStore, isSafeArtifactId } from '../../runner-api/artifacts.js';

describe('ArtifactStore', () => {
  it('registers and retrieves', () => {
    const store = new ArtifactStore();
    store.register('run1:art1', 'test.json', 'application/json', Buffer.from('hello'));
    const record = store.get('run1:art1');
    expect(record?.filename).toBe('test.json');
    expect(record?.sizeBytes).toBe(5);
  });

  it('computes sha256', () => {
    const store = new ArtifactStore();
    store.register('run1:art1', 't.json', 'application/json', Buffer.from('hello world'));
    expect(store.get('run1:art1')?.sha256).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('lists artifacts for a run', () => {
    const store = new ArtifactStore();
    store.register('run1:a', 'a.json', 'application/json', Buffer.from('a'));
    store.register('run1:b', 'b.json', 'application/json', Buffer.from('b'));
    store.register('run2:a', 'c.json', 'application/json', Buffer.from('c'));
    expect(store.list('run1')).toHaveLength(2);
    expect(store.list('run2')).toHaveLength(1);
  });
});

describe('isSafeArtifactId', () => {
  it('accepts safe IDs', () => {
    expect(isSafeArtifactId('run1:art1')).toBe(true);
    expect(isSafeArtifactId('abc-def_123')).toBe(true);
  });

  it('rejects traversal', () => {
    expect(isSafeArtifactId('../evil')).toBe(false);
    expect(isSafeArtifactId('..')).toBe(false);
    expect(isSafeArtifactId('a/b')).toBe(false);
    expect(isSafeArtifactId('')).toBe(false);
  });
});
