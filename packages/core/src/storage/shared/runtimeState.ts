/**
 * The agent runtime's state (T-185, D-054), written once against `Backend` so
 * the in-memory and SQLite stores behave the same: namespaced entries, bounded
 * seen-key sets and the scheduler's job queue.
 */
import { TravError } from '../../errors.js';
import type {
  RuntimeStateEntry,
  RuntimeStateRepository,
  SeenKeyStore,
} from '../../repositories.js';
import type { Backend, Where } from './backend.js';
import { runtimeStateKey, runtimeStateSpec, scheduledJobsSpec, seenKeysSpec } from './schema.js';
import { requireId } from './util.js';

/** `null` (runtime-wide) or a non-empty group id. */
export function requireGroupScope(groupId: unknown): string | null {
  return groupId === null ? null : requireId(groupId, 'groupId');
}

export function requireKey(key: unknown): string {
  if (typeof key !== 'string') {
    throw new TravError('invalid_argument', 'runtime state key must be a string');
  }
  return key;
}

export function requireEntry(entry: RuntimeStateEntry): void {
  requireId(entry.namespace, 'namespace');
  requireGroupScope(entry.groupId);
  requireKey(entry.key);
  if (entry.value === undefined) {
    throw new TravError('invalid_argument', 'runtime state value must be JSON (not undefined)', {
      namespace: entry.namespace,
    });
  }
}

/** `{ tripId }` when the entry is tied to a trip, else nothing (a read gives back what was put). */
export function tripPart(entry: RuntimeStateEntry): { tripId?: string } {
  if (entry.tripId === undefined || entry.tripId === null) return {};
  return { tripId: requireId(entry.tripId, 'tripId') };
}

export function createRuntimeStateRepository(backend: Backend): RuntimeStateRepository {
  const state = backend.table(runtimeStateSpec);
  const seen = backend.table(seenKeysSpec);
  const jobs = backend.table(scheduledJobsSpec);

  const listWhere = (namespace: string, groupId: string | null | undefined): Where =>
    groupId === undefined
      ? { state_ns: namespace }
      : { state_ns: namespace, group_id: requireGroupScope(groupId) };

  return {
    put(entry) {
      requireEntry(entry);
      state.upsert({
        namespace: entry.namespace,
        groupId: entry.groupId,
        ...tripPart(entry),
        key: entry.key,
        value: entry.value,
      });
    },
    get(namespace, groupId, key) {
      requireId(namespace, 'namespace');
      return state.get(runtimeStateKey(namespace, requireGroupScope(groupId), requireKey(key)));
    },
    list(namespace, opts) {
      requireId(namespace, 'namespace');
      return state.find(listWhere(namespace, opts?.groupId));
    },
    delete(namespace, groupId, key) {
      requireId(namespace, 'namespace');
      return state.deleteKey(
        runtimeStateKey(namespace, requireGroupScope(groupId), requireKey(key)),
      );
    },

    seenKeys(namespace, cap): SeenKeyStore {
      requireId(namespace, 'namespace');
      if (!Number.isSafeInteger(cap) || cap < 1) {
        throw new TravError('invalid_argument', 'seen-key cap must be a positive integer', { cap });
      }
      const where: Where = { state_ns: namespace };
      return {
        has(key) {
          return seen.get(seenKeysSpec.key({ namespace, key: requireKey(key) })) !== undefined;
        },
        add(key) {
          const row = { namespace, key: requireKey(key) };
          backend.transaction(() => {
            if (seen.get(seenKeysSpec.key(row)) !== undefined) return;
            seen.insert(row);
            while (seen.count(where) > cap) {
              const oldest = seen.first(where);
              if (oldest === undefined) break;
              seen.deleteKey(seenKeysSpec.key(oldest));
            }
          });
        },
      };
    },

    deleteSeenKeys(namespace, prefix) {
      requireId(namespace, 'namespace');
      requireId(prefix, 'prefix');
      return backend.transaction(() => {
        let n = 0;
        for (const row of seen.find({ state_ns: namespace })) {
          if (row.key.startsWith(prefix) && seen.deleteKey(seenKeysSpec.key(row))) n += 1;
        }
        return n;
      });
    },

    putJob(job) {
      requireId(job.jobId, 'jobId');
      // Delete then insert: a re-scheduled job moves to the back of the
      // scheduling order, like the in-memory scheduler's `Map` delete + set.
      backend.transaction(() => {
        jobs.deleteKey(job.jobId);
        jobs.insert(job);
      });
    },
    deleteJob(jobId) {
      jobs.deleteKey(jobId);
    },
    listJobs: () => jobs.find({}),
  };
}
