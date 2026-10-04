import { all, run } from './db.js';
import { env } from './config.js';

// Definición de ajustes de negocio editables desde la pantalla Configuración.
const DEFS = {
  pharmacy_legal_name: { t: 's', d: '' },
  pharmacy_trade_name: { t: 's', d: '' },
  pharmacy_tax_id: { t: 's', d: '' },
  pharmacy_address: { t: 's', d: '' },
  pharmacy_postal_code: { t: 's', d: '' },
  pharmacy_city: { t: 's', d: '' },
  pharmacy_province: { t: 's', d: '' },
  pharmacy_recargo: { t: 'b', d: false },        // la farmacia está en recargo de equivalencia
  ok_threshold: { t: 'n', d: 0.95, min: 0.5, max: 1 },   // media mínima de campos críticos para OK IA
  critical_min: { t: 'n', d: 0.9, min: 0.5, max: 1 },    // mínimo individual por campo crítico
  anthropic_model: { t: 's', d: '' },            // vacío = ANTHROPIC_MODEL / valor por defecto
  inbox_dir: { t: 's', d: '' },
  archive_dir: { t: 's', d: '' },
  drive_inbox_folder: { t: 's', d: '' },         // ID de carpeta
  drive_processed_folder: { t: 's', d: '' },
  drive_gestoria_folder: { t: 's', d: '' },
  drive_mirror: { t: 'b', d: true },             // subir a Drive también lo subido en local
  drive_gestoria_mode: { t: 's', d: 'all', enum: ['all', 'ok_only'] },
};

export function getSettings() {
  const out = {};
  for (const [k, d] of Object.entries(DEFS)) out[k] = d.d;
  for (const r of all('SELECT key, value FROM settings')) {
    const d = DEFS[r.key];
    if (!d) continue;
    out[r.key] = d.t === 'b' ? r.value === '1' : d.t === 'n' ? Number(r.value) : r.value;
  }
  return out;
}
export const getSetting = (k) => getSettings()[k];
export const effectiveModel = () => getSetting('anthropic_model') || env.model;

export function setSettings(patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    const d = DEFS[k];
    if (!d) continue;
    let val;
    if (d.t === 'b') val = v === true || v === '1' || v === 'true' ? '1' : '0';
    else if (d.t === 'n') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < d.min || n > d.max) throw new Error(`Valor no válido para ${k}`);
      val = String(n);
    } else {
      val = String(v ?? '').trim();
      if (d.enum && !d.enum.includes(val)) throw new Error(`Valor no válido para ${k}`);
    }
    run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, val);
  }
  return getSettings();
}
