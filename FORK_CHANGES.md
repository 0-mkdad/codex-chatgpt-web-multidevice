# MultiDevice fork

This public fork keeps upstream attribution and the MIT license while adding a safe per-install connector identity and isolated desktop packaging.

## Connector identity

- The default remains `Codex Native2`.
- Automatic mode accepts `--connector-name NAME`, trims it, validates it, and persists it in the existing configuration.
- Re-running setup preserves the selected automatic connector instead of silently restoring the default.
- Zero Risk remains a separate `Codex Zero Risk` connector and is not renamed by this change.
- Connector selection remains exact-match and fail-closed; names that do not contain `codex` are valid.

## Packaging

The launcher uses a distinct Electron app ID, NSIS GUID, product name, artifact name, Windows install lookup, and application-data directory so the fork can coexist with the upstream launcher.

## Upstream synchronization

```text
git fetch upstream
git merge upstream/main
```

Resolve conflicts by preserving the connector identity boundary, the fork packaging identifiers, and the regression tests before pushing the feature branch.
