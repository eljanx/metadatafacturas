// Logger que nunca imprime claves: redacta cualquier cadena con aspecto de API key / token.
const SECRET_RE = /(sk-ant-[A-Za-z0-9_-]+|ya29\.[A-Za-z0-9_-]+|1\/\/[A-Za-z0-9_-]{20,}|GOCSPX-[A-Za-z0-9_-]+)/g;
export const redact = (v) => String(v ?? '').replace(SECRET_RE, '[REDACTADO]');
const fmt = (a) => a.map((x) => redact(x instanceof Error ? x.message : typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
export const log = {
  info: (...a) => console.log(new Date().toISOString(), 'INFO', fmt(a)),
  warn: (...a) => console.warn(new Date().toISOString(), 'WARN', fmt(a)),
  error: (...a) => console.error(new Date().toISOString(), 'ERROR', fmt(a)),
};
