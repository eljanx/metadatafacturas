import { env } from './config.js';
import { createApp } from './app.js';
import { recoverOnStart } from './pipeline.js';
import { startWatcher } from './watcher.js';
import { hasApiKey } from './extractor.js';
import { effectiveModel } from './settings.js';
import { log } from './log.js';

createApp().listen(env.port, env.host, () => {
  log.info(`Facturas Farmacia en http://${env.host}:${env.port}  (modelo: ${effectiveModel()}, API key: ${hasApiKey() ? 'configurada' : 'FALTA'})`);
  if (env.host !== '127.0.0.1' && !env.appPassword) log.warn('Escuchando fuera de localhost sin APP_PASSWORD: define APP_PASSWORD.');
  recoverOnStart();
  startWatcher();
});
