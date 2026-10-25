This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md

## Native iOS builds on EAS (expo-devbox)

Compile and test native iOS code on an EAS macOS worker with `bunx expo-devbox`, not on this machine. Do not run `npx expo run:ios` or `xcodebuild` locally.

1. Start a session once: `bunx expo-devbox start`. It bills EAS macOS minutes until `stop`, its time limit (60 minutes by default), or 15 minutes without a connection.
2. After each change, run `bunx expo-devbox build`. Add `--pods` after adding or removing native source files or editing a podspec, and `--prebuild` after changing package.json, the app config or a config plugin.
3. `build` syncs your files, compiles, launches the app on the worker's iOS Simulator, and prints the app's console and native logs. It exits non-zero on a compile error (with file and line), a crash at launch (with the crashing frames), or a failed check from devbox.json. Read the output, fix the code, and build again. The screenshot is `.devbox/screenshot.png`.
4. `bunx expo-devbox ssh '<command>'` runs a command in the project directory on the worker, for example `xcrun simctl list devices booted`.
5. When you are done, run `bunx expo-devbox stop`.
