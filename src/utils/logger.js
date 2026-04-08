const levels = { info: '→', success: '✓', warn: '⚠', error: '✗', step: '·' };

function log(level, msg, data = null) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const prefix = levels[level] || '·';
  const line = `[${ts}] ${prefix} ${msg}`;
  if (level === 'error') {
    console.error(line);
    if (data) console.error(data);
  } else {
    console.log(line);
    if (data) console.log(data);
  }
}

export const logger = {
  info:    (msg, data) => log('info', msg, data),
  success: (msg, data) => log('success', msg, data),
  warn:    (msg, data) => log('warn', msg, data),
  error:   (msg, data) => log('error', msg, data),
  step:    (msg, data) => log('step', msg, data),
};
