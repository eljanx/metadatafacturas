import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

// Los secretos solo existen en backend: variables de entorno o data/secrets.json (permisos 600).
// Nunca se devuelven al frontend (solo "configurada: sí/no").
const FILE = path.join(DATA_DIR, 'secrets.json');
const ENV_MAP = {
  anthropic_api_key: 'ANTHROPIC_API_KEY',
  google_client_id: 'GOOGLE_CLIENT_ID',
  google_client_secret: 'GOOGLE_CLIENT_SECRET',
};
export const SECRET_KEYS = Object.keys(ENV_MAP);

function readFile() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}
export function getSecret(key) {
  const fromEnv = process.env[ENV_MAP[key]];
  if (fromEnv) return fromEnv;
  return readFile()[key] || '';
}
export function secretSource(key) {
  if (process.env[ENV_MAP[key]]) return 'env';
  return readFile()[key] ? 'stored' : null;
}
export function setSecret(key, value) {
  if (!(key in ENV_MAP) && key !== 'google_tokens') throw new Error('Secreto desconocido');
  const data = readFile();
  if (value === null || value === '') delete data[key]; else data[key] = value;
  fs.writeFileSync(FILE, JSON.stringify(data), { mode: 0o600 });
  fs.chmodSync(FILE, 0o600);
}
export const getJsonSecret = (key) => readFile()[key] || null;
