# expo-devbox

A macOS EAS worker for building and testing your Expo app's native iOS code, for you or your coding agent, instead of your own machine. `expo-devbox start` brings up a worker with your app prebuilt, its pods installed, an iOS Simulator booted, Metro running and a first build done. Then you copy files over with `sync`, run commands with `ssh`, and copy results back with `pull`.

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

<details>
<summary><strong>Requirements</strong></summary>

- An Expo app linked to an EAS project (`eas init`), on a plan with macOS workflow minutes. A session holds one macOS concurrency slot and is billed for as long as it runs. Check your plan's price and job time limits.
- [Bun](https://bun.sh) 1.3 or later, and `eas-cli`, logged in.
- `cloudflared`: `brew install cloudflared`.

</details>

## Quick start

In the root of your app:

```sh
bunx expo-devbox init      # add the workflow, a .gitignore line and the agent instructions
bunx expo-devbox start     # start a session; returns when the worker is ready (about 4 minutes)
bunx expo-devbox sync      # after each change: copy your files to the worker
bunx expo-devbox ssh '<command>'   # build, launch and check the app: see "On the worker"
bunx expo-devbox stop      # end the session
```

| Command | What it does |
| --- | --- |
| `init [--force] [--no-agents]` | Writes `.eas/workflows/ios-devbox.yml`, adds `.devbox/` (session state) to `.gitignore`, and adds the [agent instructions](#coding-agents) to `AGENTS.md` or `CLAUDE.md`. |
| `start [minutes] [idle-minutes]` | Starts a new session and waits until its worker is ready. It ends after `minutes` (default 60) or `idle-minutes` with no SSH connection (default 15). |
| `sync` | Copies your files to the worker: what git would track, so `.gitignore` applies. |
| `ssh ['command']` | Runs a command in the app's directory on the worker, or opens a shell. |
| `pull <path> [local-path]` | Copies a file from the worker. A relative path is in the app's directory there. |
| `sessions`, `attach [id]` | Lists this directory's sessions; reconnects to one and makes it current. |
| `joblog` | Prints the session's workflow job log. |
| `stop [--all]` | Ends the session, or every session in this directory, and waits until EAS confirms it. |

`expo-devbox help` prints all of this and the steps below.

<details>
<summary id="sessions"><strong>Several sessions</strong></summary>

Sessions work like Claude Code's. Each `start` begins a new session and makes it the current one, and the other commands use the current session, so with one session you never name it. To use another one, add `--session <id>` (or `-s <id>`) before the command's arguments, or set `EXPO_DEVBOX_SESSION=<id>`. Any unique prefix of the ID works:

```
$ bunx expo-devbox sessions
* 01a170ec-7181  IN_PROGRESS     10/24/2026, 7:38:26 PM
  01a170e8-b2c6  IN_PROGRESS     10/24/2026, 7:34:20 PM
```

Several sessions in one directory help when two agents share a checkout. Each session is its own worker, holds its own macOS concurrency slot and is billed separately. Separate directories, such as git worktrees, keep separate sessions too.

</details>

## On the worker

After each change, run `expo-devbox sync`, then run these with `expo-devbox ssh '<command>'`. The `DEVBOX_*` variables are set in every SSH session. After the worker's first build, an incremental build takes a few seconds.

```sh
# Build. Prints errors with file and line, then ** BUILD SUCCEEDED ** or ** BUILD FAILED **, and exits
# non-zero on failure. The full log is ~/.devbox/build.log.
set -o pipefail; xcodebuild -workspace "$DEVBOX_WORKSPACE" -scheme "$DEVBOX_SCHEME" -configuration Debug -destination "id=$DEVBOX_SIMULATOR" -derivedDataPath "$DEVBOX_DERIVED_DATA" build 2>&1 | tee ~/.devbox/build.log | grep -E ": (fatal )?error:|\*\* BUILD" | sort -u

# Install and launch the app on the simulator.
xcrun simctl install booted "$DEVBOX_APP" && xcrun simctl launch --terminate-running-process booted "$DEVBOX_BUNDLE_ID"

# JavaScript console output and errors (Metro).
tail -n 50 ~/.devbox/metro.log

# Native log: NSLog, and os_log or Logger output from the app's own code, from the last minute.
xcrun simctl spawn booted log show --last 1m --style compact --predicate "$DEVBOX_LOG_PREDICATE" 2>/dev/null

# Check that the app is still running; if it crashed, the newest crash report's exception and frames.
pgrep -lf "$DEVBOX_EXECUTABLE.app/$DEVBOX_EXECUTABLE" || echo "The app is not running."
tail -n +2 "$(ls -t ~/Library/Logs/DiagnosticReports/$DEVBOX_EXECUTABLE*.ips | head -1)" | jq "{exception, termination, frames: [.threads[] | select(.triggered) | .frames[:12][] | {symbol, sourceFile, sourceLine}]}"

# Screenshot. Then, on your machine: expo-devbox pull .devbox/screenshot.png .devbox/
mkdir -p .devbox && xcrun simctl io booted screenshot .devbox/screenshot.png

# After adding or removing native files, or editing a podspec.
cd ios && pod install

# After changing package.json, the app config or a config plugin. Use your package manager;
# skip prebuild if you commit ios/.
bun install && npx expo prebuild --platform ios --no-install && cd ios && pod install
```

<details>
<summary id="variables"><strong>The <code>DEVBOX_*</code> variables</strong></summary>

| Variable | Value |
| --- | --- |
| `DEVBOX_WORKSPACE`, `DEVBOX_SCHEME` | The Xcode workspace (`ios/<name>.xcworkspace`) and scheme. |
| `DEVBOX_SIMULATOR` | The booted simulator's UDID. |
| `DEVBOX_DERIVED_DATA` | The DerivedData folder of the worker's first build. Build with it to keep builds incremental. |
| `DEVBOX_APP`, `DEVBOX_BUNDLE_ID`, `DEVBOX_EXECUTABLE` | The built `.app`, its bundle identifier, and its executable's name. |
| `DEVBOX_LOG_PREDICATE` | A `log` predicate for messages from the app's own code and `NSLog`, without system libraries' logging. Swift's `print` writes to stdout and does not appear in the log. |

The values assume prebuild's naming, where the scheme, the app and its executable share a name. A project that commits `ios/` with different names can use its own values in the commands.

</details>

## Additional information

<details>
<summary id="coding-agents"><strong>Instructions for coding agents</strong></summary>

`init` adds this to `AGENTS.md` or `CLAUDE.md`. It tells agents to use the devbox only when you ask. Copy it into your agent's instructions if you use another file:

```markdown
## Native iOS builds on EAS (expo-devbox)

`bunx expo-devbox` gives you a macOS EAS worker to build and test this app's native iOS code instead of this machine. Use it only when the user asks for it, for example "build this on the devbox". Otherwise, build and run the app as you normally would.

When the user asks for it:

1. Run `bunx expo-devbox help` and follow its "On the worker" section. It has the command for each step: build, install and launch, logs, crash reports and screenshots.
2. Start a session with `bunx expo-devbox start`. It returns when the worker is ready, and EAS macOS minutes are billed until the session ends.
3. After each change, run `bunx expo-devbox sync`, then the commands from the help with `bunx expo-devbox ssh '<command>'`.
4. Commands use the session you started last in this directory. If another agent works in the same directory, pass your session's ID, which `start` prints, to every command: `bunx expo-devbox ssh --session <id> '<command>'`.
5. When the user is done with the devbox, run `bunx expo-devbox stop`.
```

In a terminal that supports the [Program Status Protocol](https://mitchellh.com/writing/program-status-osc7501) (OSC 7501), such as Ghostty, `start`, `attach` and `stop` report their status: working, done, or blocked when the run needs approval on expo.dev; any command that fails reports an error. The CLI sends these reports only when its stderr is a terminal, so output that an agent captures never contains them.

</details>

<details>
<summary id="how-it-works"><strong>How it works</strong></summary>

The workflow runs one custom job on `macos-large` in the `development` environment:

1. **SSH.** It starts `sshd` as the build user on `127.0.0.1:2222`. Only the key `~/.ssh/eas_devbox`, created by `start`, can log in. SSH sessions get the toolchain variables (`PATH`, Ruby, nvm) and the `DEVBOX_*` variables, but not the job's EAS environment variables or its `EXPO_TOKEN`. The job itself still has them, and the SSH user is the job user, so do not give a session to someone who should not see the development environment.
2. **Tunnel.** EAS workers accept no inbound connections, so the worker opens a pinned `cloudflared` [quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/), and Cloudflare relays your connection to it. The job log prints the tunnel host and the worker's SSH host key; the CLI reads them with `eas workflow:logs` and pins the key. Quick tunnels have no uptime guarantee. If the tunnel exits, the worker opens a new one, and `sync`, `ssh` and `pull` reconnect. A command is never run twice: if the connection drops while it runs, `ssh` exits 255.
3. **Preparation.** It runs `expo prebuild` (skipped when the project commits `ios/`) and `pod install`, and boots an iPhone simulator. It writes the `DEVBOX_*` variables for SSH sessions. It starts Metro with `CI` unset, because with `CI=true` Metro ignores file changes. Then it runs the build command above once, so that later builds are incremental.
4. **Session.** The job stays up until `minutes` after it started, or until no SSH connection has been open for `idle-minutes`. It restarts Metro if Metro stops responding.

`sync` sends what git would track. Patterns from `.gitignore` are excluded, so local secrets such as `.env.local` stay local and files that the worker generated are not deleted. `.gitignore` lines that start with `!` are not supported.

> [!NOTE]
> SSH support for EAS Workflows is coming soon (`eas workflow:run --ssh` and `eas workflow:ssh`). It will cover about half of what this tool does: the SSH server, the Cloudflare tunnel, finding the worker, and ending idle sessions (steps 1 and 2, and the idle shutdown in step 4). The other half stays: preparing the worker, syncing your files safely, the variables and commands for building and running the app, and the instructions for coding agents. When workflow SSH ships, `expo-devbox` will use it.

</details>

<details>
<summary><strong>Known limitations</strong></summary>

- iOS only. Android support will be added shortly.
- One app per project root. Monorepos with dependencies outside the app directory are not supported.
- Private npm packages need their token as an EAS environment variable in the `development` environment.

</details>

<details>
<summary><strong>The intro animation</strong></summary>

`expo-devbox help` (or `expo-devbox` with no command) and `expo-devbox init` open with an animated wordmark when you run them in a terminal. Set `EXPO_DEVBOX_INTRO=off` to skip it, or set it to `slider`, `decrypt`, `beams`, `snap` or `slide` to pick one.

</details>

## Contributing

<details>
<summary><strong>Develop, test, and check a release</strong></summary>

The CLI is at the root of this repository: `src/` holds the commands, `templates/` holds the workflow that `init` writes, and `test/` holds the unit tests.

```sh
bun install
bun run typecheck
bun test
bun link && bun install -g .    # put this checkout on your PATH as expo-devbox
```

[`example/`](example) is the app to test the CLI against, end to end, on a real EAS worker. It has a local Expo module, [`modules/native-crypto`](example/modules/native-crypto), that wraps CryptoKit SHA-256, SHA-384, SHA-512 and HMAC-SHA256, and `SecRandomCopyBytes`. On launch, [`App.tsx`](example/App.tsx) checks the module against published test vectors (FIPS 180-2 and RFC 4231), logs a `[native-crypto] PASS` or `FAIL` line for each check, then `[native-crypto] DONE`, and `NSLog`s `[native-crypto] module created` from Swift.

The example does not depend on `expo-devbox`; run the linked CLI from `example/` (`bun install`, then `expo-devbox start`). To use your own EAS account, delete `owner` and `extra.eas` from `example/app.json` and run `eas init` in `example/`. After you change `templates/ios-devbox.yml`, run `expo-devbox init --force --no-agents` in `example/` to update its workflow.

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
| `start` twice, then `sessions`, `ssh --session <first id> 'true'` and `stop --all` | two sessions listed, the newer one current; the command runs on the first; both sessions end |
| `stop` | `The devbox session <id> is canceled.` |

</details>

## License

MIT
