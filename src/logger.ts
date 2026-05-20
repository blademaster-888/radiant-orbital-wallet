const DEBUG = process.env.REACT_APP_DEBUG === 'true'

/* eslint-disable no-console */
export const logger = {
  log:   (...args: unknown[]) => { if (DEBUG) console.log(...args) },
  debug: (...args: unknown[]) => { if (DEBUG) console.debug(...args) },
  warn:  (...args: unknown[]) => { if (DEBUG) console.warn(...args) },
  error: (...args: unknown[]) => { if (DEBUG) console.error(...args) },
}
