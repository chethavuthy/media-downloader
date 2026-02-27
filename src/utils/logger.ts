type LogLevel = 'info' | 'warn' | 'error';

const LEVELS: LogLevel[] = ['info', 'warn', 'error'];

export class Logger {
  private logLevel: LogLevel;

  constructor(logLevel: string = 'info') {
    this.logLevel = (LEVELS.includes(logLevel as LogLevel) ? logLevel : 'info') as LogLevel;
  }

  /** Update the log level at runtime (used after dotenv has been loaded). */
  setLevel(logLevel: string): void {
    this.logLevel = (LEVELS.includes(logLevel as LogLevel) ? logLevel : 'info') as LogLevel;
  }

  private formatMessage(level: string, message: string): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  }

  info(message: string): void {
    if (this.shouldLog('info')) {
      console.log(this.formatMessage('info', message));
    }
  }

  warn(message: string): void {
    if (this.shouldLog('warn')) {
      console.warn(this.formatMessage('warn', message));
    }
  }

  error(message: string, error?: Error): void {
    if (this.shouldLog('error')) {
      const errorMessage = error ? `${message}: ${error.message}` : message;
      console.error(this.formatMessage('error', errorMessage));
      if (error?.stack) {
        console.error(error.stack);
      }
    }
  }

  private shouldLog(level: LogLevel): boolean {
    const currentLevelIndex = LEVELS.indexOf(this.logLevel);
    const messageLevelIndex = LEVELS.indexOf(level);
    return messageLevelIndex >= currentLevelIndex;
  }
}

// The logger is created with a default level of 'info'. It is reconfigured
// at startup in index.ts (after dotenv has been loaded) via logger.setLevel().
// This prevents LOG_LEVEL being silently ignored when set in .env.
export const logger = new Logger('info');
