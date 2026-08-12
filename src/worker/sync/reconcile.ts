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
