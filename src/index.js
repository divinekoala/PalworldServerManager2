import { config, validateConfig } from './config.js';
import { createPalApi } from './palApi.js';
import { ServerManager } from './serverManager.js';
import { createHttpServer } from './httpServer.js';

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

async function main() {
  const problems = validateConfig(config);
  if (problems.length) {
    console.error('Configuration problems:');
    for (const p of problems) console.error('  - ' + p);
    console.error('\nCopy .env.example to .env and fill in the missing values.');
    process.exit(1);
  }

  const api = createPalApi({
    base: config.rest.base,
    user: config.rest.user,
    password: config.rest.password,
  });

  const manager = new ServerManager(config, api);
  const app = createHttpServer(config, manager);

  const server = app.listen(config.web.port, config.web.host, () => {
    log(`Palworld Server Manager listening on http://${config.web.host}:${config.web.port}`);
    log(
      `Auto-shutdown after ${config.autoShutdown.emptyMinutes} min empty, ` +
        `polling every ${config.autoShutdown.pollSeconds}s.`
    );
  });

  // Detect an already-running server so a manager restart doesn't lose track.
  await manager.init();

  const shutdown = (signal) => {
    log(`Received ${signal}, shutting down the manager (the game server is left running).`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
