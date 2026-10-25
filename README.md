# expo-devbox

A macOS EAS worker for building and testing your Expo app's native iOS code, for you or your coding agent, instead of your own machine. `expo-devbox start` brings up a worker that has your app prebuilt, its pods installed, an iOS Simulator booted, Metro running, and a first build done. Then you, or your agent, copy files over with `expo-devbox sync` and run commands on it with `expo-devbox ssh`.

It is for work that rebuilds native code over and over, such as an agent iterating on an [Expo module](https://docs.expo.dev/modules/overview/), when those rebuilds are too heavy for your machine.

## Set it up with your coding agent

Paste this into your coding agent, in your Expo app:

```text
Set up expo-devbox (https://www.npmjs.com/package/expo-devbox) in this Expo app. It is a tool I will ask you to use when I want to build and test native iOS code on an EAS macOS worker instead of this machine.

1. Check the requirements: bun 1.3 or later, eas-cli logged in (`eas whoami`), and cloudflared (`brew install cloudflared` if it is missing). If the app has no EAS project ID in its app config, run `eas init`.
2. Run `bunx expo-devbox init` in the app's root directory.
3. Read the "Native iOS builds on EAS (expo-devbox)" section that init added to AGENTS.md or CLAUDE.md. If neither file exists, init prints the section instead; add it to the instructions file you read. Then run `bunx expo-devbox help`. Keep building the app the way you do now; use expo-devbox only when I ask you to.
4. Do not start a session; a session bills EAS macOS minutes while it runs. Tell me what you set up.
```

**iOS only for now.** Android support, on an EAS Linux worker with the Android Emulator, will be added to this tool shortly.

## Requirements

- An Expo app linked to an EAS project (`eas init`), on a plan with macOS workflow minutes. A session holds one macOS concurrency slot and is billed for as long as it runs. Check your plan's price and job time limits.
- [Bun](https://bun.sh) 1.3 or later, and `eas-cli`, logged in.
- `cloudflared`: `brew install cloudflared`.

## Set up

In the root of your app:

```sh
bunx expo-devbox init
```

`init` writes the workflow to `.eas/workflows/ios-devbox.yml` and adds `.devbox/` to `.gitignore`; the CLI keeps the session's run ID and SSH config there. It also adds a short section for coding agents to `AGENTS.md` or `CLAUDE.md`, or prints it if neither file exists (see [Coding agents](#coding-agents)).

## Commands

| Command | What it does |
| --- | --- |
| `init [--force] [--no-agents]` | Adds the devbox workflow to the app, as in [Set up](#set-up). `--force` replaces an existing workflow; `--no-agents` leaves `AGENTS.md` and `CLAUDE.md` alone. |
| `start [minutes] [idle-minutes]` | Starts a session and waits until the worker is ready, about 4 minutes. The session ends after `minutes` (default 60) or after `idle-minutes` with no SSH connection (default 15). |
| `sync` | Copies your files to the worker: what git would track, so `.gitignore` applies. Run it after each change. |
| `ssh ['command']` | Runs a command in the app's directory on the worker, or opens a shell. If the connection drops while the command runs, it exits 255 and does not run the command again. |
| `attach [run-id]` | Reconnects to a running session. `sync` and `ssh` also reconnect on their own when the worker's tunnel has moved. |
| `joblog` | Prints the workflow job's log. |
| `stop` | Ends the session and waits until EAS confirms that it has ended. |

`expo-devbox help` prints these commands and the steps in [On the worker](#on-the-worker).

## On the worker

After each change, run `expo-devbox sync`, then run these with `expo-devbox ssh '<command>'`. The `DEVBOX_*` variables are set in every SSH session.

For example:

```
$ bunx expo-devbox sync
$ bunx expo-devbox ssh 'set -o pipefail; xcodebuild … build 2>&1 | tee ~/.devbox/build.log | grep -E ": (fatal )?error:|\*\* BUILD" | sort -u'
** BUILD SUCCEEDED **
$ bunx expo-devbox ssh 'tail -n 3 ~/.devbox/metro.log'
 LOG  [native-crypto] PASS sha384("abc"): cb00753f…
 LOG  [native-crypto] DONE 7/7 passed
```

**Build.** Prints errors with file and line, then `** BUILD SUCCEEDED **` or `** BUILD FAILED **`, and exits non-zero on failure. The full log is `~/.devbox/build.log`. After the worker's first build, an incremental build takes a few seconds.

```sh
set -o pipefail; xcodebuild -workspace "$DEVBOX_WORKSPACE" -scheme "$DEVBOX_SCHEME" -configuration Debug -destination "id=$DEVBOX_SIMULATOR" -derivedDataPath "$DEVBOX_DERIVED_DATA" build 2>&1 | tee ~/.devbox/build.log | grep -E ": (fatal )?error:|\*\* BUILD" | sort -u
```

**Install and launch** the app on the simulator:

```sh
xcrun simctl install booted "$DEVBOX_APP" && xcrun simctl launch --terminate-running-process booted "$DEVBOX_BUNDLE_ID"
```

**JavaScript console output and errors**, from Metro:

```sh
tail -n 50 ~/.devbox/metro.log
```

**Native log**: `NSLog`, and `os_log` or `Logger` output from the app's own code, from the last minute. Swift's `print` writes to stdout and does not appear here.

```sh
xcrun simctl spawn booted log show --last 1m --style compact --predicate "$DEVBOX_LOG_PREDICATE" 2>/dev/null
```

**Check that the app is still running**, and if it crashed, read the exception and crashing frames from the newest crash report:

```sh
pgrep -lf "$DEVBOX_EXECUTABLE.app/$DEVBOX_EXECUTABLE" || echo "The app is not running."
tail -n +2 "$(ls -t ~/Library/Logs/DiagnosticReports/$DEVBOX_EXECUTABLE*.ips | head -1)" | jq "{exception, termination, frames: [.threads[] | select(.triggered) | .frames[:12][] | {symbol, sourceFile, sourceLine}]}"
```

**Screenshot**, then copy it to your machine (the second command runs locally):

```sh
xcrun simctl io booted screenshot ~/.devbox/screenshot.png
scp -F .devbox/ssh_config devbox:.devbox/screenshot.png .devbox/
```

**After adding or removing native files, or editing a podspec:**

```sh
cd ios && pod install
```

**After changing `package.json`, the app config or a config plugin.** Use your package manager, and skip prebuild if you commit `ios/`:

```sh
bun install && npx expo prebuild --platform ios --no-install && cd ios && pod install
```

### The variables

| Variable | Value |
| --- | --- |
| `DEVBOX_WORKSPACE`, `DEVBOX_SCHEME` | The Xcode workspace (`ios/<name>.xcworkspace`) and scheme. |
| `DEVBOX_SIMULATOR` | The booted simulator's UDID. |
| `DEVBOX_DERIVED_DATA` | The DerivedData folder of the worker's first build. Build with it to keep builds incremental. |
| `DEVBOX_APP`, `DEVBOX_BUNDLE_ID`, `DEVBOX_EXECUTABLE` | The built `.app`, its bundle identifier, and its executable's name. |
| `DEVBOX_LOG_PREDICATE` | A `log` predicate for messages from the app's own code and `NSLog`, without system libraries' logging. |

## Coding agents

`init` adds this to `AGENTS.md` or `CLAUDE.md`. It tells agents to use the devbox only when you ask. Copy it into your agent's instructions if you use another file:

```markdown
## Native iOS builds on EAS (expo-devbox)

`bunx expo-devbox` gives you a macOS EAS worker to build and test this app's native iOS code instead of this machine. Use it only when the user asks for it, for example "build this on the devbox". Otherwise, build and run the app as you normally would.

When the user asks for it:

1. Run `bunx expo-devbox help` and follow its "On the worker" section. It has the command for each step: build, install and launch, logs, crash reports and screenshots.
2. Start a session with `bunx expo-devbox start`. It returns when the worker is ready, and EAS macOS minutes are billed until the session ends.
3. After each change, run `bunx expo-devbox sync`, then the commands from the help with `bunx expo-devbox ssh '<command>'`.
4. When the user is done with the devbox, run `bunx expo-devbox stop`.
```

In a terminal that supports the [Program Status Protocol](https://mitchellh.com/writing/program-status-osc7501) (OSC 7501), such as Ghostty, `start`, `attach` and `stop` report their status: working, done, or blocked when the run needs approval on expo.dev; any command that fails reports an error. The CLI sends these reports only when its stderr is a terminal, so output that an agent captures never contains them.

## How it works

The workflow runs one custom job on `macos-large` in the `development` environment:

1. **SSH.** It starts `sshd` as the build user on `127.0.0.1:2222`. Only the key `~/.ssh/eas_devbox`, created by `start`, can log in. SSH sessions get the toolchain variables (`PATH`, Ruby, nvm) and the `DEVBOX_*` variables, but not the job's EAS environment variables or its `EXPO_TOKEN`. The job itself still has them, and the SSH user is the job user, so do not give a session to someone who should not see the development environment.
2. **Tunnel.** EAS workers accept no inbound connections, so the worker opens a pinned `cloudflared` [quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/), and Cloudflare relays your connection to it. The job log prints the tunnel host and the worker's SSH host key; the CLI reads them with `eas workflow:logs` and pins the key. Quick tunnels have no uptime guarantee. If the tunnel exits, the worker opens a new one, and `sync` and `ssh` reconnect.
3. **Preparation.** It runs `expo prebuild` (skipped when the project commits `ios/`) and `pod install`, and boots an iPhone simulator. It writes the `DEVBOX_*` variables for SSH sessions. It starts Metro with `CI` unset, because with `CI=true` Metro ignores file changes. Then it runs the build command above once, so that later builds are incremental.
4. **Session.** The job stays up until `minutes` after it started, or until no SSH connection has been open for `idle-minutes`. It restarts Metro if Metro stops responding.

`sync` sends what git would track. Patterns from `.gitignore` are excluded, so local secrets such as `.env.local` stay local and files that the worker generated are not deleted. `.gitignore` lines that start with `!` are not supported.

> [!NOTE]
> SSH support for EAS Workflows is coming soon (`eas workflow:run --ssh` and `eas workflow:ssh`). It will cover about half of what this tool does: the SSH server, the Cloudflare tunnel, finding the worker, and ending idle sessions. The other half stays: preparing the worker (prebuild, pods, simulator, Metro, a first build), syncing your files safely, the variables and commands for building and running the app, and the instructions for coding agents. Steps 1 and 2, and the idle shutdown in step 4, exist because EAS Workflows does not offer SSH yet. When workflow SSH ships, `expo-devbox` will use it.

## Limits

- iOS only. Android support will be added shortly.
- One app per project root. Monorepos with dependencies outside the app directory are not supported.
- The `DEVBOX_*` values assume prebuild's naming, where the scheme, the app and its executable share a name. A project that commits `ios/` with different names can use its own values in the commands.
- Private npm packages need their token as an EAS environment variable in the `development` environment.

## Turn off the intro

`expo-devbox help` (or `expo-devbox` with no command) and `expo-devbox init` open with an animated wordmark when you run them in a terminal. Set `EXPO_DEVBOX_INTRO=off` to skip it, or set it to `slider`, `decrypt`, `beams`, `snap` or `slide` to pick one.

## Developing expo-devbox

The CLI is at the root of this repository: `src/` holds the commands, `templates/` holds the workflow that `init` writes, and `test/` holds the unit tests.

```sh
bun install
bun run typecheck
bun test
bun link && bun install -g .    # put this checkout on your PATH as expo-devbox
```

### The example app

[`example/`](example) is the app to test the CLI against, end to end, on a real EAS worker. It has a local Expo module, [`modules/native-crypto`](example/modules/native-crypto). The module wraps CryptoKit SHA-256, SHA-384, SHA-512 and HMAC-SHA256, and `SecRandomCopyBytes`. On launch, [`App.tsx`](example/App.tsx) checks the module against published test vectors (FIPS 180-2 and RFC 4231). It logs a `[native-crypto] PASS` or `FAIL` line for each check, then `[native-crypto] DONE`, and `NSLog`s `[native-crypto] module created` from Swift.

The example does not depend on `expo-devbox`. Run the linked CLI from the example's directory:

```sh
cd example
bun install
expo-devbox start
```

To use your own EAS account, delete `owner` and `extra.eas` from `example/app.json` and run `eas init` in `example/`.

Before a release, run these checks in the example with the commands from [On the worker](#on-the-worker), and revert each edit afterwards:

| Change | Expected result |
| --- | --- |
| None: sync, build, install and launch | `** BUILD SUCCEEDED **`; Metro log ends with `DONE 7/7 passed`; the native log has `module created` |
| A Swift type error | the build prints the error with file and line, `** BUILD FAILED **`, and exits non-zero |
| `fatalError()` in the module's `OnCreate` | `The app is not running.`; the crash report frames point at `NativeCryptoModule.swift` |
| A wrong expected value in `App.tsx` | Metro log has a `FAIL` line |
| Prebuild and pod install, then build | `** BUILD SUCCEEDED **` |
| `.env.local` present, then `sync` | the file is not on the worker |
| `expo-devbox ssh 'pkill -9 cloudflared'`, then `expo-devbox ssh 'true'` | the first exits 255 with the dropped-connection message and is not run again; the second reconnects on its own and exits 0 |
| `stop` | `The devbox session is canceled.` |

After you change `templates/ios-devbox.yml`, run `expo-devbox init --force --no-agents` in `example/` to update its workflow.
