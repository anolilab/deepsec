<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./.github/assets/deepsec-logo-dark.svg" />
  <img src="./.github/assets/deepsec-logo.svg" width="120" alt="deepsec" />
</picture>

**Agent-powered vulnerability scanning for large-scale codebases — on your own infrastructure.**

[**Quick start**](#quick-start) · [**Documentation**](#docs) · [**Models & agents**](docs/models.md) · [**Configuration**](docs/configuration.md)

<br />

[![typescript-image][typescript-badge]][typescript-url]
[![Apache-2.0 licence][license-badge]][license]
[![Node][node-badge]][node]
[![pnpm][pnpm-badge]][pnpm]
[![CI][ci-badge]][ci]
[![npm version][npm-version-badge]][npm-version]
[![PRs Welcome][prs-welcome-badge]][prs-welcome]
[![OpenSSF Scorecard][scorecard-badge]][scorecard]

</div>

---

<div align="center">
    <p>
        <sup>
            Daniel Bannert's open source work is supported by the community on <a href="https://github.com/sponsors/prisis">GitHub Sponsors</a>
        </sup>
    </p>
</div>

---

## What is deepsec?

`deepsec` is an agent-powered vulnerability scanner that you run on your own infrastructure, optimized for on-demand review of all code in existing large-scale repos. It is designed to surface hard-to-find issues that have been lurking in applications for a long time.

It is configured to use the best models at maximum thinking levels (tunable via `--thinking-level`, see [models](docs/models.md)), meaning scans can cost thousands or even tens-of-thousands of dollars for large codebases. Our customers have found the cost worth it for how quickly they were able to patch vulnerabilities that would have otherwise gone unfixed.

For large codebases, work fans out across worker machines in parallel. If a run is interrupted or errors out partway through, just re-run the same command — deepsec picks up where it left off, skipping files it already analyzed and only investigating the rest.

## What's improved vs. the original

This fork builds on [vercel-labs/deepsec](https://github.com/vercel-labs/deepsec) and adds:

- **OpenCode as an agent backend (`--agent opencode`).** Both OpenCode runtime generations work — v1 (npm `opencode-ai` 1.x, bundled for sandbox workers) and the new **OpenCode v2** (2.0.x), detected automatically at startup. The v2 runtime cannot be driven by the published SDK (a different API surface under `/api/…`, mandatory basic auth, an async prompt/wait inbox), so the backend speaks both protocols itself. Every batch runs in a private, password-secured OpenCode server with a read-only agent — only `read`, `glob`, `grep`, and `list`; shell, edits, network tools, subagents, external directories, LSP, and skills are denied. Works for `process`, `revalidate`, and the one-shot `init` repository analysis.
- **Vercel AI Gateway on the OpenCode backend.** On the v2 runtime, the native `vercel/` provider takes one `AI_GATEWAY_API_KEY` for every model behind the gateway (`--model vercel/anthropic/claude-opus-4-8`). The standard gateway credential expansion also keeps working — it is translated into v2 provider `baseURL` overlays, with the bearer token bridged to the `x-api-key` form the v2 anthropic provider reads.
- **No Vercel account needed for your own key.** `init --model-auth direct` no longer prompts for a Vercel login (upstream issue #164): the platform link — which only enables the optional Vercel Sandbox distribution — is reused silently when Vercel credentials exist and skipped otherwise, while your provider key is still resolved and verified.
- **Config matcher filtering works.** `matchers: { only, exclude }` in `deepsec.config.ts` is honored by `scan` (upstream issue #36); unknown slugs in the config fail loud instead of being silently ignored.
- **Your Codex subscription is respected.** A `codex login` subscription wins over a stray `OPENAI_API_KEY` in the environment — matching the codex CLI's own precedence — unless explicit gateway/base-URL routing is configured (upstream issue #32).
- **Nine upstream fix MRs merged** that repair open issues left sitting upstream: severity ordering (#48/#61), unknown `--matchers` slugs (#34/#75), triage data in exports (#64/#71), triage verdict matching (#118/#119), unparseable triage output (#120/#121), token-metrics table layout (#135/#149), non-coherent host mounts (#159/#160), provider policy refusals parsed as findings (#92/#137), and macOS test flakiness (#51/#50). Upstream issues #30, #29, #33, and #91 were verified as already fixed in current main.
- **Published as `@anolilab/deepsec`** with the same `deepsec` CLI and release automation via npm trusted publishing — no tokens in CI.

## Quick start

From the root of the repository you want to scan:

```bash
npx @anolilab/deepsec init
```

The command guides you through everything. It asks you to pick an AI model
(with benchmark scores and prices to compare) and how to pay for model
usage — your own OpenAI/Anthropic API key, or Vercel AI Gateway — and then
works unattended: it studies your codebase, scans it, and runs the AI
review. The only thing it adds to your repository is a `.deepsec/` folder
where all of its state and findings live.

If the run is interrupted for any reason — Ctrl-C, lost connection, a
spending limit — run `npx @anolilab/deepsec init` again and it continues
where it left off. To cap what a run may spend or how long it may take:

```bash
npx @anolilab/deepsec init --max-cost-usd 100 --max-duration 2h
```

When the scan finishes, get a readable report:

```bash
cd .deepsec
pnpm deepsec export --format md-dir --out ./findings
```

For later scans, work from inside `.deepsec/`:

```bash
pnpm deepsec scan        # fast pattern scan, free
pnpm deepsec process     # AI review of new candidates
pnpm deepsec revalidate  # optional, cuts false-positive rate
pnpm deepsec export --format md-dir --out ./findings
```

The [getting started guide](docs/getting-started.md) covers all of this in
more detail, including using your own OpenAI or Anthropic API key and
running from CI or a coding agent.

## Docs

After initialization, agents can read the exact documentation matching the
installed CLI at `.deepsec/node_modules/@anolilab/deepsec/SKILL.md` and
`.deepsec/node_modules/@anolilab/deepsec/dist/docs/`. Setup errors expose
these as absolute machine-readable paths.

- [Getting started](docs/getting-started.md) — set up and run your first scan
- [Reviewing changes](docs/reviewing-changes.md) — `process --diff` and CI gating
- [Supported technology](docs/supported-tech.md) — built-in coverage
- [Generated and hand-authored matchers](docs/writing-matchers.md)
- [Configuration](docs/configuration.md)
- [Plugins](docs/plugins.md)
- [Models](docs/models.md) — agent backends, thinking levels, credentials, [recommended models & ensemble strategy](docs/models.md#recommended-models--ensemble-strategy)
- [Project link and credentials](docs/vercel-setup.md)
- [Architecture](docs/architecture.md)
- [Data layout](docs/data-layout.md)
- [FAQ](docs/faq.md)
- [Samples](samples)
- [Contributing](CONTRIBUTING.md)

## AI agents

The AI review runs through an interchangeable agent backend, selected with
`--agent` (or `defaultAgent` in `deepsec.config.ts`). Same prompt, same JSON
output contract — you can mix backends within a repo and compare models
under the same workload.

| Backend | SDK | Default model |
|---|---|---|
| `codex` (default) | `@openai/codex-sdk` | `gpt-5.5` |
| `claude` | `@anthropic-ai/claude-agent-sdk` | `claude-opus-4-8` |
| `opencode` | `@opencode-ai/sdk/v2` + `opencode` runtime | `anthropic/claude-opus-4-8` |
| `pi` | `@earendil-works/pi-coding-agent` | `zai/glm-5.2` |

```bash
pnpm deepsec process --project-id my-app --agent claude
pnpm deepsec process --project-id my-app --agent opencode --model anthropic/claude-opus-4-8
```

### OpenCode backend

The `opencode` backend speaks both OpenCode runtime generations — the v1
runtime (npm `opencode-ai` 1.x, also bundled for sandbox workers) and the new
**OpenCode v2** (2.0.x) — detected automatically at startup, so it works
with whatever `opencode` you have installed. Each batch runs in a private,
password-secured OpenCode server with a read-only agent: only `read`,
`glob`, `grep`, and `list` are allowed; shell, edits, network tools,
subagents, external directories, LSP, and skills are denied.

For a local run without environment credentials, connect a provider first
(run `opencode`, then use `/connect`) and use its `provider/model` id:

```bash
pnpm deepsec process --project-id my-app \
  --agent opencode \
  --model openai/gpt-5.5
```

Through the Vercel AI Gateway, the v2 runtime also accepts the native
`vercel/` provider — one `AI_GATEWAY_API_KEY` covers every model behind the
gateway:

```bash
AI_GATEWAY_API_KEY=vck_… pnpm deepsec process --project-id my-app \
  --agent opencode \
  --model vercel/anthropic/claude-opus-4-8
```

See [models](docs/models.md) for the full backend reference, thinking
levels, credential routing, and the [recommended models & ensemble
strategy](docs/models.md#recommended-models--ensemble-strategy) for
maximum issue discovery.

## AI provider

By default, deepsec routes model calls through Vercel AI Gateway, which
gives access to every major model without provider-specific keys — one
`AI_GATEWAY_API_KEY` covers every agent backend above. You can instead
bring your own key — OpenAI, Anthropic, or a custom HTTPS provider — by
passing `--model-auth direct` with `--ai-provider` and `--ai-api-key-env`
to `init`; no Vercel account is needed in that mode. Deepsec only ever
stores the *name* of the environment variable holding your key, never the
key itself. See
[project link and credentials](docs/vercel-setup.md)
for the full reference.

When running locally, `deepsec` can also reuse existing Claude, Codex, Pi,
or OpenCode provider authentication — including a local `opencode` CLI
login (`opencode` → `/connect`) — for evaluation-scale scans.

If a `process` or `revalidate` run halts because the upstream credential
ran out of quota or credits, deepsec stops gracefully and tells you
where to top up. Re-run the same command afterward and it picks up
where it left off.

## Distributed execution (optional)

Large monorepos can fan work across [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) microVMs:

```bash
pnpm deepsec sandbox process --project-id my-app --sandboxes 10 --concurrency 4
```

Setup already verified the Vercel connection, so this needs no extra
onboarding. The local working tree is tarballed and uploaded; `.git` is
excluded. Model credentials remain host-side and are injected only at the
selected egress host.

## Security model of deepsec itself

Treat `deepsec` like a coding agent with full shell access on the enviroment that it is
running on. It is designed to run on trusted inputs (your source code) but you may still
be concerned about prompt injection due to external dependencies or vendored code.

Running on a sandbox (see above) does limit the potential exposure substantially:

- The API keys for the coding agents are injected outside of the sandbox and hence cannot be exfiltrated
- For the worker sandboxes, network egress from the sandbox is limited to coding agent hosts (Egress is allowed during the bootstrap process, but this does not run the coding agent)

## Workflow reference

| Command         | What it does                                             |
|-----------------|----------------------------------------------------------|
| `scan`          | Find candidate sites with regex matchers (fast, no AI)   |
| `process`       | AI investigation; emits findings + recommendation        |
| `process --diff`| PR-mode: scan + investigate only files changed in a diff |
| `triage`        | Lightweight P0/P1/P2 classification (cheaper model)      |
| `revalidate`    | Re-check existing findings; checks git history for fixes |
| `enrich`        | Add git committer info + (with a plugin) ownership data  |
| `report`        | Markdown + JSON summary for one project                  |
| `export`        | Per-finding JSON or directory of markdown files          |
| `metrics`       | Cross-project counts: severities, vulns by type, TPs     |
| `status`        | Snapshot of the project mirror                           |
| `sandbox <cmd>` | Run any of the above on Vercel Sandbox microVMs          |

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md). For security reports, see
[SECURITY.md](SECURITY.md). For community guidelines, see
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

Apache 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

<!-- badges -->

[typescript-badge]: https://img.shields.io/badge/Typescript-294E80.svg?style=for-the-badge&logo=typescript
[typescript-url]: https://www.typescriptlang.org/
[license-badge]: https://img.shields.io/badge/license-Apache--2.0-blue.svg?style=for-the-badge
[license]: ./LICENSE
[node-badge]: https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg?style=for-the-badge
[node]: ./package.json
[pnpm-badge]: https://img.shields.io/badge/pnpm-8.15.9-f69220.svg?style=for-the-badge
[pnpm]: ./package.json
[ci-badge]: https://img.shields.io/github/actions/workflow/status/anolilab/deepsec/ci.yml?branch=main&style=for-the-badge&label=CI
[ci]: https://github.com/anolilab/deepsec/actions/workflows/ci.yml
[npm-version-badge]: https://img.shields.io/npm/v/@anolilab%2Fdeepsec?color=cb3837&style=for-the-badge
[npm-version]: https://www.npmjs.com/package/@anolilab/deepsec
[prs-welcome-badge]: https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge
[prs-welcome]: ./CONTRIBUTING.md
[scorecard-badge]: https://api.scorecard.dev/projects/github.com/anolilab/deepsec/badge?style=for-the-badge
[scorecard]: https://scorecard.dev/viewer/?uri=github.com/anolilab/deepsec
