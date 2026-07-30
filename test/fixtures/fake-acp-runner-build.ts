import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Satisfy createProductionBackendService's required
 * dist/src/driver/contract-runner.js entry (node is invoked directly).
 */
export function writeFakeAcpRunnerBuild(
  runnerDir: string,
  options?: { importFromRunnerRoot?: string },
): void {
  const outDir = path.join(runnerDir, 'dist', 'src', 'driver');
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'contract-runner.js');
  if (options?.importFromRunnerRoot) {
    const relative = JSON.stringify(`../../../${options.importFromRunnerRoot}`);
    writeFileSync(
      outFile,
      `const { pathToFileURL } = require('node:url');\n` +
        `const { join } = require('node:path');\n` +
        `import(pathToFileURL(join(__dirname, ${relative})).href).catch((error) => {\n` +
        `  console.error(error);\n` +
        `  process.exit(1);\n` +
        `});\n`,
    );
    return;
  }
  writeFileSync(
    outFile,
    `process.stdin.resume();\nprocess.stdin.on('end', () => process.exit(0));\n`,
  );
}
