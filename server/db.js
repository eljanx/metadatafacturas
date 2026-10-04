import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const CATEGORIES = [
  'Medicamentos', 'Parafarmacia', 'Productos sanitarios', 'Material farmacia', 'Telefonía',
  'Electricidad', 'Internet', 'Alquiler', 'Asesoría', 'Seguros', 'Software', 'Limpieza',
  'Mantenimiento', 'Otros servicios', 'Otros',
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY, name TEXT, trade_name TEXT, tax_id TEXT UNIQUE, address TEXT,
  postal_code TEXT, city TEXT, province TEXT, country TEXT, default_category_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  original_filename TEXT NOT NULL,
  processed_filename TEXT,
  source TEXT NOT NULL,              -- upload | folder | drive
  document_url TEXT,                 -- URL para abrir el original (Drive o visor interno)
  google_drive_file_id TEXT,
  hash TEXT NOT NULL,
  location TEXT,                     -- ruta local de archivo o drive:<carpeta>
  work_path TEXT,                    -- fichero local pendiente de archivar
  mime TEXT, size INTEGER, sync_error TEXT, gestoria_file_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
CREATE INDEX IF NOT EXISTS idx_files_drive ON files(google_drive_file_id);
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id),
  supplier_id INTEGER REFERENCES suppliers(id),
  tech_status TEXT NOT NULL DEFAULT 'PENDIENTE',   -- PENDIENTE|PROCESANDO|PROCESADO|ERROR|POSIBLE_DUPLICADO
  review_status TEXT,                              -- OK_IA|CONVIENE_REVISAR|VALIDADA_MANUALMENTE
  review_reason TEXT, review_reasons TEXT,         -- texto y JSON array
  doc_type TEXT, invoice_number TEXT, series TEXT,
  invoice_date TEXT, operation_date TEXT, due_date TEXT, rectified_invoice TEXT,
  customer_name TEXT, customer_tax_id TEXT, customer_address TEXT,
  currency TEXT, base_total REAL, discounts_total REAL, vat_total REAL, re_total REAL,
  other_taxes_total REAL, withholdings_total REAL, total REAL,
  payment_method TEXT, iban TEXT, installments INTEGER,
  concept TEXT, category_id INTEGER REFERENCES categories(id),
  confidence_overall REAL, field_meta TEXT,        -- JSON {campo:{confidence,evidence,requires_review}}
  pharmacy_match INTEGER, duplicate_of INTEGER, error_message TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_inv_status ON invoices(tech_status, review_status);
CREATE INDEX IF NOT EXISTS idx_inv_date ON invoices(invoice_date);
CREATE TABLE IF NOT EXISTS invoice_taxes (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  vat_rate REAL, base REAL, vat_amount REAL, re_rate REAL, re_amount REAL
);
CREATE TABLE IF NOT EXISTS invoice_lines (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position INTEGER, description TEXT, reference TEXT, quantity REAL, unit_price REAL,
  discount REAL, base REAL, vat_rate REAL, re_amount REAL, total REAL
);
CREATE TABLE IF NOT EXISTS processing_results (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  model TEXT, effort TEXT, prompt_version TEXT, structured_output INTEGER,
  raw_json TEXT, validations TEXT, review_status TEXT, confidence_overall REAL,
  input_tokens INTEGER, output_tokens INTEGER, duration_ms INTEGER, error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS invoice_edits (
  id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  field TEXT, old_value TEXT, new_value TEXT, note TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`;

export function openDb(file = path.join(DATA_DIR, 'facturas.db')) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT OR IGNORE INTO categories(name) VALUES (?)');
  for (const c of CATEGORIES) ins.run(c);
  return db;
}

let current = null;
export function db() { return (current ??= openDb()); }
export function useDb(instance) { current = instance; }

export const all = (sql, ...p) => db().prepare(sql).all(...p);
export const get = (sql, ...p) => db().prepare(sql).get(...p);
export const run = (sql, ...p) => db().prepare(sql).run(...p);
export function tx(fn) {
  db().exec('BEGIN');
  try { const r = fn(); db().exec('COMMIT'); return r; } catch (e) { db().exec('ROLLBACK'); throw e; }
}
