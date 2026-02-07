type LogLevel = 'info' | 'warn' | 'error';

class Logger {
  private logLevel: LogLevel;

  constructor(logLevel: string = 'info') {
    this.logLevel = logLevel as LogLevel;
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
    const levels: LogLevel[] = ['info', 'warn', 'error'];
    const currentLevelIndex = levels.indexOf(this.logLevel);
    const messageLevelIndex = levels.indexOf(level);
    return messageLevelIndex >= currentLevelIndex;
  }
}

export const logger = new Logger(process.env.LOG_LEVEL);
