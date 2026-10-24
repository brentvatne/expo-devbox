# iOS devbox on EAS Workflows

Write native code locally, compile it with Xcode on an EAS macOS worker, and test it on that worker's iOS Simulator. One workflow run stays up for the whole session, so each rebuild is incremental. Your machine only edits files.

The example module is `modules/native-crypto`: CryptoKit SHA-256, SHA-512 and HMAC-SHA256, and `SecRandomCopyBytes`. `App.tsx` runs known-answer tests and logs `[native-crypto] PASS|FAIL` lines.

## Requirements

- `eas-cli`, logged in, with this project linked (`extra.eas.projectId` in `app.json`).
- `cloudflared` (`brew install cloudflared`).

## Use

```sh
./scripts/devbox.sh start 120          # start a run that stays up for 120 minutes, wait for SSH
./scripts/devbox.sh build              # sync sources, xcodebuild, launch, print app logs, copy the screenshot
./scripts/devbox.sh build --pods       # same, after adding or removing native files or editing a podspec
./scripts/devbox.sh ssh                # interactive shell in ~/project
./scripts/devbox.sh ssh 'xcrun simctl list devices booted'
./scripts/devbox.sh logs native-crypto # search all app console output from Metro
./scripts/devbox.sh stop               # end the run
```

`build` exits non-zero when the build fails and prints only the compiler errors, with file and line. The full log is `build/xcodebuild.log` on the worker. After a successful build it prints the app's console output from that launch and copies the screenshot to `build/devbox/screenshot.png`.

Typical timings on `macos-large`: about 4 minutes from `start` to the first build (prebuild, `pod install`, a full Debug build), then 15 to 30 seconds per `build` for a change to one Swift file.

## How it works

`.eas/workflows/ios-devbox.yml` runs one custom job on `macos-large`:

1. Starts `sshd` as the build user on `127.0.0.1:2222`. Only the key passed in the `ssh_public_key` input (base64) can log in.
2. Exposes it with a [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/). EAS workers accept no inbound connections, so the worker dials out and Cloudflare relays. The job log prints `DEVBOX_SSH_HOST`. `eas workflow:logs` returns nothing while a job runs, so `scripts/devbox-host.mjs` reads the live log file through the Expo API and `devbox.sh` writes `build/devbox/ssh_config`.
3. Runs prebuild, `pod install`, and boots an iPhone simulator.
4. Starts Metro with `CI` unset (with `CI=true`, Metro does not reload changed files), runs a first Debug build to warm DerivedData, then waits until `minutes` passes or `~/devbox-done` exists.

The run bills as EAS Workflows macOS time for as long as it is up. Run `stop` when you finish.

EAS has built-in workflow SSH (`eas workflow:run --ssh`, `eas workflow:ssh <job-id> [command]`) that is not yet available in production. When it is, it replaces steps 1 and 2.

## Debugging a failed run

```sh
node scripts/devbox-steplog.mjs <run-id> [step-id]   # e.g. step-id "ssh"
```
