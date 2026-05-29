import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';

const isWindows = platform() === 'win32';
const venvBin = join(homedir(), '.claudia', 'daemon', 'venv', isWindows ? 'Scripts' : 'bin');
const python = join(venvBin, isWindows ? 'python.exe' : 'python');
const PORT = process.env.MEMORY_API_URL?.match(/:(\d+)/)?.[1] ?? '3850';

if (!existsSync(python)) {
  console.error('[memory] claudia-memory daemon not found at', python);
  console.error('[memory] Run: npx get-claudia to set up the memory daemon.');
  process.exit(1);
}

console.log(`[memory] Starting HTTP server on port ${PORT}...`);

const proc = spawn(python, ['-m', 'uvicorn', 'claudia_memory.http_server:app', '--port', PORT], {
  env: { ...process.env },
  stdio: 'inherit',
});

proc.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => proc.kill('SIGINT'));
process.on('SIGTERM', () => proc.kill('SIGTERM'));
