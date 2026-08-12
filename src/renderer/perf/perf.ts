/**
 * Development-only performance instrumentation.
 *
 * Enabled with `LISEUR_PERF=1` in the environment (dev) or
 * localStorage.liseurPerf = '1' (any build). Records named timings against
 * performance.now() and reports long tasks (>50 ms). Zero overhead when off:
 * every call site checks `perf.enabled` first.
 */

const enabled =
  typeof window !== 'undefined' &&
  (localStorage.getItem('liseurPerf') === '1' ||
    (import.meta as ImportMeta & { env?: Record<string, string> }).env?.VITE_LISEUR_PERF === '1')

function now(): number {
  return performance.now()
}

function log(...args: unknown[]): void {
  if (enabled) console.log('[perf]', ...args)
}

/** Mark a point in time; returns a function that logs the elapsed time. */
export function mark(label: string): () => void {
  if (!enabled) return () => {}
  const start = now()
  return () => log(`${label}: ${(now() - start).toFixed(1)}ms`)
}

export const perf = {
  enabled,
  mark,
  log,
}

/** Warn about long tasks blocking the main thread. Dev builds only. */
export function observeLongTasks(): void {
  if (!enabled) return
  if (typeof PerformanceObserver === 'undefined') return
  try {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        log(`long task: ${entry.duration.toFixed(0)}ms`)
      }
    })
    observer.observe({ entryTypes: ['longtask'] })
  } catch {
    // longtask not supported — fine, instrumentation is best-effort.
  }
}
