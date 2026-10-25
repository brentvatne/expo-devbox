#!/usr/bin/env bun
import { init } from './init';
import { playIntro } from './intro';
import { parseArgs } from './args';
import { attach, joblog, pull, selectSession, sessions, shell, start, stop, sync, UserError } from './session';
import { status } from './status';

const HELP = `A macOS EAS worker for building and testing an Expo app's native iOS code,
for you or a coding agent. Run these in the app's root directory.

Commands:
  init [--force] [--no-agents]    add the devbox workflow to this app
  start [minutes] [idle-minutes]  start a new session and wait until its worker is ready (about 4 minutes).
                                  It ends after [minutes] (default 60) or after [idle-minutes] without
                                  an SSH connection (default 15). EAS macOS minutes are billed until then.
  sync                            copy your files to the worker (what git would track; .gitignore applies)
  ssh ['command']                 run a command in the app's directory on the worker, or open a shell
  pull <path> [local-path]        copy a file from the worker; a relative path is in the app's directory
  sessions                        list this directory's sessions
  attach [id]                     reconnect to a session and make it the current one
  joblog                          print the session's workflow job log
  stop [--all]                    end the session (or all of them) and wait until EAS confirms it ended

Sessions:
  Each start begins a new session and makes it the current one. The other commands use the current
  session. To use another, add --session <id> (or -s <id>) before the command's arguments, or set
  EXPO_DEVBOX_SESSION=<id>. Any unique prefix of an ID works; expo-devbox sessions lists them.

On the worker:
  After each change, run expo-devbox sync, then the commands below that the change needs with
  expo-devbox ssh '<command>'. A JavaScript change needs none: Metro sends it to the running app.
  A native change needs a build, then install and launch. The rest are for checking the result.
  The DEVBOX_* variables are set in every SSH session.

  Build, after a native change. Prints errors with file and line, then ** BUILD SUCCEEDED ** or
  ** BUILD FAILED **. The full log is ~/.devbox/build.log.
    set -o pipefail; xcodebuild -workspace "$DEVBOX_WORKSPACE" -scheme "$DEVBOX_SCHEME" -configuration Debug -destination "id=$DEVBOX_SIMULATOR" -derivedDataPath "$DEVBOX_DERIVED_DATA" build 2>&1 | tee ~/.devbox/build.log | grep -E ": (fatal )?error:|\\*\\* BUILD" | sort -u

  After a build, install and launch the app on the simulator:
    xcrun simctl install booted "$DEVBOX_APP" && xcrun simctl launch --terminate-running-process booted "$DEVBOX_BUNDLE_ID"

  JavaScript console output and errors (Metro):
    tail -n 50 ~/.devbox/metro.log

  Native log (NSLog, and os_log or Logger output from the app's own code; last minute):
    xcrun simctl spawn booted log show --last 1m --style compact --predicate "$DEVBOX_LOG_PREDICATE" 2>/dev/null

  Check that the app is still running:
    pgrep -lf "$DEVBOX_EXECUTABLE.app/$DEVBOX_EXECUTABLE" || echo "The app is not running."

  If it crashed, the exception and crashing frames from the newest crash report:
    tail -n +2 "$(ls -t ~/Library/Logs/DiagnosticReports/$DEVBOX_EXECUTABLE*.ips | head -1)" | jq "{exception, termination, frames: [.threads[] | select(.triggered) | .frames[:12][] | {symbol, sourceFile, sourceLine}]}"

  Screenshot. Then copy it to your machine with: expo-devbox pull .devbox/screenshot.png .devbox/
    mkdir -p .devbox && xcrun simctl io booted screenshot .devbox/screenshot.png

  After adding or removing native files, or editing a podspec:
    cd ios && pod install

  After changing package.json, the app config or a config plugin (use your package manager;
  skip prebuild if you commit ios/):
    bun install && npx expo prebuild --platform ios --no-install && cd ios && pod install

Requires a logged-in eas-cli and cloudflared (brew install cloudflared).
Docs: https://www.npmjs.com/package/expo-devbox`;

const commands: Record<string, (args: string[]) => unknown> = {
  init, start, sync, ssh: shell, pull, sessions, attach, joblog, stop,
};

const { command: name, args, session } = parseArgs(process.argv.slice(2));
selectSession(session ?? process.env.EXPO_DEVBOX_SESSION);
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
