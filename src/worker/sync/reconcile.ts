import type { ProgressRecord } from './types'

/**
 * Progress reconciliation between local state and a remote server.
 * Pure and exhaustively unit-tested — this decides data movement.
 *
 * Model (after the Android app's reconcileReadingState, simplified to one
 * comparison we can make locally): the sync_queue marks LOCALLY dirty books;
 * remote `updatedAt` newer than local marks remote change. Within a small
 * progression tolerance (epsilon), positions are considered equal.
 */

export type ReconcileAction =
  | 'none' // nothing to do
  | 'push' // only local changed (or local strictly newer): send to server
  | 'pull' // only remote changed: adopt remote position locally
  | 'conflict' // BOTH changed and positions diverge: preserve for the user
  | 'adopt-status' // remote has completion status but no position to adopt

export const PROGRESSION_EPSILON = 0.005

export function reconcileProgress(
  local: ProgressRecord | null,
  remote: ProgressRecord | null,
  localDirty: boolean,
  epsilon: number = PROGRESSION_EPSILON,
): ReconcileAction {
  if (!local && !remote) return 'none'
  if (!local) {
    return remote?.progression !== undefined || remote?.completed ? 'pull' : 'none'
  }
  if (!remote) return 'push'

  const lp = local.progression ?? (local.completed ? 1 : 0)
  const rp = remote.progression ?? (remote.completed ? 1 : 0)
  const diverged = Math.abs(lp - rp) > epsilon

  // Remote finished the book but carries no position to adopt.
  if (remote.completed && remote.progression === undefined && !local.completed) {
    return 'adopt-status'
  }
  if (!diverged) return 'none'

  const localAt = local.updatedAt ?? 0
  const remoteAt = remote.updatedAt ?? 0
  const remoteChanged = remoteAt > localAt

  if (localDirty && remoteChanged) return 'conflict'
  if (localDirty) return 'push'
  if (remoteChanged) return 'pull'
  return 'push' // local is newer-or-equal and dirty-free: converge upward
}

/**
 * Strips a reading position's date when it claims to be in the future.
 *
 * Servers date positions with whatever clock wrote them, and a phone that
 * is an hour fast produces a position dated an hour from now. Such a date
 * beats every real position until the clock catches up: the book sticks to
 * the Continue Reading banner, and the stale position it carries wins
 * against the page you are actually on.
 *
 * The date is dropped rather than pulled back to now, because pulling it
 * back to now would make it beat everything you read a moment ago — the
 * same bug wearing a smaller number. A position nobody can date must not
 * outrank one we can; ours then goes up to the server and settles it.
 */
export function withSaneTimestamp<T extends { updatedAt?: number | undefined }>(
  record: T | null,
  now = Date.now(),
): T | null {
  if (!record || record.updatedAt === undefined || record.updatedAt <= now) return record
  return { ...record, updatedAt: undefined }
}
