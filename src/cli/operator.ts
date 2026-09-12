/**
 * handspan operator - the console on its own.
 *
 * Normally the console is started inside a run with `--operator-port`, because
 * taking control means driving the browser that run owns. This entry point
 * exists to look at the console without a run in flight; it has no session to
 * hand over, which is exactly the limitation the report calls out as the next
 * thing to build.
 */

import { loadAppProfile } from '../artifact/app-profile.js';
import { num, parseArgs, str } from './args.js';
import { EXIT, type Io } from './io.js';
import { loadPolicyConfig, openSession, type SessionFactory } from './shared.js';

export async function run(argv: string[], io: Io, openSessionFn: SessionFactory = openSession): Promise<number> {
  const args = parseArgs(argv);
  const port = num(args, 'port', 8100)!;
  const app = loadAppProfile(str(args, 'app-profile', 'config/apps/meridian.app.yaml')!);

  const session = await openSessionFn({
    kind: 'replay',
    app,
    policyConfig: loadPolicyConfig(str(args, 'policy', 'config/policy.yaml')),
    headless: true,
    operatorPort: port,
  });

  io.err(`operator console on http://localhost:${port}\n`);
  io.err('No run is in flight, so the queue is empty. Start a run with --operator-port to see it populate.\n');

  if (args.flags['close-immediately'] === true) await session.close();
  return EXIT.ok;
}
