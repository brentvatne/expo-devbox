# iOS devbox on EAS Workflows

Write native code locally, compile it with Xcode on an EAS macOS worker, and test it on that worker's iOS Simulator. One workflow run stays up for the session, so each rebuild is incremental. Your machine only edits files.

The example module is `modules/native-crypto`: CryptoKit SHA-256, SHA-512 and HMAC-SHA256, and `SecRandomCopyBytes`. `App.tsx` runs known-answer tests on the simulator and logs `[native-crypto] PASS|FAIL` lines; `devbox.env` tells the build to wait for them.

## Requirements

- An EAS account on a plan with macOS workflow minutes. A session holds one macOS concurrency slot and bills for as long as it runs. Check your plan's price and job time limits.
- `eas-cli`, logged in. To use this repository on your own account, delete `owner` and `extra.eas` from `app.json` and run `eas init`.
- `cloudflared` (`brew install cloudflared`).

## Use

```sh
./scripts/devbox.sh start 60 15     # session of at most 60 minutes; ends after 15 idle minutes
./scripts/devbox.sh build           # sync, xcodebuild, launch, print logs, copy the screenshot
./scripts/devbox.sh build --pods    # same, after adding or removing native files or editing a podspec
./scripts/devbox.sh build --prebuild  # same, after changing package.json, app config or config plugins
./scripts/devbox.sh ssh             # shell in ~/project on the worker
./scripts/devbox.sh ssh 'xcrun simctl list devices booted'
./scripts/devbox.sh logs native-crypto
./scripts/devbox.sh stop            # cancel the session and wait until it has ended
```

`build` exits non-zero when:

- the build fails (it prints the compiler errors with file and line, or the end of the log),
- the app is not running after launch (it prints the crash report),
- the app never logs a line matching `DEVBOX_WAIT_FOR`, or logs one matching `DEVBOX_FAIL_ON` (see `devbox.env`).

It prints the app's console output and its native log from that launch, and copies the screenshot to `.devbox/screenshot.png`.

## How it works

`.eas/workflows/ios-devbox.yml` runs one custom job on `macos-large` in the `development` environment:

1. Starts `sshd` as the build user on `127.0.0.1:2222`. Only the key from the `ssh_public_key` input can log in. SSH sessions get the toolchain variables (`PATH`, Ruby, nvm) but not the job's EAS variables or its `EXPO_TOKEN`. The job itself still has them, and the SSH user is the job user.
2. Exposes `sshd` with a pinned `cloudflared` [quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/). EAS workers accept no inbound connections, so the worker dials out and Cloudflare relays. The job log prints the tunnel host and the worker's SSH host key; `devbox.sh` reads them with `eas workflow:logs <job-id>` and pins the key. Quick tunnels have no uptime guarantee. If the tunnel exits, the worker starts a new one with a new host; run `devbox.sh attach`.
3. Runs `expo prebuild` (skipped when the project commits `ios/`), `pod install`, and boots an iPhone simulator.
4. Starts Metro with `CI` unset (with `CI=true`, Metro does not reload changed files), runs a first Debug build, then stays up until `minutes` after the job started, or until no SSH connection has been open for `idle_minutes`. It restarts Metro if Metro stops responding.

`devbox.sh sync` sends the files git would track: patterns from `.gitignore` are excluded, so local secrets stay local and generated files on the worker are not deleted. It does not support `.gitignore` lines that start with `!`.

EAS has built-in workflow SSH (`eas workflow:run --ssh`, `eas workflow:ssh <job-id> [command]`) that is not yet available in production. When it is, it replaces steps 1 and 2.

## Limits

- One app per project root. Monorepos with dependencies outside the app directory are not supported.
- The app is found as the only `.app` in the Debug simulator products; set `DEVBOX_SCHEME` in `devbox.env` if the scheme is not named after the workspace.
- `--prebuild` reinstalls dependencies with the package manager whose lockfile is present.
