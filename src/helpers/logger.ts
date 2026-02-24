export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR',
};

function parseLogLevel(value: string | undefined): LogLevel {
  switch (value?.toUpperCase()) {
    case 'DEBUG': return LogLevel.DEBUG;
    case 'WARN': return LogLevel.WARN;
    case 'ERROR': return LogLevel.ERROR;
    case 'INFO':
    default: return LogLevel.INFO;
  }
}

export class Logger {
  private minLevel: LogLevel;
  private context: string;

  constructor(context: string, level?: LogLevel) {
    this.context = context;
    this.minLevel = level ?? parseLogLevel(process.env.LOG_LEVEL);
  }

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (level < this.minLevel) return;

    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level: LOG_LEVEL_NAMES[level],
      context: this.context,
      message,
    };

    if (meta && Object.keys(meta).length > 0) {
      entry.meta = meta;
    }

    const output = JSON.stringify(entry);

    if (level >= LogLevel.ERROR) {
      process.stderr.write(output + '\n');
    } else {
      process.stdout.write(output + '\n');
    }
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, message, meta);
  }

  child(context: string): Logger {
    return new Logger(`${this.context}:${context}`, this.minLevel);
  }
}

export const logger = new Logger('mega-bridge');
