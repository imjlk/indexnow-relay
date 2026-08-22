export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const REDACT_PATTERN = /key|token|secret|password|authorization/i

/**
 * Structured JSON logger (one object per line on stdout).
 *
 * Every field passes through `redact()`: anything whose key smells like a
 * secret is replaced with `[redacted]`, so IndexNow keys and bearer tokens
 * can never leak into logs even if a call site is careless.
 */
export class Logger {
  readonly #level: LogLevel
  readonly #bindings: Record<string, unknown>

  constructor(level: LogLevel = 'info', bindings: Record<string, unknown> = {}) {
    this.#level = level
    this.#bindings = bindings
  }

  static fromEnv(defaultLevel: LogLevel = 'info'): Logger {
    const raw = process.env['LOG_LEVEL']?.toLowerCase()
    const level = raw !== undefined && raw in LEVEL_WEIGHT ? (raw as LogLevel) : defaultLevel
    return new Logger(level)
  }

  child(bindings: Record<string, unknown>): Logger {
    return new Logger(this.#level, { ...this.#bindings, ...bindings })
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.#log('debug', message, fields)
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.#log('info', message, fields)
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.#log('warn', message, fields)
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.#log('error', message, fields)
  }

  #log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level]! < LEVEL_WEIGHT[this.#level]!) return

    const entry: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...redact(this.#bindings),
      ...(fields === undefined ? {} : redact(fields)),
    }

    const line = JSON.stringify(entry)
    if (level === 'error') {
      process.stderr.write(line + '\n')
    } else {
      process.stdout.write(line + '\n')
    }
  }
}

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    out[key] = REDACT_PATTERN.test(key) ? '[redacted]' : value
  }
  return out
}
