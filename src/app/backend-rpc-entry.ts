#!/usr/bin/env node

import { runBackendRpcMain } from './backend-rpc-stdio';

void runBackendRpcMain().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
