<p align="center">
  <img src="assets/readme/hero.svg" width="960" alt="Switch to web models. Stay in Codex. Your ChatGPT plan. Your workflow. Maximum capabilities.">
</p>

<p align="center">
  <a href="https://github.com/0-mkdad/codex-chatgpt-web-multidevice/releases">Downloads and releases</a>
</p>

<p align="center">
  <img src="assets/demo.gif" width="960" alt="A live ChatGPT Web turn using the native Codex harness">
</p>

<p align="center">
  <a href="#get-started">Get started</a> · <a href="https://github.com/0-mkdad/codex-chatgpt-web-multidevice/releases">What’s new</a> · <a href="docs/architecture.md">Architecture</a> · <a href="TROUBLESHOOTING.md">Troubleshooting</a>
</p>

Use the ChatGPT Web models available on your account, including Pro, from Codex’s native model picker—with ChatGPT Web’s separate usage limits, without spending your Work or Codex quota. Keep the same interface, tasks, images, and streaming.

Full harness mode connects ChatGPT to the current task’s files, terminal, tools, and approvals through MCP. Conversations stay tied to your Codex task, so you can keep working as the context grows.

## Project relationship

This repository is an independent fork and ongoing extension of the existing open-source
[miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web) project. It is not an
original implementation created from scratch by the current maintainer. Upstream attribution,
the original license, and the upstream project’s terms remain applicable; the changes maintained
here are documented in [FORK_CHANGES.md](FORK_CHANGES.md).

<div id="get-started"><a id="quick-start"></a></div>

## Get started

**Available models:** Free/Go → **Luna / Think**. Accounts with reasoning controls → **Instant–High**, plus **Extra High** and **Pro** when available. The launcher detects what your account can use.

1. **Install the launcher** using the download for your system above.
2. **Sign in to ChatGPT** in the embedded browser and run the browser smoke test.
3. **Install models**, restart Codex once, and choose a ChatGPT Web model ending in **(Web)**. Pro modes have separate entries; Sol's Effort comes from Codex's native Effort control. Zero Risk keeps its dedicated entry.
4. **For coding with tools**, open **MCP** in the launcher and complete the Full harness setup below.

The app includes its browser and runtime. No separate Chrome, Node, or Bun installation is needed.

<details>
<summary><strong>Terminal install, updates & repair</strong></summary>

Quit the launcher before updating. These installers select the platform and architecture, verify the published checksums, and preserve your ChatGPT profile and launcher settings.

