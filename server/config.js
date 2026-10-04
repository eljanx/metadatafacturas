import fs from 'node:fs';
import path from 'node:path';

// Configuración técnica (variables de entorno). Los ajustes de negocio viven en la BD (settings.js)
// y los secretos en data/secrets.json (secrets.js) o en variables de entorno.
export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const env = {
  port: Number(process.env.PORT || 3000),
  // Por seguridad escucha solo en local. Cambia HOST=0.0.0.0 únicamente detrás de APP_PASSWORD/HTTPS.
  host: process.env.HOST || '127.0.0.1',
  model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
  effort: process.env.ANTHROPIC_EFFORT || 'medium',
  concurrency: Number(process.env.MAX_CONCURRENCY || 2),
  pollSeconds: Number(process.env.POLL_INTERVAL_SEC || 30),
  appUser: process.env.APP_USER || 'farmacia',
  appPassword: process.env.APP_PASSWORD || '',
  googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || '',
};
