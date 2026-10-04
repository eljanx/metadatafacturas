import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { OAuth2Client } from 'google-auth-library';
import { drive as driveApi } from '@googleapis/drive';
import { env } from './config.js';
import { getSecret, getJsonSecret, setSecret } from './secrets.js';
import { extractDriveFolderId, isGoogleClientId } from './util.js';

export { extractDriveFolderId };
const SCOPES = ['https://www.googleapis.com/auth/drive'];
const MIME_OK = ['application/pdf', 'image/jpeg', 'image/png'];

export const isConfigured = () => !!(getSecret('google_client_id') && getSecret('google_client_secret'));
export const isConnected = () => isConfigured() && !!getJsonSecret('google_tokens')?.refresh_token;

const redirectUri = (req) => env.googleRedirectUri || `${req.protocol}://${req.get('host')}/api/drive/callback`;
function oauth(redirect) {
  const c = new OAuth2Client(getSecret('google_client_id'), getSecret('google_client_secret'), redirect);
  const tokens = getJsonSecret('google_tokens');
  if (tokens) c.setCredentials(tokens);
  c.on('tokens', (t) => setSecret('google_tokens', { ...(getJsonSecret('google_tokens') || {}), ...t }));
  return c;
}
const states = new Map();
export function authUrl(req) {
  if (!isConfigured()) throw new Error('Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.');
  if (!isGoogleClientId(getSecret('google_client_id'))) throw new Error('El Client ID guardado no tiene el formato de Google (123456789-xxxx.apps.googleusercontent.com): corrígelo en Configuración.');
  const state = crypto.randomBytes(16).toString('hex');
  states.set(state, Date.now());
  for (const [s, t] of states) if (Date.now() - t > 10 * 60e3) states.delete(s);
  return oauth(redirectUri(req)).generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state });
}
export async function handleCallback(req) {
  const { code, state } = req.query;
  if (!state || !states.delete(state)) throw new Error('Estado OAuth no válido o caducado.');
  const { tokens } = await oauth(redirectUri(req)).getToken(String(code));
  setSecret('google_tokens', tokens);
}
export const disconnect = () => setSecret('google_tokens', null);

const api = () => driveApi({ version: 'v3', auth: oauth(redirectUri({ protocol: 'http', get: () => `localhost:${env.port}` })) });

export async function status() {
  if (!isConnected()) return { configured: isConfigured(), connected: false };
  try {
    const { data } = await api().about.get({ fields: 'user(emailAddress,displayName)' });
    return { configured: true, connected: true, user: data.user?.emailAddress || data.user?.displayName };
  } catch (e) { return { configured: true, connected: false, error: 'La conexión con Google ha caducado: vuelve a conectar.' }; }
}

export async function getFolder(id) {
  const { data } = await api().files.get({ fileId: id, fields: 'id,name,mimeType,webViewLink', supportsAllDrives: true });
  if (data.mimeType !== 'application/vnd.google-apps.folder') throw new Error('El enlace no es una carpeta de Google Drive.');
  return { id: data.id, name: data.name, url: data.webViewLink };
}
export async function listFolders(parent = 'root') {
  const { data } = await api().files.list({
    q: `'${parent.replace(/'/g, '')}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id,name)', orderBy: 'name', pageSize: 200, supportsAllDrives: true, includeItemsFromAllDrives: true,
  });
  return data.files || [];
}
export async function listInboxFiles(folderId) {
  const out = []; let pageToken;
  do {
    const { data } = await api().files.list({
      q: `'${folderId}' in parents and trashed=false and (${MIME_OK.map((m) => `mimeType='${m}'`).join(' or ')})`,
      fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,parents)', pageSize: 100, pageToken,
      supportsAllDrives: true, includeItemsFromAllDrives: true,
    });
    out.push(...(data.files || [])); pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}
export async function downloadFile(id) {
  const res = await api().files.get({ fileId: id, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
  return Buffer.from(res.data);
}
export async function fileInfo(id) {
  const { data } = await api().files.get({ fileId: id, fields: 'id,name,webViewLink,parents', supportsAllDrives: true });
  return data;
}
/** Renombra y (si hay carpeta destino) mueve el fichero dentro de Drive. */
export async function renameAndMove(id, name, destFolder) {
  const info = await fileInfo(id);
  const params = { fileId: id, requestBody: { name }, fields: 'id,webViewLink,parents', supportsAllDrives: true };
  if (destFolder && !(info.parents || []).includes(destFolder)) { params.addParents = destFolder; params.removeParents = (info.parents || []).join(','); }
  const { data } = await api().files.update(params);
  return data;
}
export async function uploadBuffer(buffer, name, mimeType, folderId) {
  const { data } = await api().files.create({
    requestBody: { name, parents: folderId ? [folderId] : undefined },
    media: { mimeType, body: Readable.from(buffer) }, fields: 'id,webViewLink', supportsAllDrives: true,
  });
  return data;
}
export async function copyFile(id, name, folderId) {
  const { data } = await api().files.copy({ fileId: id, requestBody: { name, parents: [folderId] }, fields: 'id,webViewLink', supportsAllDrives: true });
  return data;
}
