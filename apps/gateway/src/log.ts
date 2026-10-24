// JSON-lines logger that redacts credentials from every line before it is written.
// Hard rule (CHUNK-2-GATEWAY.md): never log mandate tokens.
import type { Clock } from './clock.js';

export interface LogSink {
  write(line: string): void;
}

export type LogFields = Record<string, unknown>;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

export const stdoutSink: LogSink = { write: (line) => process.stdout.write(`${line}\n`) };

const BEARER = /\bbearer\s+[^\s"',]+/gi;
// A mandate token is 32 random bytes in base64url: exactly 43 characters.
const TOKEN_SHAPED = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g;
const REDACTED = '[redacted]';

/** Errors serialize to {} by default; keep their name and message (never a stack). */
function errorsAsObjects(_key: string, value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message } : value;
}

export function createLogger(
  sink: LogSink,
  opts: { clock: Clock; secrets?: readonly string[] },
): Logger {
  // Match secrets both as written and as JSON-escaped inside the serialized line.
  const secrets = (opts.secrets ?? [])
    .filter((secret) => secret.length > 0)
    .flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]);

  const redact = (line: string): string => {
    let out = line;
    for (const secret of secrets) out = out.split(secret).join(REDACTED);
    return out.replace(BEARER, `Bearer ${REDACTED}`).replace(TOKEN_SHAPED, REDACTED);
  };

  const emit = (level: 'info' | 'warn' | 'error', msg: string, fields: LogFields = {}) => {
    const line = JSON.stringify({ level, at: opts.clock.now(), msg, ...fields }, errorsAsObjects);
    sink.write(redact(line));
  };

  return {
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
  };
}
