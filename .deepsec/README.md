# deepsec

This directory holds the [deepsec](https://www.npmjs.com/package/deepsec)
config for the parent repo. Checked into git so teammates inherit
project context (auth shape, threat model, custom matchers) AND the
per-file investigation cache — committing `data/*/files/` is what
lets CI re-investigate only the files in the PR diff instead of
starting from scratch every run.

Currently configured project: `deepsec` (target: `..`).

## Setup

1. `pnpm install` — installs deepsec.
2. Add your AI Gateway token to `.env.local`. See
   `node_modules/@anolilab/deepsec/dist/docs/vercel-setup.md` after install.
3. Open the parent repo in your coding agent (Claude Code, Cursor, …)
   and have it follow `data/deepsec/SETUP.md` to fill in
   `data/deepsec/INFO.md`.

## Daily commands

```bash
pnpm deepsec scan
pnpm deepsec process     --concurrency 5
pnpm deepsec revalidate  --concurrency 5                  # cuts FP rate
pnpm deepsec export      --format md-dir --out ./findings
```

`--project-id` is auto-resolved while there's only one project in
`deepsec.config.ts`. Once you've added a second project, pass
`--project-id deepsec` (or whichever id you want) explicitly.

`scan` is free (regex only). `process` is the AI stage (≈$0.30/file
on Opus by default). Run state goes to `data/deepsec/`.

## Adding another project

To scan another codebase from this same `.deepsec/`:

```bash
pnpm deepsec init-project ../some-other-package   # path relative to .deepsec/
```

Appends an entry to `deepsec.config.ts` and writes
`data/<id>/{INFO.md,SETUP.md,project.json}`. Open the new SETUP.md
in your agent to fill in INFO.md.

## Layout

```
deepsec.config.ts        Project list (one entry per scanned repo)
data/deepsec/
  INFO.md                Repo context — checked in, hand-curated
  SETUP.md               Agent setup prompt — checked in, deletable
  files/                 One JSON per scanned source file — checked in
                         (the investigation cache; CI reads this)
  project.json           Absolute root path (gitignored — flips per machine)
  runs/                  Run metadata (gitignored — pure churn)
  reports/               Generated markdown reports (gitignored)
AGENTS.md                Pointer for coding agents
.env.local               Tokens (gitignored)
```

## Accepted risks

Findings deepsec flagged on its own source code that the team has reviewed
and consciously chosen to live with. Each is marked
`revalidation.verdict: "accepted-risk"` in the relevant
`data/deepsec/files/*.json` so it's filtered out of PR comments and default
exports.

### Codex `sandboxMode: "danger-full-access"` (`packages/processor/src/agents/codex-sdk.ts`)

Both `investigate` and `revalidate` start the Codex SDK with
`sandboxMode: "danger-full-access"` and `approvalPolicy: "never"`. Codex's
built-in sandbox refuses ~7% of perfectly legitimate read-only commands the
agent needs to do an investigation (cat / sed / rg into the target tree),
and a refused tool call silently corrupts the verdict — the model just gives
up on that path without telling us. Disabling Codex's sandbox is the only way
to keep investigations reliable today.

The trade-off: anyone running `deepsec process --agent codex` directly on
their host gets an LLM with full filesystem read/write/exec on the developer
machine, gated only by `networkAccessEnabled: false`. Combined with prompt
injection from scanned source (CLAUDE.md threat #3), a malicious repo can
stage exfil for a later run.

**Stay safe by**:
1. Default to **`--agent claude-agent-sdk`** when running locally against
   anything you don't trust.
2. For codex, prefer the fan-out path **`deepsec sandbox-all`** — that puts
   each codex run inside a Vercel Sandbox microVM, which is the real
   security boundary.
3. If you must run codex on the host directly, only do so against repos
   whose contents you'd be comfortable executing yourself.

We will revisit if Codex ships a less-aggressive sandbox mode that doesn't
refuse the read commands a security review needs.

### `commitAndPushData` redaction is best-effort, not airtight (`packages/deepsec/src/data-commit.ts`)

`scrubCommittedDataDir()` drops snippets for the matchers in `SECRET_SLUGS`
and fails the commit if any leftover candidate snippet still matches
`CREDENTIAL_RE`. That covers the common cases — `secrets-exposure`,
`secret-in-log`, JWT helpers, env-exposure, hardcoded provider tokens —
but it's a denylist with two known gaps:

- A new secret-bearing matcher whose slug isn't in `SECRET_SLUGS` will
  pass through unredacted unless its credential string also trips the
  regex.
- The fail-closed regex doesn't catch every credential format. E.g.
  Terraform `data` blocks emitting `token = "long-plaintext-value"` for a
  matcher slug we haven't enumerated.

The structurally-correct fix is moving redaction to scanner write-time
(have `CandidateMatch` carry a `redact: true` flag set by secret-bearing
matchers, applied in `writeFileRecord`). We accepted the residual risk
because `commitAndPushData` only runs against an explicit data repo with
user/CI opt-in — it's not invoked on every scan.

**Stay safe by**:
1. **When adding a secret-bearing matcher**, add its slug to
   `SECRET_SLUGS` in `packages/deepsec/src/data-commit.ts` as part of
   the same change.
2. Don't point `commitAndPushData` at a public data repo unless you've
   also reviewed `SECRET_SLUGS` against the matcher list in
   `packages/scanner/src/matchers/index.ts`.

## Docs

After `pnpm install`:

- Skill: `node_modules/@anolilab/deepsec/SKILL.md`
- Full docs: `node_modules/@anolilab/deepsec/dist/docs/{getting-started,configuration,models,writing-matchers,plugins,architecture,data-layout,vercel-setup,faq}.md`

Or browse on
[GitHub](https://github.com/vercel/deepsec/tree/main/docs).
