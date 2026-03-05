const winston = require('winston');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Create logs directory if it doesn't exist
const logsDir = path.join(app.getPath('userData'), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    // Collect extra metadata fields (everything except the standard winston fields)
    const ignoredKeys = new Set(['timestamp', 'level', 'message', 'stack', 'service', 'splat']);
    const metaEntries = Object.entries(meta).filter(([k]) => !ignoredKeys.has(k));
    const metaStr = metaEntries.length > 0
      ? ' ' + JSON.stringify(Object.fromEntries(metaEntries))
      : '';

    if (stack) {
      return `${timestamp} [${level.toUpperCase()}]: ${message}${metaStr}\n${stack}`;
    }
    return `${timestamp} [${level.toUpperCase()}]: ${message}${metaStr}`;
  })
);

// Create logger instance
const logger = winston.createLogger({
  level: 'info',
  format: logFormat,
  transports: [
    // File transport with rotation
    new winston.transports.File({
      filename: path.join(logsDir, 'app.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      tailable: true
    }),
    // Separate file for errors
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5242880, // 5MB
      maxFiles: 5,
      tailable: true
    })
  ]
});

// Add console transport in development
if (process.env.NODE_ENV !== 'production') {
  logger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  );
}

// Helper methods
logger.logInfo = (message, meta = {}) => {
  logger.info(message, meta);
};

logger.logError = (message, error = null, meta = {}) => {
  if (error) {
    logger.error(message, { ...meta, error: error.message, stack: error.stack });
  } else {
    logger.error(message, meta);
  }
};

logger.logWarning = (message, meta = {}) => {
  logger.warn(message, meta);
};

logger.logDebug = (message, meta = {}) => {
  logger.debug(message, meta);
};

// Log startup
logger.info('Logger initialized', { logsDir });

module.exports = logger;
