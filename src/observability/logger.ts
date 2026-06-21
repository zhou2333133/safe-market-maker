import { redact, redactString } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export class Logger {
  constructor(
    private readonly minLevel: LogLevel = 'info',
    private readonly sink: Pick<Console, 'log' | 'error'> = console
  ) {}

  debug(message: string, context?: unknown): void {
    this.emit('debug', message, context);
  }

  info(message: string, context?: unknown): void {
    this.emit('info', message, context);
  }

  warn(message: string, context?: unknown): void {
    this.emit('warn', message, context);
  }

  error(message: string, context?: unknown): void {
    this.emit('error', message, context);
  }

  private emit(level: LogLevel, message: string, context?: unknown): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      message: redactString(message),
      context: context === undefined ? undefined : redact(context)
    };
    const line = JSON.stringify(entry);
    if (level === 'error') this.sink.error(line);
    else this.sink.log(line);
  }
}

export const logger = new Logger();
