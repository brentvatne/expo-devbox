import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { UserError, WORKFLOW } from './session';

const TEMPLATE = join(import.meta.dir, '..', 'templates', 'ios-devbox.yml');

/** The section `init` adds to AGENTS.md or CLAUDE.md, and prints when neither exists. */
export const AGENT_INSTRUCTIONS = `## Native iOS builds on EAS (expo-devbox)

\`bunx expo-devbox\` gives you a macOS EAS worker to build and test this app's native iOS code instead of this machine. Use it only when the user asks for it, for example "build this on the devbox". Otherwise, build and run the app as you normally would.

When the user asks for it:

1. Run \`bunx expo-devbox help\` and follow its "On the worker" section. It has the command for each step: build, install and launch, logs, crash reports and screenshots.
2. Start a session with \`bunx expo-devbox start\`. It returns when the worker is ready, and EAS macOS minutes are billed until the session ends.
3. After each change, run \`bunx expo-devbox sync\`, then the commands from the help with \`bunx expo-devbox ssh '<command>'\`.
4. Commands use the session you started last in this directory. If another agent works in the same directory, pass your session's ID, which \`start\` prints, to every command: \`bunx expo-devbox ssh --session <id> '<command>'\`.
5. When the user is done with the devbox, run \`bunx expo-devbox stop\`.
`;

export function init(args: string[]) {
  const force = args.includes('--force');
  const skipAgents = args.includes('--no-agents');
  if (!existsSync('package.json')) throw new UserError('No package.json here. Run expo-devbox init in the root of your Expo app.');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  if (!pkg.dependencies?.expo) throw new UserError('This project does not depend on expo. expo-devbox works with Expo apps.');

  const done: string[] = [];
  if (existsSync(WORKFLOW) && !force) {
    done.push(`Kept the existing ${WORKFLOW} (use --force to replace it).`);
  } else {
    mkdirSync(dirname(WORKFLOW), { recursive: true });
    copyFileSync(TEMPLATE, WORKFLOW);
    done.push(`Wrote ${WORKFLOW}.`);
  }

  const gitignore = existsSync('.gitignore') ? readFileSync('.gitignore', 'utf8') : '';
  if (!/^\/?\.devbox\/?$/m.test(gitignore)) {
    appendFileSync('.gitignore', `${gitignore && !gitignore.endsWith('\n') ? '\n' : ''}\n# expo-devbox session state\n.devbox/\n`);
    done.push('Added .devbox/ to .gitignore.');
  }

  if (!skipAgents) {
    const file = ['AGENTS.md', 'CLAUDE.md'].find(name => existsSync(name));
    if (file && readFileSync(file, 'utf8').includes('expo-devbox')) {
      done.push(`${file} already mentions expo-devbox.`);
    } else if (file) {
      appendFileSync(file, `\n${AGENT_INSTRUCTIONS}`);
      done.push(`Added instructions for coding agents to ${file}.`);
    } else {
      done.push(`No AGENTS.md or CLAUDE.md. Add this to the instructions your coding agent reads:\n\n${AGENT_INSTRUCTIONS}`);
    }
  }

  const appJson = existsSync('app.json') ? JSON.parse(readFileSync('app.json', 'utf8')) : undefined;
  const linked = appJson?.expo?.extra?.eas?.projectId;
  console.log(done.map(line => `• ${line}`).join('\n'));
  console.log(`
Next:
  ${linked ? '' : 'eas init                    link this project to EAS, if it is not linked yet\n  '}brew install cloudflared    the SSH tunnel client
  bunx expo-devbox help       the commands, and how to build and run the app on the worker
  bunx expo-devbox start      start a session (EAS macOS minutes are billed while it runs)`);
}
