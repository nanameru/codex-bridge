#!/usr/bin/env node
// Foreground router with an explicitly selected recipient catalog and summary model.
import { readFileSync } from 'node:fs';
import { createRouter } from '../src/model-router.mjs';

const [catalogPath, summaryModel, routerPort, bridgePort] = process.argv.slice(2);
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const server = createRouter({ catalog, summaryModel,
  bridgeBase: `http://127.0.0.1:${bridgePort}/v1`,
  manualProvidersEnabled: false, cliModelSyncEnabled: false,
  autoProviderFallback: false, autoBudgetHandoff: false });
server.listen(Number(routerPort), '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