Download the installer for your platform from the [latest release page](https://github.com/0-mkdad/codex-chatgpt-web-multidevice/releases/latest). The release page is the source of truth for currently published assets; do not assume that every platform asset exists in every release.

</details>

<details>
<summary><strong>Models, modes & MCP setup</strong></summary>

<a id="modes"></a>

Automatic modes offer Luna/Think when the account has no reasoning selector; otherwise Instant–High, with Extra High and Pro available independently when exposed by the account.

| Mode | Sending messages | Local Codex tools |
| --- | --- | --- |
| **Browser-only** | Automatic | No |
| **Full harness (With Automation)** | Automatic | Yes, through MCP |
| **Zero Risk** | Paste and send manually | Yes, through a separate MCP connector |

Zero Risk does not read or operate the ChatGPT page. Choose the model and `Codex Zero Risk` connector yourself, paste and send the prepared prompt, then confirm **Sent** in the launcher. Automatic model entries ending in **(Web)** expose supported Effort choices in Codex; Instant and each Pro mode have separate entries. Existing saved model entries retain their original mode.

The launcher can track estimated usage through its own browser for Pro $100 and Pro $200 plans. It records accepted sends on this device, shows rolling 24-hour and 7-day counts, and flags when observed usage reaches 75% of a published reference limit. Activity outside this launcher is excluded, and these estimates do not show the account's remaining allowance or reset time. Tracking is unavailable in Zero Risk.

**Bigger Context (experimental)** sends large turns in up to six ordered parts and raises the advertised context and compaction thresholds to 3×. Small turns stay on the usual single-message path. Multi-part turns resend more context and can increase rate limits or cooldowns; this setting is off by default.

<a id="full-harness"></a>

### Full harness

Full mode connects ChatGPT's tool calls back to the current Codex task through the official
[OpenAI tunnel-client](https://github.com/openai/tunnel-client). The tunnel is outbound: it does
not expose a public IP, open an inbound port, or require router forwarding.

The launcher's **MCP** page guides the complete setup. For the exact clicks, see the
[video walkthroughs](TROUBLESHOOTING.md).

> **Limits**
>
> See the [repository discussions](https://github.com/0-mkdad/codex-chatgpt-web-multidevice/discussions) for the current
> ChatGPT message allowances for **GPT-5.6 Sol Pro** and **GPT-6 Astra**. Context limits depend on
> the account type and selected effort. Plus Medium/High uses a measured 90,000-token window, or
> up to 270,000 tokens with experimental **3× context** enabled, with native Codex compaction
> supported throughout.

1. Finish the required setup, open **MCP**, create a Tunnel and regular API key for this computer, then press **Connect harness**.
2. In the launcher, set this computer's **Connector name**. Use a different name on each computer; the default is **Codex Native2**. Enable ChatGPT **Developer Mode** and create a new Tunnel connector with that exact name, **Authentication: None**, and **Allow all actions**.
3. Run **Verify runtime** to confirm that the selected connector is attached and available.

Each computer keeps its launcher settings, browser login, runtime configuration, Tunnel credentials, and connector name in its own local profile. For multiple computers, create a separate Tunnel and regular API key on each, and assign each a distinct connector name. The fixed **Codex Zero Risk** identity stays separate. The launcher preserves the chosen automatic name across setup and restart; the CLI also accepts `setup --connector-name "Laptop Connector"`.

Write/modify actions also require the ChatGPT workspace and its administrator policy to permit
them. See
[developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).
Unexpected approval prompts fail closed unless `--auto-approve-tool-calls` is explicitly enabled;
that option clicks **Allow once**, never a permanent grant.

</details>

<details>
<summary><strong>Diagnostics & subagents</strong></summary>

<a id="operations"></a>

Use **Activity** for safe local diagnostics and **Settings → Run doctor** for end-to-end health.
Settings also includes **New browser chat for each turn**, which is off by default and available in Automatic mode. It starts each turn from the same Codex task in a fresh ChatGPT conversation, reattaches the connector, and may resend more context. **Save chats in ChatGPT** is also off by default; it keeps task conversations in account history, where ChatGPT memory and custom instructions may apply. Settings can also cancel a retained browser turn or remove the Codex integration before uninstall.
Set `CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1` only when every browser checkpoint needs a screenshot.

New installs use **Compatibility V1** for cross-backend subagents. **Native** preserves Codex's own
feature settings and enables plaintext Web-to-Web V2 delegation. Restart Codex and start a new task
after changing the protocol:

```bash
codex-chatgpt-web subagents status
codex-chatgpt-web subagents compatibility-v1
codex-chatgpt-web subagents native
```

</details>

<details>
<summary><strong>Requirements & security</strong></summary>

<a id="limitations-and-security"></a>

- This is unofficial browser automation, not an OpenAI API. ChatGPT UI changes can break selectors;
  drift fails explicitly instead of silently switching model or transport.
- Browser state is a sensitive login artifact, and the loopback listener is reachable by processes
  running as the same local user. Never share the launcher profile; use a trusted workstation.
- Release packages currently target macOS 13+ (arm64/x64), Windows x64, and Linux x64/arm64. Runtime,
  tests, and packaging are gated on all three in CI; account-bound browser and MCP flows use the
  separate [release validation](docs/release-validation.md).
- Builds are not yet platform-signed, so Gatekeeper or SmartScreen may warn. The installers verify
  the published SHA-256 manifest before installation.

Read the complete [architecture](docs/architecture.md) and
[security model](docs/security-model.md) before enabling full mode. Report vulnerabilities through
[SECURITY.md](SECURITY.md).

Temporary Chat is a [ChatGPT privacy mode](https://help.openai.com/en/articles/8914046-temporary-chat-faq); prompts are still processed by OpenAI.

Validation coverage: [release validation](docs/release-validation.md).

This is independent software and is not affiliated with or endorsed by OpenAI. Use it only with
your own account and in accordance with applicable [Terms of Use](https://openai.com/policies/terms-of-use/)
and workspace policies; it does not bypass authentication or access controls.

</details>

<details>
<summary><strong>Run from source & develop</strong></summary>

<a id="development"></a>

```bash
git clone https://github.com/0-mkdad/codex-chatgpt-web-multidevice.git && \
cd codex-chatgpt-web-multidevice && \
bun run app
```

This source path requires Bun 1.4.0. The command installs locked dependencies and opens the app.

```bash
bun run app
bun run dev:launcher
bun run src/cli.ts dev status
bun run dev:chat compaction-lab "Reply with exactly: DEV READY"
bun run verify
bun run smoke:subagents
bun run app:package
```

`dev:launcher` uses a separate profile and account under `~/.codex-chatgpt-web-dev`. `dev:chat` exercises the real browser and compaction paths with explicit simulated tool results, without changing your normal Codex route. See the [DEV chat harness](docs/dev-chat.md) for setup and commands.

</details>

---

[Troubleshooting](TROUBLESHOOTING.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE) · [CI](https://github.com/0-mkdad/codex-chatgpt-web-multidevice/actions/workflows/ci.yml)

