export type Logger = {
  info(message: string): void;
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  withAccount(accountId: string): Logger;
};

function write(level: string, message: string, accountId?: string): void {
  const prefix = accountId ? `[weixin-openclaw-bridge][${level}][${accountId}]` : `[weixin-openclaw-bridge][${level}]`;
  process.stderr.write(`${prefix} ${message}\n`);
}

function createLogger(accountId?: string): Logger {
  return {
    info(message: string) {
      write("info", message, accountId);
    },
    debug(message: string) {
      write("debug", message, accountId);
    },
    warn(message: string) {
      write("warn", message, accountId);
    },
    error(message: string) {
      write("error", message, accountId);
    },
    withAccount(id: string) {
      return createLogger(id);
    },
  };
}

export const logger: Logger = createLogger();
