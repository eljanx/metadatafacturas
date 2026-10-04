import fs from 'node:fs';
import path from 'node:path';
import { env } from './config.js';
import { get } from './db.js';
import { getSettings } from './settings.js';
import { ingest } from './pipeline.js';
import * as drive from './drive.js';
import { log, redact } from './log.js';

// Un navegador no puede vigilar carpetas locales, pero el backend sí: sondea la carpeta configurada
// (la del PC/servidor donde corre la app) y, si Drive está conectado, la carpeta de entrada de Drive.
const EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png']);
const skipped = new Map(); // ruta -> mtime ya descartada (no se vuelve a loguear)
let scanning = false;
const lastScan = { at: null, local: 0, drive: 0, error: null };

export async function scanLocal() {
  const dir = getSettings().inbox_dir;
  if (!dir) return 0;
  if (!fs.existsSync(dir)) throw new Error(`La carpeta de entrada «${dir}» no existe.`);
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || e.name.startsWith('.') || !EXT.has(path.extname(e.name).toLowerCase())) continue;
    const full = path.join(dir, e.name);
    const st = fs.statSync(full);
    if (Date.now() - st.mtimeMs < 3000) continue; // aún se está copiando
    if (skipped.get(full) === st.mtimeMs) continue;
    if (get('SELECT 1 FROM files WHERE work_path = ?', full)) continue; // ya registrado y pendiente
    try { ingest({ buffer: fs.readFileSync(full), originalName: e.name, source: 'folder', workPath: full }); n++; }
    catch (err) { skipped.set(full, st.mtimeMs); log.warn(err.message); }
  }
  return n;
}

export async function scanDrive() {
  const cfg = getSettings();
  if (!cfg.drive_inbox_folder || !drive.isConnected()) return 0;
  let n = 0;
  for (const f of await drive.listInboxFiles(cfg.drive_inbox_folder)) {
    if (get('SELECT 1 FROM files WHERE google_drive_file_id = ?', f.id)) continue;
    try {
      ingest({ buffer: await drive.downloadFile(f.id), originalName: f.name, source: 'drive', driveFileId: f.id, driveUrl: f.webViewLink });
      n++;
    } catch (err) { log.warn(`Drive «${f.name}»: ${redact(err.message)}`); }
  }
  return n;
}

export async function scanAll() {
  if (scanning) return lastScan;
  scanning = true; lastScan.error = null;
  try {
    lastScan.local = await scanLocal().catch((e) => { lastScan.error = e.message; return 0; });
    lastScan.drive = await scanDrive().catch((e) => { lastScan.error = redact(e.message); return 0; });
    lastScan.at = new Date().toISOString();
  } finally { scanning = false; }
  return lastScan;
}
export const lastScanInfo = () => lastScan;

export function startWatcher() {
  const tick = () => scanAll().catch((e) => log.error('scan', e));
  setTimeout(tick, 2000);
  return setInterval(tick, Math.max(5, env.pollSeconds) * 1000);
}
