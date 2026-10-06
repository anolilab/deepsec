# deepsec

## What this codebase is

deepsec is a developer CLI — a TypeScript pnpm monorepo shipping the `deepsec`
binary plus the `@anolilab/deepsec/config` sub-export. A developer runs `deepsec scan` /
`process` from a `.deepsec/` workspace inside their own repo to find security
issues with regex matchers + an AI agent (Claude Agent SDK or Codex SDK).
Optional fan-out to Vercel Sandbox microVMs for scaling. **No HTTP server, no
network listeners, no multi-user state, no DB.** It reads the developer's own
files and writes JSON under `.deepsec/data/<id>/`.

## Trust model — read this first; it controls almost every triage call

**deepsec runs as the developer, on the developer's inputs.** The vast majority
of "input validation / injection" candidates in this repo are false positives,
because there is no untrusted caller. Specifically, the following are TRUSTED
and you should NOT flag missing validation, traversal-by-input, or injection on
them:

- **CLI flags** (`--root`, `--project-id`, `--diff <ref>`, `--files`,
  `--files-from`, etc.) — the developer typed them at their own shell.
- **`deepsec.config.ts`** loaded via `jiti` in
  `packages/deepsec/src/load-config.ts` — the developer's own code. Loading
  arbitrary code from it is by design; that's how plugins work. Not a sandbox
  boundary.
- **Project source files** scanned from disk — read by matchers and the agent;
  never `eval`-ed, never `exec`-ed.
- **Environment / `.env.local`** — secrets the developer set on their machine.
- **Git output** (`git diff --name-only`, `git remote`, `git log`,
  `git rev-parse`) — local-repo state. Treat as trusted.
- **`projectId` / `runId` / `filePath` segments fed to `path.join` under
  `data/<id>/`** — the safety guards in `packages/core/src/paths.ts`
  (`assertSafeSegment`, `assertSafeFilePath`) defend against bugs in the
  scanner's own code, not against an attacker. Findings of the form "this path
  could contain `..`" are noise *unless* the segment originates from the one
  real boundary below.
- **`execSync` / `spawn` calls in `packages/core/src/run.ts`,
  `packages/processor/src/agents/`, and `packages/deepsec/src/`** when their
  args are static literals or come from the developer's config. Argument-array
  invocations (no shell) are trivially safe; flag only string-shell forms whose
  interpolated values originate from the boundary below.

**The actual trust boundary** in this repo: **data flowing back from a Vercel
Sandbox microVM** into the host. The sandbox executes scanner runs against an
extracted copy of the repo and ships back tarballs of `data/<id>/files/*.json`
+ run metadata. By design, the sandbox is treated as adversarial — anything
the host ingests from it (`packages/deepsec/src/sandbox/{download,upload}.ts`,
`merge-records.ts`) IS attacker-controlled. Path traversal in tar/zip entry
names, JSON-shape spoofing, oversize content, and symlink escape ALL matter
here. The custom matcher `archive-extraction-untrusted` exists for exactly
this surface.

The other genuine concern: **prompt-injection from scanned source into agent
tool calls.** Scanned content is pasted into the prompt by design — that's
fine. What's not fine is scanned content reaching the *arguments* of a tool
the agent invokes (shell, file write). The prompt template lives in
`packages/processor/src/index.ts` (`DEFAULT_PROMPT_TEMPLATE`).

## Auth shape

Not a webapp. The only auth-adjacent surfaces are:

- **Provider tokens** (`ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`,
  `AI_GATEWAY_API_KEY`, `VERCEL_TOKEN` / Vercel OIDC) loaded via `dotenv` at
  CLI startup.
- **Vercel Sandbox auth** in `packages/deepsec/src/sandbox/` — OIDC tokens
  (local) and access tokens (CI), passed to `@vercel/sandbox`.
- **Plugin contract** — `DeepsecPlugin` modules from `deepsec.config.ts` are
  fully trusted (developer's own code). Not a boundary.

## Things worth flagging (real signals, not noise)

- **Sandbox output handling** in `packages/deepsec/src/sandbox/` —
  extraction without entry-path validation, JSON parsing without shape
  validation, missing oversize/timeout guards, symlink-following on extract.
- **Token leakage into committed state** — anything that writes
  `process.env.ANTHROPIC_AUTH_TOKEN` / `OPENAI_API_KEY` / `VERCEL_TOKEN`
  (or anything matching the secret-pattern matchers) into
  `data/<id>/files/*.json`, `INFO.md`, run metadata, finding bodies, log lines,
  or argv visible to other processes via `ps`.
- **Prompt template echoing scanned content into tool args** — if `${snippet}`
  or any scanned text reaches a tool's command argument rather than just the
  prompt body, that's a real issue.
- **CI workflow auth scoping** — `.github/workflows/deepsec.yml` deliberately
  splits `analyze` (no write) from `comment` (write). Any change that grants
  the analyze job write access on the repo is a security regression.

## Known false-positives — do NOT flag

- **`packages/scanner/src/matchers/*.ts`** — matcher source contains regex
  literals shaped like `eval`, `exec`, `dangerouslySetInnerHTML`, secret
  formats, etc. Those are detection patterns, not vulnerabilities.
- **`packages/processor/src/index.ts` `DEFAULT_PROMPT_TEMPLATE`** — the
  literal string contains words like "RCE", "SQL injection", "secrets",
  "eval" because that's the agent's vocabulary. Not code.
- **`fixtures/vulnerable-app/`** — intentionally vulnerable test data
  (excluded from lint/knip per `CONTRIBUTING.md`). All findings here are
  by design.
- **`samples/webapp/`** — illustrative starter for new users; may contain
  deliberately bad patterns to demo matcher behavior.
- **`e2e/` and any `**/__tests__/**`** — fixtures, mocks, stub tokens, literal
  "password"/"secret" strings. Test data unless the test logic is wrong.
- **`assertSafeSegment` / `assertSafeFilePath` callers** — those guards ARE
  the validation. A finding noting "input could contain `..`" at a guarded
  callsite is the guard working. Flag the *absence* of a guard, not its
  presence.
- **`jiti.import(configPath)` in `packages/deepsec/src/load-config.ts`** —
  loading the developer's own config file. Trusted by design.
- **`execSync` in `packages/core/src/run.ts`** — git remote / branch detection
  with static argument arrays. Not a shell-injection vector.
- **`execSync` / `spawn` in `packages/processor/src/agents/`** — the developer
  chose to invoke an AI CLI; args are static or sourced from trusted config.
