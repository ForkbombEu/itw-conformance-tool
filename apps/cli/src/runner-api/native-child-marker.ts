import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

/** Written by the native worker into the run workspace once the child is spawned. */
export const NATIVE_CHILD_MARKER = 'native-child.json';

const markerSchema = z.strictObject({
  /** Kernel boot ID when the child was spawned (Linux). */
  bootId: z.string().min(1).optional(),
  pid: z.number().int().positive(),
  /** Start time of the child in clock ticks since boot (/proc/<pid>/stat field 22, Linux). */
  processStartTicks: z.string().regex(/^\d+$/).optional(),
  startedAt: z.string()
});
export type NativeChildMarker = z.infer<typeof markerSchema>;

function readProcFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

export function currentBootId(): string | undefined {
  return readProcFile('/proc/sys/kernel/random/boot_id')?.trim() || undefined;
}

/** Start time of a live process in clock ticks since boot, or undefined if unknown/not running. */
export function processStartTicks(pid: number): string | undefined {
  const stat = readProcFile(`/proc/${pid}/stat`);
  if (!stat) return undefined;
  // The command name (field 2) may contain spaces/parentheses: parse after the last ')'.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = fields[19]; // field 22 overall
  return ticks && /^\d+$/.test(ticks) ? ticks : undefined;
}

/** Atomically records the native child's identity (pid + boot ID + process start time). */
export function writeNativeChildMarker(runRoot: string, pid: number, startedAt: string): void {
  const bootId = currentBootId();
  const startTicks = processStartTicks(pid);
  const marker: NativeChildMarker = {
    ...(bootId ? { bootId } : {}),
    pid,
    ...(startTicks ? { processStartTicks: startTicks } : {}),
    startedAt
  };
  const path = join(runRoot, NATIVE_CHILD_MARKER);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(marker), { mode: 0o600 });
  renameSync(tmp, path);
}

export type MarkerRead =
  { kind: 'absent' } | { kind: 'corrupt'; path: string; pid?: number } | { kind: 'ok'; marker: NativeChildMarker };

/**
 * Reads a run's marker without modifying it. For a corrupt marker the pid is
 * still extracted from the bytes when possible, so the caller can probe it
 * before quarantining.
 */
export function readNativeChildMarker(runRoot: string): MarkerRead {
  const path = join(runRoot, NATIVE_CHILD_MARKER);
  if (!existsSync(path)) return { kind: 'absent' };
  const text = readFileSync(path, 'utf-8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  const parsed = markerSchema.safeParse(raw);
  if (parsed.success) return { kind: 'ok', marker: parsed.data };
  const pid = Number(/"pid"\s*:\s*(\d+)/.exec(text)?.[1]);
  return { kind: 'corrupt', path, ...(Number.isInteger(pid) && pid > 0 ? { pid } : {}) };
}

/** Moves a corrupt marker aside (`.corrupt`) once it is known not to identify a live group. */
export function quarantineNativeChildMarker(path: string): string {
  const target = `${path}.corrupt`;
  renameSync(path, target);
  return target;
}

/** Removes a run's marker; only call once its native group is confirmed gone. */
export function removeNativeChildMarker(runRoot: string): void {
  rmSync(join(runRoot, NATIVE_CHILD_MARKER), { force: true });
}

export function processGroupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    // EPERM: the group exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether the native process group recorded by a marker is genuinely still
 * alive, avoiding false positives from pid reuse:
 * - a different boot ID means the machine rebooted: the group is gone;
 * - a live process with that pid but a different start time is an unrelated
 *   process reusing the pid (Linux never reuses a pid that is still the ID of
 *   an existing process group, so the old group is gone too);
 * - the leader alive with the recorded start time, or the leader gone while
 *   members of its group remain, means the old worker is still running.
 * Without identity data (non-Linux), fall back to the conservative group probe.
 */
export function isRecordedNativeGroupAlive(marker: NativeChildMarker): boolean {
  const bootId = currentBootId();
  if (marker.bootId && bootId && marker.bootId !== bootId) return false;
  const liveStart = processStartTicks(marker.pid);
  if (liveStart !== undefined && marker.processStartTicks !== undefined) {
    if (liveStart !== marker.processStartTicks) return false;
    return true;
  }
  return processGroupExists(marker.pid);
}
