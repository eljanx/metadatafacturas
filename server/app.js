import express from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './config.js';
import { all, get } from './db.js';
import { getSettings, setSettings, effectiveModel } from './settings.js';
import { getSecret, setSecret, secretSource } from './secrets.js';
import * as repo from './repo.js';
import * as pipeline from './pipeline.js';
import * as drive from './drive.js';
import { hasApiKey } from './extractor.js';
import { scanAll, lastScanInfo } from './watcher.js';
import { buildWorkbook } from './export.js';
import { extractDriveFolderId, normalizeTaxId } from './util.js';
import { log, redact } from './log.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 32 * 1024 * 1024, files: 100 } });
const MIME = { 'application/pdf': 'application/pdf', 'image/jpeg': 'image/jpeg', 'image/png': 'image/png' };

function basicAuth(req, res, next) {
  if (!env.appPassword) return next();
  const [scheme, b64] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && b64) {
    const [u, ...p] = Buffer.from(b64, 'base64').toString().split(':');
    const a = Buffer.from(`${u}:${p.join(':')}`); const b = Buffer.from(`${env.appUser}:${env.appPassword}`);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Facturas"').status(401).send('Autenticación requerida');
}

// Los secretos nunca salen del backend: la API solo informa de si están configurados.
const secretsInfo = () => ({
  anthropic_api_key: { configured: !!getSecret('anthropic_api_key'), source: secretSource('anthropic_api_key') },
  google_client_id: { configured: !!getSecret('google_client_id'), source: secretSource('google_client_id') },
  google_client_secret: { configured: !!getSecret('google_client_secret'), source: secretSource('google_client_secret') },
});

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(basicAuth);
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });

  app.get('/api/state', wrap(async (req, res) => {
    const s = getSettings();
    res.json({
      anthropic: { configured: hasApiKey(), model: effectiveModel() },
      pharmacy_configured: !!s.pharmacy_tax_id,
      drive: await drive.status(),
      inbox_dir: s.inbox_dir, scan: lastScanInfo(), pending: get(`SELECT COUNT(*) n FROM invoices WHERE tech_status IN ('PENDIENTE','PROCESANDO')`).n,
    });
  }));

  app.get('/api/settings', (req, res) => res.json({ settings: getSettings(), secrets: secretsInfo(), model_default: env.model }));
  app.put('/api/settings', wrap((req, res) => {
    const patch = { ...req.body };
    for (const k of ['drive_inbox_folder', 'drive_processed_folder', 'drive_gestoria_folder']) {
      if (k in patch && patch[k]) { const id = extractDriveFolderId(patch[k]); if (!id) throw Object.assign(new Error('No se reconoce el enlace o ID de la carpeta de Drive.'), { status: 400 }); patch[k] = id; }
    }
    if ('pharmacy_tax_id' in patch) patch.pharmacy_tax_id = normalizeTaxId(patch.pharmacy_tax_id) || '';
    res.json({ settings: setSettings(patch) });
    pipeline.kick();
  }));
  app.put('/api/secrets', (req, res) => {
    for (const k of ['anthropic_api_key', 'google_client_id', 'google_client_secret']) {
      if (typeof req.body?.[k] === 'string') setSecret(k, req.body[k].trim());
    }
    res.json({ secrets: secretsInfo() });
    pipeline.kick();
  });

  // --- subida manual
  app.post('/api/invoices/upload', upload.array('files'), (req, res) => {
    const results = (req.files || []).map((f) => {
      try { const r = pipeline.ingest({ buffer: f.buffer, originalName: Buffer.from(f.originalname, 'latin1').toString('utf8'), source: 'upload' }); return { name: f.originalname, ok: true, invoice_id: r.invoiceId }; }
      catch (e) { return { name: f.originalname, ok: false, error: e.message }; }
    });
    res.json({ results, queued: hasApiKey() });
  });

  // --- facturas
  const filters = (q) => ({ review: q.review, tech: q.tech, category_id: q.category_id, supplier_id: q.supplier_id, from: q.from, to: q.to, q: q.q });
  app.get('/api/invoices', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200); const offset = Number(req.query.offset) || 0;
    res.json({ ...repo.listInvoices(filters(req.query), { limit, offset }), stats: repo.stats(filters(req.query)) });
  });
  app.get('/api/invoices/:id', (req, res) => { const i = repo.getInvoice(Number(req.params.id)); i ? res.json(i) : res.status(404).json({ error: 'No encontrada' }); });
  app.patch('/api/invoices/:id', wrap(async (req, res) => res.json(await pipeline.applyEdit(Number(req.params.id), req.body || {}))));
  app.post('/api/invoices/:id/reprocess', wrap((req, res) => { pipeline.reprocess(Number(req.params.id)); res.json({ ok: true, queued: hasApiKey() }); }));
  app.post('/api/invoices/:id/mark-reviewed', wrap(async (req, res) => res.json(await pipeline.markReviewed(Number(req.params.id)))));
  app.delete('/api/invoices/:id', wrap((req, res) => { pipeline.deleteInvoice(Number(req.params.id)); res.json({ ok: true }); }));

  // --- visor interno del documento original
  app.get('/api/files/:id/content', wrap(async (req, res) => {
    const f = get('SELECT * FROM files WHERE id = ?', Number(req.params.id));
    if (!f) return res.status(404).send('No encontrado');
    const p = [f.work_path, f.location].find((x) => x && !x.startsWith('drive:') && fs.existsSync(x));
    if (p) {
      res.set({ 'Content-Type': MIME[f.mime] || 'application/octet-stream', 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.processed_filename || f.original_filename)}` });
      return fs.createReadStream(p).pipe(res);
    }
    if (f.google_drive_file_id && f.document_url && !f.document_url.startsWith('/')) return res.redirect(f.document_url);
    res.status(404).send('El fichero ya no está en la ubicación registrada.');
  }));

  app.get('/api/categories', (req, res) => res.json(all('SELECT id, name FROM categories ORDER BY id')));
  app.get('/api/suppliers', (req, res) => res.json(repo.suppliersSummary()));
  app.get('/api/stats', (req, res) => res.json(repo.stats(filters(req.query))));
  app.post('/api/scan', wrap(async (req, res) => res.json(await scanAll())));

  // --- exportación a Excel
  const baseUrl = (req) => `${req.protocol}://${req.get('host')}`;
  const xlsxName = (q) => `facturas_${q.from || 'inicio'}_${q.to || new Date().toISOString().slice(0, 10)}.xlsx`;
  app.get('/api/export.xlsx', wrap(async (req, res) => {
    const wb = await buildWorkbook(filters(req.query), baseUrl(req));
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${xlsxName(req.query)}"` });
    await wb.xlsx.write(res); res.end();
  }));
  app.post('/api/export/drive', wrap(async (req, res) => {
    const folder = getSettings().drive_gestoria_folder;
    if (!folder || !drive.isConnected()) throw Object.assign(new Error('Conecta Google Drive y configura la carpeta de la gestoría.'), { status: 400 });
    const q = filters(req.body || {});
    const buf = Buffer.from(await (await buildWorkbook(q, baseUrl(req))).xlsx.writeBuffer());
    const f = await drive.uploadBuffer(buf, xlsxName(q), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', folder);
    res.json({ ok: true, url: f.webViewLink });
  }));

  // --- Google Drive (OAuth)
  app.get('/api/drive/auth-url', wrap((req, res) => res.json({ url: drive.authUrl(req) })));
  app.get('/api/drive/callback', wrap(async (req, res) => {
    if (req.query.error) return res.redirect('/?drive=error');
    await drive.handleCallback(req); res.redirect('/?drive=connected#config');
  }));
  app.post('/api/drive/disconnect', (req, res) => { drive.disconnect(); res.json({ ok: true }); });
  app.get('/api/drive/folders', wrap(async (req, res) => res.json(await drive.listFolders(String(req.query.parent || 'root')))));
  app.post('/api/drive/resolve-folder', wrap(async (req, res) => {
    const id = extractDriveFolderId(req.body?.input);
    if (!id) throw Object.assign(new Error('No se reconoce el enlace o ID de la carpeta.'), { status: 400 });
    res.json(await drive.getFolder(id));
  }));

  app.use(express.static(path.join(here, '..', 'public')));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) log.error(req.method, req.path, err);
    res.status(status).json({ error: redact(err.message || 'Error interno') });
  });
  return app;
}
