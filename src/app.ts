/** oidc-webpush — bootstrap */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import { config } from './config.js';
import { registerRoutes } from './routes.js';
import { startSmtpServer } from './smtp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({ logger: { level: config.logLevel } });

await app.register(fastifyCookie, { secret: config.cookieSecret });
await app.register(fastifyFormbody);
await app.register(fastifyStatic, {
  root: path.join(__dirname, '..', 'public'),
  prefix: '/',
  decorateReply: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
  },
});

await registerRoutes(app);

await app.listen({ host: config.host, port: config.port });
console.log(`HTTP listening on ${config.host}:${config.port}`);

startSmtpServer();

const shutdown = async (sig: string) => {
  console.log(`received ${sig}, shutting down`);
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
