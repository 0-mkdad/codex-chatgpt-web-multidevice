# MultiDevice fork status

This fork is maintained independently at `0-mkdad/codex-chatgpt-web-multidevice`. The upstream repository and its `main` branch were not modified.

## Implemented

- Automatic connector names can be configured with `setup --connector-name NAME` and are persisted in the runtime configuration.
- The desktop launcher exposes the same name during MCP setup and passes it through the validated CLI path.
- Connector names reject blank, control-character, and overlong values.
- Zero Risk keeps its separate connector identity; returning to Automatic restores the saved Automatic identity.
- Launcher package/application IDs and release artifact names are fork-specific to avoid collisions with upstream installs.
- `main` is public and protected: pull request required, one approval required, conversations resolved, force-push and deletion disabled.

## Verification

- Root TypeScript check: passed.
- Root targeted configuration/CLI tests: 35 passed.
- Launcher packaging/update contract tests: 16 passed, 2 skipped.
- Full launcher suite: 187 passed, 2 skipped. Four failures are environment-only on this Windows host: Electron binary was not downloaded, and one symlink test requires Windows Developer Mode or elevated privileges.

The launcher dependency install could not complete in this environment, so native Electron build/typecheck and packaged runtime smoke tests remain to be run in CI or on a machine with the Electron binary cache available.
