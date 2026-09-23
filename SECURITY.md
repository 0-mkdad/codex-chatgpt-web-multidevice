# Security policy

Do not open public issues containing ChatGPT cookies, browser storage, tunnel IDs, API keys,
Codex prompts, tool results, or local filesystem paths. Redact diagnostic bundles before sharing.

The daemon binds only to loopback. If another local user can access your account or application
home, treat the browser session and tunnel key as compromised and rotate them.

Read the complete [security model](docs/security-model.md) before enabling full mode. In particular,
full mode lets an untrusted model response request tools from the current Codex turn; keep connector
action control, Codex sandboxing, and approvals aligned with the workspace's risk.

The MCP SDK currently permits `@hono/node-server` versions `^1.19.9 || ^2.0.5` even though this
project uses only its stdio transport. The root override and lockfile force that transitive HTTP
adapter to the reviewed `2.0.12` release. `bun audit`, the MCP protocol test, and the compiled-binary
smoke test are release gates; keep the override until normal dependency resolution can provide a
reviewed version without weakening those gates.

Report vulnerabilities through the repository's private GitHub Security Advisory flow. Do not open
a public issue or publish a proof of concept that exposes credentials or arbitrary local tool
execution before coordinated disclosure.
