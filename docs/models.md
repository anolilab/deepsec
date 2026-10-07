---
title: "Models"
description: "Choose Codex, Claude, OpenCode, or Pi for process and revalidate runs, and compare models under the same workload."
---

deepsec talks to LLMs through interchangeable agent backends:

| Backend                     | Default model                   | Used by                 |
|-----------------------------|---------------------------------|-------------------------|
| `codex` (default)           | `gpt-5.5`                       | `process`, `revalidate` |
| `claude`                    | `claude-opus-4-8`               | `process`, `revalidate` |
| `opencode`                  | `anthropic/claude-opus-4-8`     | `process`, `revalidate` |
| `pi`                        | `zai/glm-5.2`                   | `process`, `revalidate` |
| `claude` (triage)           | `claude-sonnet-4-6`             | `triage` (Claude-only)  |

Interactive one-shot setup recommends five benchmark-backed combinations:
GPT-5.6 Sol, Claude Opus 5, Kimi K3, Grok 4.5, and the current DeepSeek entry.
Deepsec fetches the latest score, reasoning level, harness, and total run cost
from [DeepSecBench](https://vercel.com/ai-gateway/leaderboards/deepsecbench/results.json),
then displays cost relative to the cheapest recommendation. A bundled snapshot
keeps onboarding usable offline and is visibly marked as cached. You can also
paste any custom model slug.

Choose the backend/model non-interactively so repository analysis and the
first processing pass use the same pair:

```bash
npx @anolilab/deepsec init --agent codex --model gpt-5.5
```

For benchmark-backed headless selection, use a profile:

| Profile | Selection rule |
|---|---|
| `best` | Highest compatible DeepSecBench score |
| `value` | Highest score whose run cost is at most 2.5× the cheapest recommendation |
| `budget` | Cheapest compatible recommended combination |

```bash
npx @anolilab/deepsec init --yes --model-profile value --output jsonl
```

Direct OpenAI and Anthropic credentials automatically restrict profiles to a
compatible Codex or Claude harness; custom routes restrict them to Pi.

The built-in backends work with Vercel AI Gateway through the linked
workspace's OIDC credential. The model credential route is independent of the
Vercel/Sandbox project link and is persisted as non-secret `ai` config. Direct
OpenAI/Anthropic and custom Pi routes are documented in
[vercel-setup](vercel-setup.md).

There is also a `local` route (`--model-auth local`, or "Use local
subscriptions" in the interactive prompt) for machines where the `claude` or
`codex` CLI is already logged in. It configures no credential at all and
disables the env-var preflight checks — the machine-wide login is used
directly. Sandbox commands are the exception: they must broker a real token,
so they still require `AI_GATEWAY_API_KEY` (or an equivalent key).


The built-in backends also work with direct `AI_GATEWAY_API_KEY` credentials:
one key covers Codex, Claude, OpenCode, and Pi. OpenCode and Pi accept
provider/model identifiers directly, which makes them useful for comparing
harness and provider behavior under the same deepsec workload.

## Recommended models & ensemble strategy

The hard truth from [DeepSecBench](https://vercel.com/ai-gateway/leaderboards/deepsecbench/results.json)
(deepsec's own benchmark corpus of 232 known real vulnerabilities) and the
academic literature alike (SecVulEval's best agent: 23.8% F1; SecLens: "no
universal best model"): **no single model finds everything**. The best
model recovers ~36% of the known issues — so maximum recall is a strategy,
not a flag.

Three rules, in order of impact:

1. **Always run maximum thinking.** Recall collapses without it — the
   benchmark leader finds 35.8% of issues at `xhigh` but only 25% at
   `medium` on the same model.
2. **Run an ensemble of different model families, then union the
   findings.** Different training data misses different issues; deepsec is
   built for this — the same JSON contract across backends, findings
   accumulate per file, and `revalidate` cuts false positives and dedupes
   via `duplicate` verdicts.
3. **Don't pay for the runner-up.** The benchmark leader is also the
   cheapest top-tier option.

Benchmark snapshot (October 2026) — score is recall-weighted against
precision on the 232-issue corpus:

| Model | Harness | Thinking | Score | Recall | Precision | Cost/run |
|---|---|---|---|---|---|---|
| `gpt-6-sol` | `codex` | `xhigh` | 40.9 | 35.8% | 96.0% | $12.76 |
| `gpt-6-astra` | `codex` | `xhigh` | 37.8 | 32.8% | 97.9% | $63.70 |
| `gpt-5.6-sol` | `codex` | `xhigh` | 35.4 | 30.6% | 96.3% | $55.98 |
| `claude-opus-5` | `claude` | `max` | 32.4 | 28.0% | 88.0% | $127.93 |
| `gpt-6-luna` | `codex` | `xhigh` | 21.1 | 17.7% | 89.6% | $0.51 |

Successor models that postdate the snapshot (`gpt-6.1-sol`) are typically
as strong or stronger than their benched predecessor — treat the table as
a family ranking, not a frozen version list. Check the live leaderboard
for current numbers.

### The ensemble run

Pick two or three models from *different* families — an OpenAI-reasoning
model as the anchor, an Anthropic model as the second opinion, and an
open-weight model (GLM, Kimi, Qwen, Grok, DeepSeek) as the third. Findings
accumulate across runs; nothing is overwritten:

```bash
# Pass 1 — anchor: the benchmark-leading family, max thinking
pnpm deepsec process --project-id my-app \
  --agent opencode --model opencode/gpt-6.1-sol --thinking-level xhigh

# Pass 2 — second opinion from a different family
pnpm deepsec process --project-id my-app \
  --agent opencode --model opencode/claude-opus-5-5 --thinking-level max

# Pass 3 — open-weight third opinion (rarely refuses, different blind spots)
pnpm deepsec process --project-id my-app \
  --agent opencode --model opencode/glm-5.3 --thinking-level high

# Union cleanup — revalidate cuts false positives and dedupes the union
pnpm deepsec revalidate --project-id my-app \
  --agent opencode --model opencode/gpt-6.1-sol
```

Through the Vercel AI Gateway the same strategy works with the
benchmark-exact identifiers: `--agent codex --model gpt-6-sol` for the
anchor, `--agent claude --model claude-opus-5` for the second opinion.

### Refusals and unrestricted analysis

Some models occasionally refuse to investigate a candidate — usually
exploit-adjacent source that a safety filter misreads. deepsec never loses
those files (see [Refusals](#refusals)): refused batches stay `pending`,
nothing is silently dropped, and the run log shows a ⚠️ marker. In
practice the GPT-6/GPT-5.6 family and the open-weight models (GLM, Kimi,
Qwen, Grok, DeepSeek) refuse on well under 1% of batches; if a fully
unrestricted sweep matters more than family diversity, anchor on those and
keep the Anthropic pass optional.

### Value and free passes

- `gpt-6-luna` at `xhigh` costs **$0.51** per benchmark run with a
  mid-pack score — the best cost-per-finding for iterative work.
- The OpenCode runtime's free models (`opencode/fledge-alpha-free`,
  `opencode/space-bunny-free`, `opencode/muse-spark-1.3-contributor-free`,
  `opencode/longcat-2.5-preview-free`, `opencode/nemotron-3.5-lightning-free`)
  run at **$0** through `--agent opencode` — useful for an unrestricted
  first sweep before escalating the hits to a top-tier model.

## CLI selection

```bash
# Codex (default backend), default model:
pnpm deepsec process --project-id my-app

# Claude with a specific model:
pnpm deepsec process --project-id my-app --agent claude --model claude-sonnet-4-6

# Codex backend, default model:
pnpm deepsec process --project-id my-app --agent codex

# Codex backend, specific model:
pnpm deepsec process --project-id my-app --agent codex --model gpt-5.4

# OpenCode SDK harness (provider/model is required):
pnpm deepsec process --project-id my-app --agent opencode
pnpm deepsec process --project-id my-app --agent opencode --model openai/gpt-5.5

# Pi backend through Vercel AI Gateway, default model:
pnpm deepsec process --project-id my-app --agent pi

# Pi with an AI SDK / AI Gateway style model id:
pnpm deepsec process --project-id my-app --agent pi --model zai/glm-5.2

# Triage uses Claude; pass a cheaper model if you want:
pnpm deepsec triage --project-id my-app --model claude-haiku-4-5
```

`--agent`, `--model`, and `--thinking-level` are also accepted on `setup` and
`revalidate`. Setup persists the interactive choice as `defaultAgent`,
`defaultModel`, and `defaultThinkingLevel`, checkpoints the exact combination,
and invalidates affected phases when it changes.

## Thinking level

`process` and `revalidate` accept `--thinking-level` to control how much
reasoning effort the agent spends per batch:

```bash
pnpm deepsec process --project-id my-app --thinking-level high
```

Accepted values: `minimal`, `low`, `medium`, `high`, `xhigh`. The
default is `xhigh`. Deepsec optimizes for finding hard bugs, not for
cost. Dial down for cheaper reinvestigation waves or quick smoke runs
over large repos.

The flag maps onto each backend's native dial:

| Backend    | Setting                                                       |
|------------|---------------------------------------------------------------|
| `codex`    | model reasoning effort (`minimal`–`xhigh`)                    |
| `opencode` | provider variant (Anthropic maps to `high` / `max`)           |
| `pi`       | thinking level (`minimal`–`xhigh`)                            |
| `claude`   | adaptive-thinking effort (`minimal` → `low`, `xhigh` → `max`) |

It applies to the main investigation/revalidation runs only.
Special-purpose follow-up calls (the refusal report, JSON repair) keep
their own fixed, cheap settings regardless of the flag.

Like other subcommand flags, it passes through sandbox mode unchanged:

```bash
pnpm deepsec sandbox process --project-id my-app --sandboxes 30 --thinking-level high
```

## Why these defaults

### `claude-opus-4-8` for `process` and `revalidate`

Investigating a candidate site is a multi-step reasoning task: trace
control flow, recognize an auth boundary, decide whether input is
attacker-controlled, judge severity. Stronger reasoning models pay for
themselves in lower FP rate, even at higher per-call cost. Opus is the
strongest of the Claude family at this kind of code reasoning.

If cost matters more than precision (a 10k-file repo, a quick triaged
starter list), drop to `claude-sonnet-4-6`. Same prompt, ~3× cheaper,
~10–20% higher FP rate.

### `gpt-5.5` for the Codex backend

Codex is the OpenAI-flavored agent loop: grep-heavy, fast, runs in a
strict read-only sandbox. `gpt-5.5` is the right balance of reasoning
and cost for that loop. `gpt-5.5-pro` is the most careful Codex
option at significantly higher cost; `gpt-5.4` and below are fine for
follow-up reinvestigation passes.

### Pi for alternate harness runs

Pi uses `@earendil-works/pi-coding-agent` with read-only tools
(`read`, `grep`, `find`, `ls`) and the same deepsec prompt/schema as the
other backends. Its default model is GLM 5.2 through Vercel AI Gateway:

```bash
AI_GATEWAY_API_KEY=vck_...
pnpm deepsec process --project-id my-app --agent pi
```

Normal setup pulls and uses the exact linked workspace's OIDC credential.

For OpenAI-compatible gateways such as Martian, select and persist a custom
route during setup:

```bash
MARTIAN_API_KEY=...
pnpm deepsec setup --project-id my-app \
  --agent pi \
  --model openai/gpt-5.5 \
  --model-auth custom \
  --ai-provider martian \
  --ai-base-url https://api.withmartian.com/v1 \
  --ai-api-key-env MARTIAN_API_KEY \
  --ai-credential-header authorization:bearer
```

Later `process`, `revalidate`, and Sandbox commands resolve the persisted
route. Per-command `--ai-provider`, `--ai-base-url`, `--ai-api-key-env`, and
repeatable `--ai-header name=value` remain available as Pi runtime overrides.

### OpenCode SDK harness

OpenCode uses `@opencode-ai/sdk/v2` plus the `opencode` runtime — both the
v1 runtime (npm `opencode-ai` 1.x, bundled for sandbox workers) and the
**OpenCode v2** runtime (2.0.x) are supported; the generation is detected at
startup and the matching protocol is used automatically. Each batch starts a
private, password-secured local OpenCode server, creates a session rooted at
the target project, and asks for JSON output. The deepsec agent allows only
`read`, `glob`, `grep`, and `list`; shell, edits, network tools, subagents,
external directories, LSP, skills, and MCP-triggered permissions are denied.
The session and server are closed on success, error, or abort.

Differences worth knowing:

- The v1 runtime returns JSON Schema–validated structured output when the
  model supports it; the v2 runtime has no structured-output prompts, so
  results arrive as plain text and go through deepsec's shared JSON-repair
  pipeline (same contract, same validation).
- The v2 runtime always requires basic auth on its server; deepsec generates
  the credential itself and nothing is written to disk.
- `--ai-header` overrides require the v1 runtime; on v2 they are rejected
  with a clear error.

**Vercel AI Gateway on the v2 runtime** — two supported options:

- Native gateway provider (recommended): the v2 model catalog ships a
  `vercel` provider ("Vercel AI Gateway") that reads `AI_GATEWAY_API_KEY`
  directly — one key covers every model behind the gateway:

  ```bash
  AI_GATEWAY_API_KEY=vck_… pnpm deepsec process --project-id my-app \
    --agent opencode \
    --model vercel/anthropic/claude-opus-4-8
  ```

- The standard `ANTHROPIC_*`/`OPENAI_*` expansion also keeps working:
  deepsec translates the expansion into the v2 provider `baseURL` overlays
  and bridges the gateway bearer token to the `x-api-key` form the v2
  anthropic provider reads, so `--model anthropic/claude-opus-4-8` with
  `AI_GATEWAY_API_KEY` routes through the gateway unchanged.

Models use OpenCode's required `provider/model` form:

```bash
pnpm deepsec process --project-id my-app \
  --agent opencode \
  --model anthropic/claude-opus-4-8
```

For a local run without environment credentials, authenticate a provider in
OpenCode first: run `opencode`, then use `/connect`. Sandbox runs cannot reuse
that local credential store; use AI Gateway or an explicit provider token.
Generic `--ai-provider`, `--ai-base-url`, `--ai-api-key-env`, and
`--ai-header` overrides work for OpenCode as they do for Pi (headers v1
runtime only).

### `claude-sonnet-4-6` for `triage`

Triage buckets findings into P0/P1/P2/skip without re-reading the code.
It just looks at the finding text. That's a cheap task; Opus is
overkill. Sonnet keeps `triage` at ~1¢/finding.

## Refusals

Models occasionally refuse to investigate a candidate — usually when the
source contains an exploit pattern they read as harmful, or when a path
trips a content filter. After every batch, deepsec issues a follow-up
turn asking the agent whether it skipped or declined anything:

> Looking back at the investigation: was there anything you declined
> to fully analyze, refused to look at, or skipped because the content
> or the task felt uncomfortable or out of scope?

The agent answers in a structured JSON shape (see `parseRefusalReport`
in `packages/processor/src/agents/shared.ts`). If `refused: true`, the
batch gets a `refusal` record in run metadata, the per-batch log line
shows a ⚠️ `refusal` marker, and the `refusal` field on the FileRecord
sticks around for audit. No silent skips.

Claude Opus and `gpt-5.5` refuse less than 1% of batches in practice. A
refused batch produces no false negatives — affected files stay
`pending` (revalidation keeps the original verdict), so re-running
`--reinvestigate` against the other backend picks up the dropped sites.
Findings dedupe across agents, so you don't pay twice.

If a single file consistently triggers a refusal (>5% of batches), it's
usually one path with a hard-to-disambiguate exploit pattern. Add it to
`config.json:ignorePaths`, or run that file alone with `--batch-size 1`
so the refusal doesn't take a batch of otherwise-fine files down with
it.

## Future models (e.g. Anthropic Mythos)

The model is a flag, not a baked-in choice. When a stronger reasoning
model lands — Anthropic's Mythos, a next-tier OpenAI release, an
open-weight contender — point `--model` at the new identifier and the
rest of deepsec stays unchanged:

```bash
pnpm deepsec process --project-id my-app --model anthropic-mythos-1
pnpm deepsec process --project-id my-app --agent codex --model gpt-6
pnpm deepsec process --project-id my-app --agent opencode --model anthropic/claude-mythos-1
pnpm deepsec process --project-id my-app --agent pi --model vercel-ai-gateway/openai/gpt-6
```

Two small integration points:

1. **The model identifier** — whatever string the provider's SDK
   accepts. deepsec passes it through unchanged. No code change needed
   to *use* a new model on either backend.
2. **Pricing for the cost-per-batch readout.** The Claude Agent SDK
   reports cost natively, so new Claude-family models drop in with
   zero code changes. Codex doesn't, so add a line to
   `MODEL_PRICING_USD_PER_M_TOKENS` in
   `packages/processor/src/agents/codex-sdk.ts` for each new
   OpenAI/Codex model. Without it, the batch still runs — the cost
   readout is simply omitted.

When a new model becomes the right default, change the relevant entry
in `packages/deepsec/src/agent-defaults.ts` (one string per backend) and
the `DEFAULT_MODEL` constant in the corresponding agent file. Existing
data and findings are unaffected — deepsec records which agent + model
produced each finding, so a model change shows up cleanly in the
`analysisHistory` of any re-investigated file.

A useful pattern when a new model lands: re-run `process` with
`--reinvestigate <N>` (a wave marker) against the existing
high-severity findings to see whether the new model overturns
verdicts. The wave marker tags the new analysis without losing the
old one.
