import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { UserError, WORKFLOW } from './session';

const TEMPLATE = join(import.meta.dir, '..', 'templates', 'ios-devbox.yml');

/** The section `init` adds to AGENTS.md or CLAUDE.md, and prints when neither exists. */
export const AGENT_INSTRUCTIONS = `## Native iOS builds on EAS (expo-devbox)

Compile and test native iOS code on an EAS macOS worker with \`bunx expo-devbox\`, not on this machine. Do not run \`npx expo run:ios\` or \`xcodebuild\` locally.

1. Start a session once: \`bunx expo-devbox start\`. It bills EAS macOS minutes until \`stop\`, its time limit (60 minutes by default), or 15 minutes without a connection.
2. After each change, run \`bunx expo-devbox build\`. Add \`--pods\` after adding or removing native source files or editing a podspec, and \`--prebuild\` after changing package.json, the app config or a config plugin.
3. \`build\` syncs your files, compiles, launches the app on the worker's iOS Simulator, and prints the app's console and native logs. It exits non-zero on a compile error (with file and line), a crash at launch (with the crashing frames), or a failed check from devbox.json. Read the output, fix the code, and build again. The screenshot is \`.devbox/screenshot.png\`.
4. \`bunx expo-devbox ssh '<command>'\` runs a command in the project directory on the worker, for example \`xcrun simctl list devices booted\`.
5. When you are done, run \`bunx expo-devbox stop\`.
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

  if (!existsSync('devbox.json')) {
    writeFileSync('devbox.json', `${JSON.stringify({ waitFor: '', failOn: '' }, null, 2)}\n`);
    done.push('Wrote devbox.json. Set waitFor and failOn to regular expressions that match lines your app logs, so build waits for them and fails on them.');
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
  bunx expo-devbox start      start a session (EAS macOS minutes are billed while it runs)
  bunx expo-devbox build      build, launch and check the app on the worker`);
}
