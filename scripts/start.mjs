import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export async function loadEnvironment({ root = projectRoot, alternate = '/etc/observer/.env',
  env = process.env, log = console.log } = {}) {
  const inherited = new Set(Object.keys(env));
  let loaded = 0;
  for (const [index, file] of [path.join(root, '.env'), alternate].entries()) {
    let text;
    try { text = await readFile(file, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot read configuration file: ${file}`);
      log(index === 0
        ? `.env not found in project root. Checking alternate location: ${alternate}`
        : `Alternate configuration not found: ${alternate}`);
      continue;
    }
    const values = parseEnv(text);
    // Match the previous CLI behavior: shell > alternate file > project file.
    for (const [key, value] of Object.entries(values)) if (!inherited.has(key)) env[key] = value;
    loaded++;
    log(`Loaded configuration: ${file}`);
  }
  if (!loaded) log('No configuration file loaded. Using environment variables and application defaults.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    const targets = { start: 'src/run.js', report: 'src/report.js',
      check: 'src/storage/cli.js', status: 'src/storage/cli.js', up: 'src/storage/cli.js' };
    if (!Object.hasOwn(targets, command)) throw new Error('Expected start, report, check, status, or up.');
    await loadEnvironment();
    const target = new URL(`../${targets[command]}`, import.meta.url);
    process.argv = [process.execPath, fileURLToPath(target), ...(['check', 'status', 'up'].includes(command) ? [command] : []), ...process.argv.slice(3)];
    await import(target.href);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
