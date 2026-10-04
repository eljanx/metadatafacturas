// Asistente de configuración para personas que no programan: pide las claves, comprueba la de
// Anthropic y lo guarda todo en .env (fichero local, fuera de git). Uso: node scripts/configurar.js
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const ENV = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
const titulo = (t) => console.log(`\n${'='.repeat(60)}\n  ${t}\n${'='.repeat(60)}`);

function leerEnv() {
  const d = {};
  if (fs.existsSync(ENV)) for (const l of fs.readFileSync(ENV, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/); if (m && !l.trim().startsWith('#')) d[m[1]] = m[2].trim();
  }
  return d;
}
function guardarEnv(d) {
  const lines = ['# Generado por el asistente. No compartas este fichero con nadie.', ...Object.entries(d).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}=${v}`)];
  fs.writeFileSync(ENV, `${lines.join('\n')}\n`, { mode: 0o600 });
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
async function preguntar(texto, actual = '', { obligatorio = false } = {}) {
  for (;;) {
    const r = (await rl.question(`${texto}\n${actual ? '(Ya hay una guardada. Pulsa Intro para mantenerla o pega una nueva)\n' : obligatorio ? '' : '(Opcional: pulsa Intro para saltar)\n'}> `)).trim();
    if (r) return r;
    if (actual || !obligatorio) return actual;
  }
}

async function comprobarAnthropic(key, model) {
  try {
    await new Anthropic({ apiKey: key, maxRetries: 1, timeout: 30000 }).messages.create({
      model, max_tokens: 1024, output_config: { effort: 'low' }, messages: [{ role: 'user', content: 'Responde solo: OK' }],
    });
    console.log('✔ Clave de Anthropic correcta y con saldo.');
    return true;
  } catch (e) {
    if (e?.status === 401) console.log('✘ La clave de Anthropic no es válida. Revisa que la has copiado entera.');
    else if (/credit balance/i.test(String(e?.message))) { console.log('⚠ La clave es correcta pero la cuenta NO TIENE SALDO.\n  Recarga en console.anthropic.com → Billing. Hasta entonces no se podrá leer ninguna factura.'); return true; }
    else if (e?.status === 404 || /model/i.test(String(e?.message))) { console.log(`⚠ La clave parece válida, pero el modelo «${model}» no está disponible para ella. Se guarda igualmente; puedes cambiar el modelo en la app (Configuración).`); return true; }
    else if (e?.status) console.log(`✘ Error de Anthropic (${e.status}): ${String(e.message).slice(0, 200)}`);
    else console.log('✘ No hay conexión con Anthropic. ¿Tienes internet?');
    return false;
  }
}

const env = leerEnv();
titulo('CONFIGURACIÓN DE FACTURAS FARMACIA');
console.log('Tendrás a mano la clave de Anthropic (console.anthropic.com → API Keys).\nLos datos de la farmacia y las carpetas se rellenan después, dentro de la app.\n(Para pegar en esta ventana: clic derecho del ratón.)');

titulo('1/3  ANTHROPIC (la IA que lee las facturas)');
for (;;) {
  env.ANTHROPIC_API_KEY = await preguntar('Pega la clave de Anthropic (empieza por sk-ant-):', env.ANTHROPIC_API_KEY, { obligatorio: true });
  if (await comprobarAnthropic(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL || 'claude-opus-5-5')) break;
  delete env.ANTHROPIC_API_KEY;
  console.log('Inténtalo de nuevo.\n');
}

titulo('2/3  GOOGLE DRIVE (opcional)');
console.log('Solo si vas a usar carpetas de Google Drive. Necesitas crear en Google Cloud unas credenciales OAuth\n(«Aplicación web») con esta URI de redirección:  http://localhost:3000/api/drive/callback\nSi no lo vas a usar ahora, pulsa Intro en las dos preguntas (se puede añadir después).\n');
env.GOOGLE_CLIENT_ID = await preguntar('Google Client ID:', env.GOOGLE_CLIENT_ID);
if (env.GOOGLE_CLIENT_ID) env.GOOGLE_CLIENT_SECRET = await preguntar('Google Client secret:', env.GOOGLE_CLIENT_SECRET, { obligatorio: true });

titulo('3/3  ACTUALIZACIONES (opcional)');
console.log('El repositorio de GitHub es PRIVADO, así que ACTUALIZAR.bat necesita un permiso de solo lectura.\nCrea un «fine-grained personal access token» en github.com → Settings → Developer settings,\ncon acceso solo a este repositorio y permiso «Contents: Read-only». Si el repositorio fuera público, no hace falta.\n');
env.GITHUB_TOKEN = await preguntar('Token de GitHub para actualizar:', env.GITHUB_TOKEN);

guardarEnv(env);
rl.close();
titulo('LISTO');
console.log('Configuración guardada en el fichero .env (no lo compartas).\nAhora haz doble clic en ARRANCAR.bat');
