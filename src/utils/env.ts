import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Loads a .env file for local development: ENV_FILE if set, else `.env` in the
 * working directory, else `.env` in the package root (MCP hosts often launch
 * servers from an unrelated cwd). Variables already set in the environment win.
 */
export function loadEnvFile(): void {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const candidates = process.env.ENV_FILE
    ? [path.resolve(process.env.ENV_FILE)]
    : [path.resolve('.env'), path.join(packageRoot, '.env')];
  const file = candidates.find((f) => existsSync(f));
  if (file && typeof process.loadEnvFile === 'function') process.loadEnvFile(file);
}
