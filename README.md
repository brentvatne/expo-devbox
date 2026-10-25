# expo-devbox

This repository holds [`expo-devbox`](packages/expo-devbox), a CLI that builds and tests an Expo app's native iOS code on an EAS macOS worker. It also holds an example app that uses it. See [packages/expo-devbox/README.md](packages/expo-devbox/README.md) for usage, setup for coding agents, and how it works.

## The example app

The app at the root has a local Expo module, [`modules/native-crypto`](modules/native-crypto). The module wraps CryptoKit SHA-256, SHA-384, SHA-512 and HMAC-SHA256, and `SecRandomCopyBytes`. On launch, [`App.tsx`](App.tsx) checks the module against published test vectors (FIPS 180-2 and RFC 4231) and logs a `[native-crypto] PASS` or `FAIL` line for each check, then `[native-crypto] DONE`. [`devbox.json`](devbox.json) makes `expo-devbox build` wait for `DONE` and fail on `FAIL`.

The app installs the CLI from `packages/expo-devbox`, so the commands are the same as in any app:

```sh
npm install
bunx expo-devbox start
bunx expo-devbox build
bunx expo-devbox stop
```

To run it on your own account, delete `owner` and `extra.eas` from `app.json`, run `eas init`, and install `cloudflared` (`brew install cloudflared`).

## Developing the CLI

```sh
cd packages/expo-devbox
bun install
bun run typecheck
bun test
```

After you change `templates/ios-devbox.yml`, run `bunx expo-devbox init --force --no-agents` at the root to update the example app's workflow.
