# expo-devbox

Build and test your Expo app's native iOS code on an EAS macOS worker instead of your own machine. You, or your coding agent, edit files locally; `expo-devbox build` syncs them to a worker that stays up for the session, runs an incremental Xcode build, launches the app on the worker's iOS Simulator, and reports what happened.

It is for work that rebuilds native code over and over, such as an agent iterating on an [Expo module](https://docs.expo.dev/modules/overview/), when those rebuilds are too heavy for your machine.

**iOS only for now.** Android support, on an EAS Linux worker with the Android Emulator, will be added to this tool shortly.

```
$ bunx expo-devbox build
BUILD SUCCEEDED in 5s
App console output from this launch:
 LOG  [native-crypto] PASS sha384("abc"): cb00753f…
 LOG  [native-crypto] DONE 7/7 passed
Native log from this launch (system libraries excluded):
2026-10-24 16:59:04.278 Df myapp[6954:97f5] (Foundation) [native-crypto] module created
Screenshot copied to .devbox/screenshot.png
```

> [!NOTE]
> SSH support for EAS Workflows is coming soon (`eas workflow:run --ssh` and `eas workflow:ssh`). It will cover about half of what this tool does: the SSH server, the Cloudflare tunnel, finding the worker, and ending idle sessions. The other half stays: syncing your files, incremental builds, launching the app and checking its logs, crash reports, `devbox.json`, and the instructions for coding agents. When workflow SSH ships, `expo-devbox` will use it.

## Set it up with your coding agent

Paste this into your coding agent, in your Expo app:

```text
Set up expo-devbox (https://www.npmjs.com/package/expo-devbox) in this Expo app, so that you build and test native iOS code on an EAS macOS worker instead of this machine.

1. Check the requirements: bun 1.3 or later, eas-cli logged in (`eas whoami`), and cloudflared (`brew install cloudflared` if it is missing). If the app has no EAS project ID in its app config, run `eas init`.
2. Run `bunx expo-devbox init` in the app's root directory.
3. Read the "Native iOS builds on EAS (expo-devbox)" section that init added to AGENTS.md or CLAUDE.md, and follow it from now on.
4. If the app logs a line when it is ready or when a self-test passes or fails, set `waitFor` and `failOn` in devbox.json to regular expressions for those lines.
5. Ask me before you run `bunx expo-devbox start`: a session bills EAS macOS minutes while it runs. Then run `bunx expo-devbox build`, tell me the result, and run `bunx expo-devbox stop` when we are done.
```

## Requirements

- An Expo app linked to an EAS project (`eas init`), on a plan with macOS workflow minutes. A session holds one macOS concurrency slot and is billed for as long as it runs. Check your plan's price and job time limits.
- [Bun](https://bun.sh) 1.3 or later, and `eas-cli`, logged in.
- `cloudflared`: `brew install cloudflared`.

## Set up

In the root of your app:

```sh
bunx expo-devbox init
```

`init` does the following:

- writes the workflow to `.eas/workflows/ios-devbox.yml`,
- writes `devbox.json`,
- adds `.devbox/` to `.gitignore`,
- adds instructions for coding agents to `AGENTS.md` or `CLAUDE.md`. If neither file exists, it prints them instead; see [Coding agents](#coding-agents).

Then:

```sh
bunx expo-devbox start     # start a session: 60 minutes at most, ends after 15 idle minutes
bunx expo-devbox build     # sync, build, launch, check
bunx expo-devbox stop      # end the session
```

## Commands

| Command | What it does |
| --- | --- |
| `start [minutes] [idle-minutes]` | Starts the workflow and waits until SSH works (about a minute). The worker then prepares the project: install, `expo prebuild`, `pod install`, simulator, Metro, and a first build. That takes about three more minutes. |
| `build` | Syncs your files, builds, launches the app, prints its console and native logs, and copies the screenshot to `.devbox/screenshot.png`. |
| `build --pods` | Same, after adding or removing native source files or editing a podspec. |
| `build --prebuild` | Same, after changing `package.json`, the app config or a config plugin. |
| `ssh [command]` | Runs a command in the project directory on the worker, or opens a shell. |
| `logs [pattern]` | Searches the app's console output from Metro. |
| `sync` | Copies your files to the worker without building. |
| `attach [run-id]` | Reconnects to a running session. `build` reconnects on its own. |
| `joblog` | Prints the workflow job's log. |
| `stop` | Cancels the session and waits until EAS confirms that it has ended. |

`build` exits non-zero, and says why, when:

- the build fails: it prints the compiler errors with file and line,
- the app is not running after launch: it prints the exception and the crashing frames,
- the app does not log a line matching `waitFor`, or logs one matching `failOn`.

## devbox.json

| Key | Meaning |
| --- | --- |
| `waitFor` | A regular expression for a line your app logs when it is ready, for example when its self-test finishes. `build` waits for it, up to `waitSeconds`, and fails if it never appears. Without it, `build` waits 8 seconds. |
| `failOn` | A regular expression for a line that means failure. `build` exits non-zero if the app logs it. |
| `waitSeconds` | How long to wait for `waitFor`. The default is 60. |
| `scheme` | The Xcode scheme, when it is not named after the `.xcworkspace`. |

## Coding agents

`init` adds the following to `AGENTS.md` or `CLAUDE.md`. Copy it into your agent's instructions if you use another file:

```markdown
## Native iOS builds on EAS (expo-devbox)

Compile and test native iOS code on an EAS macOS worker with `bunx expo-devbox`, not on this machine. Do not run `npx expo run:ios` or `xcodebuild` locally.

1. Start a session once: `bunx expo-devbox start`. It bills EAS macOS minutes until `stop`, its time limit (60 minutes by default), or 15 minutes without a connection.
2. After each change, run `bunx expo-devbox build`. Add `--pods` after adding or removing native source files or editing a podspec, and `--prebuild` after changing package.json, the app config or a config plugin.
3. `build` syncs your files, compiles, launches the app on the worker's iOS Simulator, and prints the app's console and native logs. It exits non-zero on a compile error (with file and line), a crash at launch (with the crashing frames), or a failed check from devbox.json. Read the output, fix the code, and build again. The screenshot is `.devbox/screenshot.png`.
4. `bunx expo-devbox ssh '<command>'` runs a command in the project directory on the worker, for example `xcrun simctl list devices booted`.
5. When you are done, run `bunx expo-devbox stop`.
```

To check results without reading pixels, have your app log a line when its checks pass or fail, and set `waitFor` and `failOn`.

In a terminal that supports the [Program Status Protocol](https://mitchellh.com/writing/program-status-osc7501) (OSC 7501), such as Ghostty, `start`, `build` and `stop` report their status: working, done, error, or blocked when the run needs approval. The CLI sends these reports only when its stderr is a terminal, so output that an agent captures never contains them.

## How it works

The workflow runs one custom job on `macos-large` in the `development` environment:

1. **SSH.** It starts `sshd` as the build user on `127.0.0.1:2222`. Only the key `~/.ssh/eas_devbox`, created by `start`, can log in. SSH sessions get the toolchain variables (`PATH`, Ruby, nvm) but not the job's EAS environment variables or its `EXPO_TOKEN`. The job itself still has them, and the SSH user is the job user, so do not give a session to someone who should not see the development environment.
2. **Tunnel.** EAS workers accept no inbound connections, so the worker opens a pinned `cloudflared` [quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/), and Cloudflare relays your connection to it. The job log prints the tunnel host and the worker's SSH host key; the CLI reads them with `eas workflow:logs` and pins the key. Quick tunnels have no uptime guarantee. If the tunnel exits, the worker opens a new one and `build` reconnects.
3. **Preparation.** It runs `expo prebuild` (skipped when the project commits `ios/`) and `pod install`, and boots an iPhone simulator. It starts Metro with `CI` unset, because with `CI=true` Metro ignores file changes. Then it runs a first Debug build.
4. **Session.** The job stays up until `minutes` after it started, or until no SSH connection has been open for `idle-minutes`. It restarts Metro if Metro stops responding.

`sync` sends what git would track. Patterns from `.gitignore` are excluded, so local secrets such as `.env.local` stay local and files that the worker generated are not deleted. `.gitignore` lines that start with `!` are not supported.

Steps 1 and 2, and the idle shutdown in step 4, exist because EAS Workflows does not offer SSH yet. Workflow SSH is coming soon and will replace them; see the note at the top.

## Limits

- iOS only. Android support will be added shortly.
- One app per project root. Monorepos with dependencies outside the app directory are not supported.
- `build --prebuild` reinstalls dependencies with the package manager whose lockfile is present.
- Private npm packages need their token as an EAS environment variable in the `development` environment.

## Turn off the intro

`expo-devbox` and `expo-devbox init` open with an animated wordmark when you run them in a terminal. Set `EXPO_DEVBOX_INTRO=off` to skip it, or set it to `slider`, `decrypt`, `beams`, `snap` or `slide` to pick one.

## Developing expo-devbox

The CLI is at the root of this repository: `src/` holds the commands and the worker script, `templates/` holds the workflow that `init` writes, and `test/` holds the unit tests.

```sh
bun install
bun run typecheck
bun test
bun link && bun install -g .    # put this checkout on your PATH as expo-devbox
```

### The example app

[`example/`](example) is the app to test the CLI against, end to end, on a real EAS worker. It has a local Expo module, [`modules/native-crypto`](example/modules/native-crypto). The module wraps CryptoKit SHA-256, SHA-384, SHA-512 and HMAC-SHA256, and `SecRandomCopyBytes`. On launch, [`App.tsx`](example/App.tsx) checks the module against published test vectors (FIPS 180-2 and RFC 4231). It logs a `[native-crypto] PASS` or `FAIL` line for each check, then `[native-crypto] DONE`. [`devbox.json`](example/devbox.json) makes `build` wait for `DONE` and fail on `FAIL`.

The example does not depend on `expo-devbox`. Run the linked CLI from the example's directory:

```sh
cd example
bun install
expo-devbox start
expo-devbox build
expo-devbox stop
```

To use your own EAS account, delete `owner` and `extra.eas` from `example/app.json` and run `eas init` in `example/`.

Before a release, run these checks in the example. Edit the app, run `expo-devbox build`, and check the exit code and the message; then revert the edit.

| Change | Expected result |
| --- | --- |
| None | exit 0, `DONE 7/7 passed`, the `module created` line in the native log |
| A wrong expected value in `App.tsx` | exit 1, `matching failOn` |
| A Swift type error | exit 1, the error with file and line |
| `fatalError()` in the module's `OnCreate` | exit 1, the crash report frames |
| `build --prebuild` | exit 0 |
| `.env.local` present, then `sync` | the file is not on the worker |
| `expo-devbox ssh 'pkill -9 cloudflared'`, then `build` | `build` reconnects on its own, exit 0 |
| `stop` | `The devbox session is canceled.` |

After you change `templates/ios-devbox.yml`, run `expo-devbox init --force --no-agents` in `example/` to update its workflow.
