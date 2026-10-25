#!/usr/bin/env bun
import { init } from './init';
import { playIntro } from './intro';
import { attach, build, joblog, logs, shell, start, stop, sync, UserError } from './session';
import { status } from './status';

const HELP = `Build and test an Expo app's native iOS code on an EAS macOS worker,
from your terminal or a coding agent.

Usage: expo-devbox <command>

  init [--force] [--no-agents]      add the devbox workflow to this Expo app
  start [minutes] [idle-minutes]    start a session (default 60 and 15); wait until SSH works
  build [--pods|--prebuild]         sync, build with Xcode, launch, print logs, copy the screenshot
  ssh [command]                     run a command in the project on the worker, or open a shell
  logs [pattern]                    search the app's console output
  sync                              copy local sources to the worker
  attach [run-id]                   reconnect to a running session
  joblog                            print the workflow job's log
  stop                              cancel the session and wait until it has ended

Requires a logged-in eas-cli and cloudflared (brew install cloudflared).
Docs: https://www.npmjs.com/package/expo-devbox`;

const commands: Record<string, (args: string[]) => unknown> = {
  init, start, build, ssh: shell, logs, sync, attach, joblog, stop,
};

const [name, ...args] = process.argv.slice(2);
if (!name || name === 'help' || name === '--help' || name === '-h') {
  if (process.stdout.isTTY) await playIntro();
  console.log(HELP);
} else if (name === 'version' || name === '--version' || name === '-v') {
  console.log((await import('../package.json')).version);
} else if (!commands[name]) {
  console.error(`Unknown command "${name}". Run expo-devbox help to see the commands.`);
  process.exitCode = 1;
} else {
  try {
    if (name === 'init' && process.stdout.isTTY) await playIntro();
    await commands[name](args);
  } catch (error) {
    status('error', { msg: error instanceof Error ? error.message.split('\n')[0] : String(error) });
    if (error instanceof UserError) {
      console.error(error.message);
    } else if (error && typeof error === 'object' && 'exitCode' in error && 'stderr' in error) {
      // A failed shell command: show what it printed.
      console.error(`${String(error.stderr).trim() || 'A command failed.'} (exit ${error.exitCode})`);
    } else {
      throw error;
    }
    process.exitCode = 1;
  }
}
