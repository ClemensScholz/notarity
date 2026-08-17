const STORAGE_KEY = 'notarity-error-log'
const MAX_ENTRIES = 20

export interface LoggedError {
  timestamp: string
  source: string
  message: string
  stack: string | null
  userAgent: string
}

function readLog(): LoggedError[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as LoggedError[]) : []
  } catch {
    return []
  }
}

function writeLog(entries: LoggedError[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // storage full/unavailable — nothing more we can do
  }
}

/** Records an error to a small persistent log (survives reloads), so
 * failures can be inspected without dev tools already being open when they
 * happen — e.g. for Safari sessions where the console doesn't show errors
 * caught by our own React error boundaries or effect .catch() handlers. */
export function logError(source: string, err: unknown) {
  const entry: LoggedError = {
    timestamp: new Date().toISOString(),
    source,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? (err.stack ?? null) : null,
    userAgent: navigator.userAgent,
  }
  const entries = [entry, ...readLog()].slice(0, MAX_ENTRIES)
  writeLog(entries)
}

export function getErrorLog(): LoggedError[] {
  return readLog()
}

export function clearErrorLog() {
  writeLog([])
}

export function installGlobalErrorLogging() {
  window.addEventListener('error', (e) => {
    logError('window.onerror', e.error ?? e.message)
  })
  window.addEventListener('unhandledrejection', (e) => {
    logError('unhandledrejection', e.reason)
  })
}
