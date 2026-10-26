import { buildApp } from './app';
import { emailMode, loadConfig } from './config';

const config = loadConfig();
const { app } = await buildApp({ config });

const shutdown = async (signal: string) => {
  app.log.info(`${signal}: shutting down`);
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
app.log.info(`margin-comments listening on ${config.port} (email: ${emailMode(config)})`);
console.log(`margin-comments server listening on http://${config.host}:${config.port} (public ${config.publicUrl}, email ${emailMode(config)})`);
