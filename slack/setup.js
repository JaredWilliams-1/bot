/**
 * Interactive setup wizard for the Claudia Slack bot.
 * Walks the user through entering their API keys and writes a .env file.
 *
 * Usage: node setup.js
 */

import { createInterface } from 'readline';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '..', '.env');
const EXAMPLE_PATH = join(__dirname, '..', '.env.example');

// ANSI helpers
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
};

function print(msg = '') { process.stdout.write(msg + '\n'); }
function bold(s) { return `${c.bold}${s}${c.reset}`; }
function dim(s) { return `${c.dim}${s}${c.reset}`; }
function green(s) { return `${c.green}${s}${c.reset}`; }
function yellow(s) { return `${c.yellow}${s}${c.reset}`; }
function cyan(s) { return `${c.cyan}${s}${c.reset}`; }
function red(s) { return `${c.red}${s}${c.reset}`; }
function gray(s) { return `${c.gray}${s}${c.reset}`; }

// Read existing .env values so we can show them as defaults
function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const result = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

// Generate a random key using openssl if available, else crypto
function generateKey(type = 'base64') {
  try {
    if (type === 'hex') return execSync('openssl rand -hex 32', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    return execSync('openssl rand -base64 32', { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return randomBytes(32).toString(type === 'hex' ? 'hex' : 'base64');
  }
}

function prompt(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

// Ask for a value, showing existing/default if present. Returns the chosen value.
async function ask(rl, { label, key, hint, current, required = true, generated = null, secret = false }) {
  print();
  print(bold(label));
  if (hint) print(dim('  ' + hint));

  let displayDefault = null;
  if (current) {
    const masked = secret ? current.slice(0, 8) + '••••••••' : current;
    displayDefault = `current: ${gray(masked)}`;
  } else if (generated) {
    displayDefault = `will auto-generate if left blank`;
  } else if (!required) {
    displayDefault = `optional, leave blank to skip`;
  }

  const suffix = displayDefault ? ` ${dim(`[${displayDefault}]`)}` : '';
  const answer = (await prompt(rl, `  ${cyan('›')} ${suffix} `)).trim();

  if (!answer) {
    if (current) return current;
    if (generated) return generated;
    if (!required) return '';
    print(red('  This field is required.'));
    return ask(rl, { label, key, hint, current, required, generated, secret });
  }
  return answer;
}

async function main() {
  print();
  print(bold('  Claudia Slack Bot — Setup'));
  print(dim('  ─────────────────────────────────────'));
  print(dim('  This wizard will create your .env file.'));
  print(dim('  Press Enter to keep existing values shown in brackets.'));

  const existing = parseEnvFile(ENV_PATH);

  if (existsSync(ENV_PATH)) {
    print();
    print(yellow('  An existing .env was found. Existing values will be preserved as defaults.'));
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Trap Ctrl+C
  rl.on('close', () => { print('\n  Setup cancelled.'); process.exit(0); });

  // ── Anthropic ──────────────────────────────────────────────────────────────
  print();
  print(bold('  ① Anthropic / Claude'));
  print(dim('  ─────────────────────────────────────'));

  const ANTHROPIC_API_KEY = await ask(rl, {
    label: 'Anthropic API key',
    key: 'ANTHROPIC_API_KEY',
    hint: 'Get yours at https://console.anthropic.com/account/keys  (starts with sk-ant-)',
    current: existing.ANTHROPIC_API_KEY,
    secret: true,
  });

  // ── Slack ──────────────────────────────────────────────────────────────────
  print();
  print(bold('  ② Slack credentials'));
  print(dim('  ─────────────────────────────────────'));
  print(dim('  Create a Slack app at https://api.slack.com/apps, then copy the values below.'));

  const SLACK_BOT_TOKEN = await ask(rl, {
    label: 'Bot token',
    key: 'SLACK_BOT_TOKEN',
    hint: 'OAuth & Permissions → Bot User OAuth Token  (starts with xoxb-)',
    current: existing.SLACK_BOT_TOKEN,
    secret: true,
  });

  const SLACK_SIGNING_SECRET = await ask(rl, {
    label: 'Signing secret',
    key: 'SLACK_SIGNING_SECRET',
    hint: 'Basic Information → App Credentials → Signing Secret',
    current: existing.SLACK_SIGNING_SECRET,
    secret: true,
  });

  const SLACK_APP_TOKEN = await ask(rl, {
    label: 'App-level token  (Socket Mode only)',
    key: 'SLACK_APP_TOKEN',
    hint: 'Basic Information → App-Level Tokens  (starts with xapp-)  — leave blank if using HTTP Events API',
    current: existing.SLACK_APP_TOKEN || '',
    required: false,
    secret: true,
  });

  const USE_SOCKET_MODE = SLACK_APP_TOKEN ? 'true' : (existing.SLACK_SOCKET_MODE || 'false');

  // ── Memory daemon ──────────────────────────────────────────────────────────
  print();
  print(bold('  ③ Memory daemon'));
  print(dim('  ─────────────────────────────────────'));

  let generatedMemoryKey;
  try { generatedMemoryKey = generateKey('base64'); } catch { generatedMemoryKey = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }

  const MEMORY_API_KEY = await ask(rl, {
    label: 'Memory API key',
    key: 'MEMORY_API_KEY',
    hint: 'A secret shared between this bot and the memory daemon. Auto-generated if blank.',
    current: existing.MEMORY_API_KEY,
    generated: generatedMemoryKey,
    secret: true,
  });

  // ── Done collecting ────────────────────────────────────────────────────────
  rl.close();

  // Preserve all other values from existing .env, only overwrite what we asked about
  const overrides = {
    ANTHROPIC_API_KEY,
    SLACK_BOT_TOKEN,
    SLACK_SIGNING_SECRET,
    SLACK_APP_TOKEN,
    SLACK_SOCKET_MODE: USE_SOCKET_MODE,
    MEMORY_API_KEY,
  };

  // Build the output: start from .env.example as a template if no .env exists,
  // otherwise update the existing .env in-place.
  let base = existsSync(EXAMPLE_PATH) ? readFileSync(EXAMPLE_PATH, 'utf8') : readFileSync(ENV_PATH, 'utf8');

  for (const [key, value] of Object.entries(overrides)) {
    const escapedValue = value.replace(/\\/g, '\\\\');
    // Replace existing key=anything line
    const linePattern = new RegExp(`^${key}=.*$`, 'm');
    if (linePattern.test(base)) {
      base = base.replace(linePattern, `${key}=${escapedValue}`);
    } else {
      base += `\n${key}=${escapedValue}`;
    }
  }

  writeFileSync(ENV_PATH, base, 'utf8');

  print();
  print('  ' + green('✓') + '  .env written successfully.');
  print();
  print(bold('  You\'re all set. Start the bot with:'));
  print();
  print(`    ${cyan('npm run dev:all')}   ${dim('# memory daemon + bot, watching for changes')}`);
  print(`    ${cyan('npm start')}         ${dim('# bot only (production)')}`);
  print();
}

main().catch((err) => {
  process.stderr.write(red('\nSetup failed: ') + err.message + '\n');
  process.exit(1);
});
