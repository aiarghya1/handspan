/**
 * The process shell, and the only place in the project that reads
 * `process.argv` or calls `process.exit`.
 *
 * It deliberately contains no logic: every command is a function that takes
 * arguments and returns an exit code, which is what makes them testable. This
 * file lives outside `src/` because it is packaging rather than behaviour.
 */

import { consoleIo, EXIT } from '../src/cli/io.js';

const COMMANDS = {
  discover: () => import('../src/cli/discover.js'),
  replay: () => import('../src/cli/replay.js'),
  catalog: () => import('../src/cli/catalog.js'),
  operator: () => import('../src/cli/operator.js'),
  demo: () => import('../src/cli/demo.js'),
} as const;

const [name, ...rest] = process.argv.slice(2);

if (!name || !(name in COMMANDS)) {
  consoleIo.err(`usage: handspan <${Object.keys(COMMANDS).join('|')}> [options]\n`);
  process.exit(EXIT.usage);
}

const mod = await COMMANDS[name as keyof typeof COMMANDS]();
process.exit(await mod.run(rest, consoleIo));
