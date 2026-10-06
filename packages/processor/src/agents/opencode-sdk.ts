import { spawn } from "node:child_process";
import crypto from "node:crypto";
import net from "node:net";
import type { RefusalReport } from "@deepsec/core";
import {
  type AssistantMessage,
  type Config,
  createOpencodeClient,
  type OpencodeClient,
  type OutputFormat,
  type Part,
  type PermissionConfig,
} from "@opencode-ai/sdk/v2";
import { Agent as UndiciAgent, fetch as undiciFetch } from "undici";
import {
  AgentPolicyRefusalError,
  backoff,
  buildInvestigateJsonRepairPrompt,
  buildInvestigatePrompt,
  buildRevalidateJsonRepairPrompt,
  buildRevalidatePrompt,
  classifyQuotaError,
  formatJsonRepairFailureDebugText,
  isTransientError,
  jsonRepairFailureError,
  MAX_ATTEMPTS,
  type ParsedInvestigateResults,
  parseInvestigateResults,
  parseRefusalReport,
  parseRevalidateVerdicts,
  QuotaExhaustedError,
  REFUSAL_FOLLOWUP_PROMPT,
  runInvestigateFieldRepairLoop,
  writeParseFailureDebug,
} from "./shared.js";
import type {
  AgentPlugin,
  AgentProgress,
  BatchMeta,
  InvestigateOutput,
  InvestigateParams,
  InvestigateResult,
  RevalidateOutput,
  RevalidateParams,
  RevalidateVerdict,
} from "./types.js";

const DEFAULT_MODEL = "anthropic/claude-opus-4-8";
const DEFAULT_THINKING_LEVEL = "xhigh";
const DEFAULT_MAX_TURNS = 150;
const MAIN_AGENT = "deepsec";
const JSON_AGENT = "deepsec-json";

const DEEPSEC_SYSTEM_NOTE =
  "You are running inside the OpenCode harness for deepsec. Perform static source inspection only. Do not run the target application, execute shell commands, send network requests, modify files, or attempt exploitation. Return only the requested JSON value.";

interface OpenCodeAgentConfig {
  model?: string;
  maxTurns?: number;
  thinkingLevel?: string;
  aiProvider?: string;
  aiBaseUrl?: string;
  aiApiKeyEnv?: string;
  aiHeaders?: Record<string, string>;
}

interface OpenCodeModelRef {
  providerID: string;
  modelID: string;
}

/**
 * OpenCode runtime generation. The v1 runtime (npm `opencode-ai` 1.x, also
 * bundled for sandbox workers) serves the legacy HTTP API (`POST /session`,
 * `POST /session/:id/message`, structured output formats). OpenCode v2
 * (2.0.x, e.g. the `anomalyco/tap/opencode-v2` Homebrew package) serves a
 * new Effect HttpApi under `/api/…` with mandatory basic auth, an async
 * prompt/wait inbox, and no structured-output format — results arrive as
 * plain text that the shared JSON-repair pipeline validates.
 */
type OpenCodeProtocol = "v1" | "v2";

interface OpenCodeRunContext {
  protocol: OpenCodeProtocol;
  client: OpencodeClient | undefined;
  server: { url: string; close(): void };
  dispatcher: UndiciAgent;
  authHeader: string;
  sessionID: string;
  directory: string;
  model: { providerID: string; modelID: string; variant?: string };
  controller: AbortController;
  detachParentAbort: () => void;
}

interface OpenCodePromptResult {
  resultText: string;
  meta: Partial<BatchMeta>;
  turnCount: number;
  toolUseCount: number;
  progress: AgentProgress[];
}

interface OpenCodeResolvedText {
  resultText: string;
  recoveredStructuredText: boolean;
}

const INVESTIGATE_FORMAT: OutputFormat = {
  type: "json_schema",
  retryCount: 2,
  schema: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["filePath", "findings"],
      properties: {
        filePath: { type: "string" },
        findings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: [
              "severity",
              "vulnSlug",
              "title",
              "description",
              "lineNumbers",
              "recommendation",
              "confidence",
            ],
            properties: {
              severity: {
                type: "string",
                enum: ["CRITICAL", "HIGH", "MEDIUM", "HIGH_BUG", "BUG"],
              },
              vulnSlug: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              lineNumbers: {
                type: "array",
                items: { type: "integer" },
              },
              recommendation: { type: "string" },
              confidence: {
                type: "string",
                enum: ["high", "medium", "low"],
              },
            },
          },
        },
      },
    },
  },
};

const REVALIDATE_FORMAT: OutputFormat = {
  type: "json_schema",
  retryCount: 2,
  schema: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["filePath", "title", "verdict", "reasoning"],
      properties: {
        filePath: { type: "string" },
        title: { type: "string" },
        verdict: {
          type: "string",
          enum: ["true-positive", "false-positive", "fixed", "uncertain", "duplicate"],
        },
        reasoning: { type: "string" },
        adjustedSeverity: {
          type: "string",
          enum: ["CRITICAL", "HIGH", "MEDIUM", "HIGH_BUG", "BUG"],
        },
        duplicateOf: { type: "string" },
      },
    },
  },
};

const TEXT_FORMAT: OutputFormat = { type: "text" };

const READ_ONLY_PERMISSION: PermissionConfig = {
  "*": "deny",
  read: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  external_directory: "deny",
  bash: "deny",
  edit: "deny",
  task: "deny",
  todowrite: "deny",
  question: "deny",
  webfetch: "deny",
  websearch: "deny",
  lsp: "deny",
  skill: "deny",
  doom_loop: "allow",
};

const READ_ONLY_TOOLS: Record<string, boolean> = {
  read: true,
  glob: true,
  grep: true,
  list: true,
  bash: false,
  edit: false,
  write: false,
  patch: false,
  task: false,
  todowrite: false,
  question: false,
  webfetch: false,
  websearch: false,
  lsp: false,
  skill: false,
};

const NO_TOOLS = Object.fromEntries(Object.keys(READ_ONLY_TOOLS).map((name) => [name, false]));

function readConfig(config: Record<string, unknown>): OpenCodeAgentConfig {
  return {
    model: typeof config.model === "string" ? config.model : undefined,
    maxTurns: typeof config.maxTurns === "number" ? config.maxTurns : undefined,
    thinkingLevel: typeof config.thinkingLevel === "string" ? config.thinkingLevel : undefined,
    aiProvider: typeof config.aiProvider === "string" ? config.aiProvider : undefined,
    aiBaseUrl: typeof config.aiBaseUrl === "string" ? config.aiBaseUrl : undefined,
    aiApiKeyEnv: typeof config.aiApiKeyEnv === "string" ? config.aiApiKeyEnv : undefined,
    aiHeaders:
      config.aiHeaders && typeof config.aiHeaders === "object" && !Array.isArray(config.aiHeaders)
        ? (config.aiHeaders as Record<string, string>)
        : undefined,
  };
}

export function parseOpenCodeModel(model: string): OpenCodeModelRef {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(
      `OpenCode model must use provider/model format, got "${model}". ` +
        `For example: ${DEFAULT_MODEL}.`,
    );
  }
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  };
}

export function resolveOpenCodeVariant(
  providerID: string,
  thinkingLevel?: string,
): string | undefined {
  const explicit = thinkingLevel !== undefined;
  const level = thinkingLevel ?? DEFAULT_THINKING_LEVEL;
  const provider = providerID.toLowerCase();

  if (provider === "anthropic") return level === "xhigh" ? "max" : "high";
  if (provider === "openai") return level;
  if (provider === "google") {
    return level === "minimal" || level === "low" ? "low" : "high";
  }
  return explicit ? level : undefined;
}

export function shouldUseOpenCodeTextFormat(
  providerID: string,
  variant: string | undefined,
  format: OutputFormat,
): boolean {
  return (
    providerID.toLowerCase() === "anthropic" && Boolean(variant) && format.type === "json_schema"
  );
}

function providerCredentialEnv(providerID: string, cfg: OpenCodeAgentConfig): string | undefined {
  if (cfg.aiApiKeyEnv) return cfg.aiApiKeyEnv;
  if (providerID === "anthropic") {
    if (process.env.ANTHROPIC_AUTH_TOKEN) return "ANTHROPIC_AUTH_TOKEN";
    if (process.env.ANTHROPIC_API_KEY) return "ANTHROPIC_API_KEY";
  }
  if (providerID === "openai" && process.env.OPENAI_API_KEY) return "OPENAI_API_KEY";
  return undefined;
}

function anthropicBaseUrlForOpenCode(baseURL: string | undefined): string | undefined {
  if (!baseURL) return undefined;
  const normalized = baseURL.replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

export function buildOpenCodeConfig(config: Record<string, unknown>): Config {
  const cfg = readConfig(config);
  const requested = parseOpenCodeModel(cfg.model ?? DEFAULT_MODEL);
  const providerID = cfg.aiProvider ?? requested.providerID;
  const model = `${providerID}/${requested.modelID}`;
  const variant = resolveOpenCodeVariant(providerID, cfg.thinkingLevel);
  const maxTurns = cfg.maxTurns ?? DEFAULT_MAX_TURNS;
  const credentialEnv = providerCredentialEnv(providerID, cfg);
  const baseURL =
    cfg.aiBaseUrl ??
    (providerID === "anthropic"
      ? anthropicBaseUrlForOpenCode(process.env.ANTHROPIC_BASE_URL)
      : providerID === "openai"
        ? process.env.OPENAI_BASE_URL
        : undefined);

  const providerOptions: Record<string, unknown> = {};
  if (credentialEnv) providerOptions.apiKey = `{env:${credentialEnv}}`;
  if (baseURL) providerOptions.baseURL = baseURL;

  const provider =
    Object.keys(providerOptions).length > 0 || cfg.aiHeaders
      ? {
          [providerID]: {
            ...(Object.keys(providerOptions).length > 0 ? { options: providerOptions } : {}),
            ...(cfg.aiHeaders ? { headers: cfg.aiHeaders } : {}),
          },
        }
      : undefined;

  return {
    // No logLevel: the v1 runtime accepts "WARN" and the v2 runtime accepts
    // lowercase "warn" — the two CLIs disagree, and the default level is
    // quiet enough that non-matching startup lines are simply ignored.
    autoupdate: false,
    share: "disabled",
    snapshot: false,
    formatter: false,
    lsp: false,
    plugin: [],
    instructions: [],
    mcp: {},
    model,
    default_agent: MAIN_AGENT,
    permission: READ_ONLY_PERMISSION,
    tools: READ_ONLY_TOOLS,
    ...(provider ? { provider } : {}),
    agent: {
      [MAIN_AGENT]: {
        description: "Read-only static security analysis for deepsec",
        mode: "primary",
        model,
        ...(variant ? { variant } : {}),
        steps: maxTurns,
        prompt: DEEPSEC_SYSTEM_NOTE,
        tools: READ_ONLY_TOOLS,
        permission: READ_ONLY_PERMISSION,
      },
      [JSON_AGENT]: {
        description: "Tool-free JSON formatting follow-up for deepsec",
        mode: "primary",
        hidden: true,
        model,
        ...(variant ? { variant } : {}),
        steps: 1,
        prompt: "Return only the JSON value requested by the user. Do not use tools.",
        tools: NO_TOOLS,
        permission: "deny",
      },
    },
  };
}

/**
 * OpenCode v2 permission rules: deny everything, then allow the read-only
 * tool set. v2 evaluates ordered rules with the last match winning, so the
 * catch-all deny comes first and the read-only allows come after.
 * Validated live against OpenCode v2.0.24: bash/edit are denied while
 * read/glob/grep/list still work.
 */
const V2_READ_ONLY_PERMISSIONS = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "list", resource: "*", effect: "allow" },
] as const;

const V2_DENY_ALL_PERMISSIONS = [{ action: "*", resource: "*", effect: "deny" }] as const;

/**
 * Config content for the OpenCode v2 runtime (2.0.x). v2 renamed the v1
 * fields: `agent` → `agents`, `permission`/`tools` → `permissions`
 * (ordered {action, resource, effect} rules), agent `prompt` → `system`,
 * `autoupdate` → `update`. Structured output formats do not exist in v2;
 * results arrive as plain text and go through the shared JSON-repair
 * pipeline.
 */
export function buildOpenCodeV2Config(config: Record<string, unknown>): Record<string, unknown> {
  const cfg = readConfig(config);
  const requested = parseOpenCodeModel(cfg.model ?? DEFAULT_MODEL);
  const providerID = cfg.aiProvider ?? requested.providerID;
  const model = `${providerID}/${requested.modelID}`;
  const maxTurns = cfg.maxTurns ?? DEFAULT_MAX_TURNS;
  const providerOverlays = openCodeV2ProviderOverlays(cfg);

  return {
    share: "disabled",
    update: "disable",
    snapshots: false,
    model,
    default_agent: MAIN_AGENT,
    permissions: V2_READ_ONLY_PERMISSIONS,
    ...(Object.keys(providerOverlays).length > 0 ? { providers: providerOverlays } : {}),
    agents: {
      [MAIN_AGENT]: {
        description: "Read-only static security analysis for deepsec",
        mode: "primary",
        system: DEEPSEC_SYSTEM_NOTE,
        steps: maxTurns,
        permissions: V2_READ_ONLY_PERMISSIONS,
      },
      [JSON_AGENT]: {
        description: "Tool-free JSON formatting follow-up for deepsec",
        mode: "primary",
        hidden: true,
        system: "Return only the JSON value requested by the user. Do not use tools.",
        steps: 1,
        permissions: V2_DENY_ALL_PERMISSIONS,
      },
    },
  };
}

/**
 * v2 provider config overlays (baseURL redirects). The v2 built-in
 * anthropic and openai providers take their base URL from config, not from
 * the ANTHROPIC_BASE_URL / OPENAI_BASE_URL env vars deepsec's Gateway
 * expansion sets — so the expansion is translated into the matching
 * `providers.<id>.settings.baseURL` overlay, and a custom provider route
 * (--ai-base-url) redirects the model's own provider the same way.
 */
export function openCodeV2ProviderOverlays(
  cfg: OpenCodeAgentConfig,
): Record<string, { settings: { baseURL: string } }> {
  const requested = parseOpenCodeModel(cfg.model ?? DEFAULT_MODEL);
  const overlays: Record<string, { settings: { baseURL: string } }> = {};

  if (cfg.aiBaseUrl) {
    // Custom route: redirect the model's own provider at the custom gateway.
    overlays[requested.providerID] = { settings: { baseURL: cfg.aiBaseUrl } };
    return overlays;
  }

  const anthropicBase = process.env.ANTHROPIC_BASE_URL;
  if (anthropicBase) {
    overlays.anthropic = { settings: { baseURL: anthropicBase } };
  }
  const openaiBase = process.env.OPENAI_BASE_URL;
  if (openaiBase) {
    overlays.openai = { settings: { baseURL: openaiBase } };
  }
  return overlays;
}

/**
 * Resolve extra environment variables the spawned OpenCode server should
 * receive. v2's built-in providers read their credentials from the ambient
 * environment (ANTHROPIC_ and OPENAI_ variables), so gateway and direct
 * credentials flow through automatically. A custom provider override
 * (--ai-provider + --ai-base-url + --ai-api-key-env) is remapped onto the
 * matching standard provider pair, which v2's built-in providers honor.
 */
export function openCodeServerEnv(
  cfg: OpenCodeAgentConfig,
  protocol: OpenCodeProtocol,
): NodeJS.ProcessEnv {
  if (protocol !== "v2") return {};
  if (!cfg.aiBaseUrl || !cfg.aiApiKeyEnv) {
    // Gateway route: deepsec's startup expansion sets ANTHROPIC_AUTH_TOKEN
    // (bearer) plus ANTHROPIC_BASE_URL. The v2 anthropic provider only reads
    // ANTHROPIC_API_KEY (x-api-key) from the environment, so bridge the
    // gateway token across when the API-key form is absent.
    if (
      process.env.ANTHROPIC_BASE_URL &&
      !process.env.ANTHROPIC_API_KEY &&
      process.env.ANTHROPIC_AUTH_TOKEN
    ) {
      return { ANTHROPIC_API_KEY: process.env.ANTHROPIC_AUTH_TOKEN };
    }
    return {};
  }
  const credential = process.env[cfg.aiApiKeyEnv];
  if (!credential) {
    throw new Error(
      `OpenCode custom provider route requires ${cfg.aiApiKeyEnv}, but it is not set.`,
    );
  }
  if (cfg.aiHeaders && Object.keys(cfg.aiHeaders).length > 0) {
    throw new Error(
      "--ai-header overrides are not supported by the OpenCode v2 runtime; " +
        "use the v1 opencode runtime or configure the provider headers in your opencode config.",
    );
  }
  const requested = parseOpenCodeModel(cfg.model ?? DEFAULT_MODEL);
  const providerID = cfg.aiProvider ?? requested.providerID;
  if (providerID === "anthropic") {
    return { ANTHROPIC_API_KEY: credential, ANTHROPIC_BASE_URL: cfg.aiBaseUrl };
  }
  return { OPENAI_API_KEY: credential, OPENAI_BASE_URL: cfg.aiBaseUrl };
}

let cachedProtocolDetection: Promise<OpenCodeProtocol> | undefined;

/**
 * Detect the OpenCode runtime generation from `opencode --version`. v2
 * reports "opencode v2.0.24"; v1 reports "1.18.35". Cached per process —
 * the binary on PATH does not change mid-run. Falls back to v1 when the
 * version cannot be parsed (the legacy protocol is the conservative
 * default: it is what the bundled sandbox runtime speaks).
 */
/**
 * Map `opencode --version` output onto the runtime protocol. v2 reports
 * "opencode v2.0.24"; v1 reports "1.18.35". Anything unparsable (or missing
 * `opencode` entirely) falls back to v1 — the legacy protocol is what the
 * bundled sandbox runtime speaks, making it the conservative default.
 */
export function protocolFromVersionOutput(output: string): OpenCodeProtocol {
  const match = /\bv?(\d+)\.\d+\.\d+/.exec(output.trim());
  return match && Number(match[1]) >= 2 ? "v2" : "v1";
}

async function detectOpenCodeProtocol(): Promise<OpenCodeProtocol> {
  cachedProtocolDetection ??= new Promise<OpenCodeProtocol>((resolve) => {
    const child = spawn("opencode", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer | string) => {
      output += chunk.toString();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const finish = (protocol: OpenCodeProtocol) => {
      cachedProtocolDetection = Promise.resolve(protocol);
      resolve(protocol);
    };
    child.on("error", () => finish("v1"));
    child.on("exit", () => finish(protocolFromVersionOutput(output)));
  });
  return cachedProtocolDetection;
}

/**
 * Spawn a private OpenCode server. Own spawn instead of the SDK's
 * `createOpencodeServer`, which only recognizes the v1 startup line
 * ("opencode server listening on …") and has no way to pass the password
 * OpenCode v2 always requires. v2 generates an un guessable random password
 * when none is provided — we generate one ourselves so the client can
 * authenticate, and set both OPENCODE_PASSWORD (v2's preferred name) and
 * OPENCODE_SERVER_PASSWORD (v1's).
 */
function spawnOpenCodeServer(params: {
  port: number;
  password: string;
  configContent: string;
  extraEnv?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onProgress?: (progress: AgentProgress) => void;
}): Promise<{ url: string; close(): void }> {
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", ["serve", `--hostname=127.0.0.1`, `--port=${params.port}`], {
      env: {
        ...process.env,
        ...params.extraEnv,
        OPENCODE_PASSWORD: params.password,
        OPENCODE_SERVER_PASSWORD: params.password,
        OPENCODE_CONFIG_CONTENT: params.configContent,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let output = "";
    const onOutput = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (settled) return;
      for (const line of output.split("\n")) {
        // v1 prints "opencode server listening on <url>";
        // OpenCode v2 prints "server listening on <url>".
        const match = /(?:^|\s)server listening on (https?:\/\/\S+)/.exec(line);
        if (match) {
          settled = true;
          cleanup();
          resolve({ url: match[1], close: () => child.kill() });
          return;
        }
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill();
      reject(
        new Error(
          `Timeout waiting for the OpenCode server to start after 60s.\n` +
            `Server output: ${output.trim().slice(0, 500) || "(none)"}`,
        ),
      );
    }, 60_000);
    const onExit = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Error(
          `OpenCode server exited with code ${code}${output.trim() ? `\nServer output: ${output.trim().slice(0, 500)}` : ""}`,
        ),
      );
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Error(
          `Failed to spawn the OpenCode server. Is \`opencode\` installed and on PATH? (${error.message})`,
        ),
      );
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      child.kill();
      reject(params.signal?.reason ?? new Error("OpenCode server startup aborted"));
    };
    function cleanup() {
      clearTimeout(timer);
      child.stdout?.off("data", onOutput);
      child.stderr?.off("data", onOutput);
      child.off("exit", onExit);
      child.off("error", onError);
      params.signal?.removeEventListener("abort", onAbort);
    }
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
    child.on("exit", onExit);
    child.on("error", onError);
    if (params.signal?.aborted) onAbort();
    else params.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("OpenCode could not allocate a local server port"));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function createOpenCodeFetch(dispatcher: UndiciAgent, authHeader: string): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    // The generated SDK constructs Node's built-in Request, while the
    // separately versioned Undici package has its own branded Request class.
    // Normalize to primitives so fetch and its dispatcher always come from
    // the same Undici version. The injected authorization header serves the
    // password-secured server (v1 with OPENCODE_SERVER_PASSWORD set, v2
    // always).
    const request = input instanceof Request ? input : new Request(input, init);
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : new Uint8Array(await request.arrayBuffer());
    return (await undiciFetch(request.url, {
      method: request.method,
      headers: {
        ...Object.fromEntries(request.headers.entries()),
        authorization: authHeader,
      },
      body,
      redirect: request.redirect,
      signal: request.signal,
      dispatcher,
    })) as unknown as Response;
  }) as typeof globalThis.fetch;
}

async function createRunContext(params: {
  projectRoot: string;
  config: Record<string, unknown>;
  signal?: AbortSignal;
  title: string;
}): Promise<OpenCodeRunContext> {
  const controller = new AbortController();
  const onParentAbort = () =>
    controller.abort(params.signal?.reason ?? new Error("OpenCode run aborted"));
  if (params.signal) {
    if (params.signal.aborted) onParentAbort();
    else params.signal.addEventListener("abort", onParentAbort, { once: true });
  }
  const detachParentAbort = () => params.signal?.removeEventListener("abort", onParentAbort);

  let server: { url: string; close(): void } | undefined;
  const dispatcher = new UndiciAgent({
    // Prompts are long-running: OpenCode does not send response headers
    // until the entire agent loop finishes (v1) or the inbox wait resolves
    // (v2). Undici's 300-second defaults turn valid long-running batches
    // into a misleading `fetch failed`.
    headersTimeout: 0,
    bodyTimeout: 0,
  });
  try {
    const cfg = readConfig(params.config);
    const protocol = await detectOpenCodeProtocol();
    // One password, two env names: v2 reads OPENCODE_PASSWORD first and
    // v1 reads OPENCODE_SERVER_PASSWORD. Both secure the server with basic
    // auth (username "opencode"), and v2 *always* requires it — without a
    // known value it generates an un guessable random one.
    const password = crypto.randomBytes(24).toString("base64url");
    const authHeader = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

    const port = await findFreePort();
    server = await spawnOpenCodeServer({
      port,
      password,
      signal: controller.signal,
      configContent: JSON.stringify(
        protocol === "v2"
          ? buildOpenCodeV2Config(params.config)
          : buildOpenCodeConfig(params.config),
      ),
      extraEnv: openCodeServerEnv(cfg, protocol),
    });

    // Authoritative protocol check: the /api/info endpoint only exists on
    // the v2 runtime. Trust it over the version probe — the config content
    // was already chosen, but a mismatch surfaces here as a clear error
    // instead of cryptic per-request 404/405s.
    const isV2 = await probeV2Server(server.url, authHeader, dispatcher, controller.signal);
    if (isV2 !== (protocol === "v2")) {
      throw new Error(
        `OpenCode version reported ${protocol === "v2" ? "v2" : "v1"}, but the server ` +
          `exposes the ${isV2 ? "v2 (/api)" : "v1 (legacy)"} API. The config content sent at ` +
          `startup matches the reported version; restart with a matching opencode runtime.`,
      );
    }

    const requested = parseOpenCodeModel(cfg.model ?? DEFAULT_MODEL);
    const providerID = cfg.aiProvider ?? requested.providerID;
    const model = {
      providerID,
      modelID: requested.modelID,
    };
    // v1 maps the thinking dial onto provider variants (anthropic: max/high);
    // v2 keeps its model default unless a level was explicitly requested.
    const variant =
      protocol === "v2"
        ? cfg.thinkingLevel
          ? resolveOpenCodeVariant(providerID, cfg.thinkingLevel)
          : undefined
        : resolveOpenCodeVariant(providerID, cfg.thinkingLevel);

    if (protocol === "v2") {
      const created = await v2Call(
        server.url,
        authHeader,
        dispatcher,
        controller.signal,
        "POST",
        "/api/session",
        {
          location: { directory: params.projectRoot },
          title: params.title,
          agent: MAIN_AGENT,
          model: {
            providerID: model.providerID,
            id: model.modelID,
            ...(variant ? { variant } : {}),
          },
        },
      );
      const sessionID = created?.data?.id;
      if (typeof sessionID !== "string") {
        throw new Error(
          `OpenCode v2 session creation returned no session id: ${JSON.stringify(created).slice(0, 300)}`,
        );
      }
      return {
        protocol,
        client: undefined,
        server,
        dispatcher,
        authHeader,
        sessionID,
        directory: params.projectRoot,
        model,
        controller,
        detachParentAbort,
      };
    }

    const client = createOpencodeClient({
      baseUrl: server.url,
      fetch: createOpenCodeFetch(dispatcher, authHeader),
    });
    const created = await client.session.create(
      {
        directory: params.projectRoot,
        title: params.title,
        agent: MAIN_AGENT,
        model: {
          providerID,
          id: requested.modelID,
          ...(variant ? { variant } : {}),
        },
      },
      { throwOnError: true, signal: controller.signal },
    );

    return {
      protocol,
      client,
      server,
      dispatcher,
      authHeader,
      sessionID: created.data.id,
      directory: params.projectRoot,
      model,
      controller,
      detachParentAbort,
    };
  } catch (err) {
    server?.close();
    await dispatcher.close().catch(() => undefined);
    detachParentAbort();
    throw err;
  }
}

async function disposeRunContext(context: OpenCodeRunContext | undefined): Promise<void> {
  if (!context) return;
  context.detachParentAbort();
  if (!context.controller.signal.aborted) {
    try {
      if (context.protocol === "v2") {
        await v2Call(
          context.server.url,
          context.authHeader,
          context.dispatcher,
          context.controller.signal,
          "DELETE",
          `/api/session/${context.sessionID}`,
        );
      } else {
        await context.client?.session.delete(
          { sessionID: context.sessionID, directory: context.directory },
          { throwOnError: true },
        );
      }
    } catch {
      // Best effort: server shutdown is the authoritative cleanup.
    }
  }
  context.server.close();
  await context.dispatcher.close();
}

/** Minimal JSON shape of a v2 assistant message (Session.Message.Assistant). */
interface V2AssistantMessage {
  id?: string;
  type: "assistant";
  agent?: string;
  model?: { id?: string; providerID?: string; variant?: string };
  content?: Array<
    | { type: "text"; text: string }
    | { type: "reasoning"; text: string }
    | {
        type: "tool";
        name?: string;
        state?: { status?: string; error?: string };
      }
  >;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  error?: { message?: string } & Record<string, unknown>;
  retry?: { attempt?: number; error?: { message?: string } };
  time?: { created?: number; completed?: number };
}

/**
 * One request against the OpenCode v2 server. All routes live under /api,
 * require basic auth, and return `{ data: … }` envelopes (or 204 No Content).
 */
async function v2Call(
  baseUrl: string,
  authHeader: string,
  dispatcher: UndiciAgent,
  signal: AbortSignal | undefined,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const response = await undiciFetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: authHeader,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
    dispatcher,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `OpenCode v2 ${method} ${path} failed (HTTP ${response.status}): ${text.slice(0, 300) || "(empty body)"}`,
    );
  }
  if (response.status === 204 || text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(
      `OpenCode v2 ${method} ${path} returned non-JSON output: ${text.slice(0, 300)}`,
      { cause: err },
    );
  }
}

/**
 * Probe for the v2 runtime: `GET /api/info` exists only on the v2 server and
 * returns `{version, pid, …}`. The v1 runtime falls through to its static
 * web handler (HTML) or 404s.
 */
async function probeV2Server(
  baseUrl: string,
  authHeader: string,
  dispatcher: UndiciAgent,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  try {
    const response = await undiciFetch(`${baseUrl}/api/info`, {
      headers: { authorization: authHeader, accept: "application/json" },
      signal,
      dispatcher,
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return (
      typeof body === "object" &&
      body !== null &&
      typeof (body as { version?: unknown }).version === "string"
    );
  } catch {
    return false;
  }
}

/**
 * Read the assistant messages produced after a given user message, newest
 * first (the v2 message list is `order=desc`). Stops at the user message
 * that started the cycle; if it is not on the first page, every assistant
 * message found is kept (defensive against long tool-driven cycles).
 */
async function v2AssistantMessagesSince(
  context: OpenCodeRunContext,
  userMessageID: string | undefined,
): Promise<V2AssistantMessage[]> {
  const list = await v2Call(
    context.server.url,
    context.authHeader,
    context.dispatcher,
    context.controller.signal,
    "GET",
    `/api/session/${context.sessionID}/message?order=desc&limit=200`,
  );
  const data: Array<{ id?: string; type?: string }> = Array.isArray(list?.data) ? list.data : [];
  const collected: V2AssistantMessage[] = [];
  for (const message of data) {
    if (userMessageID && message.id === userMessageID) break;
    if (message.type === "assistant") {
      collected.push(message as V2AssistantMessage);
    }
  }
  return collected;
}

function v2ProgressFromAssistant(message: V2AssistantMessage): AgentProgress[] {
  const progress: AgentProgress[] = [];
  for (const part of message.content ?? []) {
    if (part.type === "tool") {
      progress.push({
        type: part.state?.status === "error" ? "error" : "tool_use",
        message:
          part.state?.status === "error"
            ? `OpenCode ${part.name ?? "tool"} error: ${(part.state.error ?? "").slice(0, 300)}`
            : `${part.name ?? "tool"}`,
      });
    }
  }
  if (message.retry) {
    progress.push({
      type: "thinking",
      message: `OpenCode provider retry ${message.retry.attempt ?? "?"}: ${(message.retry.error?.message ?? "").slice(0, 200)}`,
    });
  }
  return progress;
}

/** Run one prompt cycle against the v2 async inbox: prompt → wait → read. */
async function runV2Prompt(params: {
  context: OpenCodeRunContext;
  prompt: string;
}): Promise<OpenCodePromptResult> {
  const context = params.context;
  const startTime = Date.now();
  const posted = await v2Call(
    context.server.url,
    context.authHeader,
    context.dispatcher,
    context.controller.signal,
    "POST",
    `/api/session/${context.sessionID}/prompt`,
    { text: params.prompt },
  );
  const userMessageID: string | undefined = posted?.data?.id;
  // The inbox admits the prompt and schedules the agent loop; the wait
  // endpoint resolves (204) once the loop goes idle.
  await v2Call(
    context.server.url,
    context.authHeader,
    context.dispatcher,
    context.controller.signal,
    "POST",
    `/api/experimental/session/${context.sessionID}/wait`,
  );
  const messages = await v2AssistantMessagesSince(context, userMessageID);

  const progress: AgentProgress[] = [];
  let toolUseCount = 0;
  let costUsd: number | undefined;
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  let usageSeen = false;
  for (const message of messages) {
    for (const item of v2ProgressFromAssistant(message)) progress.push(item);
    if (message.error) {
      const detail = message.error.message ?? JSON.stringify(message.error).slice(0, 300);
      throw new Error(`OpenCode v2 assistant error: ${detail}`);
    }
    toolUseCount += (message.content ?? []).filter((part) => part.type === "tool").length;
    if (typeof message.cost === "number") {
      costUsd = (costUsd ?? 0) + message.cost;
    }
    const tokens = message.tokens;
    if (tokens) {
      usageSeen = true;
      usage.inputTokens += tokens.input ?? 0;
      usage.outputTokens += tokens.output ?? 0;
      usage.cacheReadInputTokens += tokens.cache?.read ?? 0;
      usage.cacheCreationInputTokens += tokens.cache?.write ?? 0;
    }
  }

  // Newest-first: the final answer is the most recent assistant text.
  let resultText = "";
  for (const message of messages) {
    const text = (message.content ?? [])
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) {
      resultText = text;
      break;
    }
  }

  return {
    resultText,
    turnCount: Math.max(1, messages.length),
    toolUseCount,
    progress,
    meta: {
      durationApiMs: Date.now() - startTime,
      numTurns: Math.max(1, messages.length),
      ...(costUsd !== undefined ? { costUsd } : {}),
      agentSessionId: context.sessionID,
      ...(usageSeen ? { usage } : {}),
      durationMs: Date.now() - startTime,
    },
  };
}

function formatAssistantError(error: NonNullable<AssistantMessage["error"]>): string {
  const message =
    error.data && typeof error.data === "object" && "message" in error.data
      ? String(error.data.message)
      : JSON.stringify(error.data);
  return `${error.name}: ${message}`;
}

function assistantError(error: NonNullable<AssistantMessage["error"]>): Error {
  const result = new Error(formatAssistantError(error));
  result.name = error.name;
  return result;
}

function isStructuredOutputError(error: unknown): boolean {
  return error instanceof Error && error.name === "StructuredOutputError";
}

export function formatOpenCodeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const messages = [error.message];
  let cause: unknown = error.cause;
  const seen = new Set<unknown>([error]);
  while (cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    const code =
      "code" in cause && typeof cause.code === "string" && cause.code ? ` (${cause.code})` : "";
    const message = `${cause.message}${code}`;
    if (!messages.includes(message)) messages.push(message);
    cause = cause.cause;
  }
  return messages.join(": ");
}

export function resolveOpenCodeAssistantText(
  info: Pick<AssistantMessage, "structured" | "error">,
  partText: string,
): OpenCodeResolvedText {
  if (info.structured !== undefined) {
    return {
      resultText: JSON.stringify(info.structured),
      recoveredStructuredText: false,
    };
  }
  if (!info.error) {
    return {
      resultText: partText,
      recoveredStructuredText: false,
    };
  }
  if (info.error.name === "StructuredOutputError" && partText) {
    return {
      resultText: partText,
      recoveredStructuredText: true,
    };
  }
  throw assistantError(info.error);
}

function textFromParts(parts: Part[]): string {
  const text: string[] = [];
  for (const part of parts) {
    if (part.type === "text" && !part.ignored) text.push(part.text);
  }
  return text.join("\n").trim();
}

function shortToolTarget(part: Extract<Part, { type: "tool" }>): string | undefined {
  const input = part.state.input;
  for (const key of ["path", "filePath", "file_path", "pattern", "query"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value.split("/").slice(-3).join("/");
    }
  }
  return undefined;
}

function progressFromParts(parts: Part[]): AgentProgress[] {
  const progress: AgentProgress[] = [];
  for (const part of parts) {
    if (part.type === "tool") {
      const target = shortToolTarget(part);
      progress.push({
        type: part.state.status === "error" ? "error" : "tool_use",
        message:
          part.state.status === "error"
            ? `OpenCode ${part.tool} error${target ? `: ${target}` : ""}: ${part.state.error.slice(0, 300)}`
            : `${part.tool}${target ? `: ${target}` : ""}`,
        candidateFile: target,
      });
    } else if (part.type === "retry") {
      progress.push({
        type: "thinking",
        message: `OpenCode provider retry ${part.attempt}: ${part.error.data.message.slice(0, 200)}`,
      });
    } else if (part.type === "compaction") {
      progress.push({ type: "thinking", message: "OpenCode compacted conversation context" });
    }
  }
  return progress;
}

async function runPrompt(params: {
  context: OpenCodeRunContext;
  prompt: string;
  format: OutputFormat;
  config: Record<string, unknown>;
  tools?: Record<string, boolean>;
  agent?: string;
}): Promise<OpenCodePromptResult> {
  // v2 has no structured-output prompt formats; its results arrive as plain
  // text and the shared JSON-repair pipeline validates them.
  if (params.context.protocol === "v2") {
    return await runV2Prompt({ context: params.context, prompt: params.prompt });
  }
  const cfg = readConfig(params.config);
  const requested = parseOpenCodeModel(cfg.model ?? DEFAULT_MODEL);
  const providerID = cfg.aiProvider ?? requested.providerID;
  const variant = resolveOpenCodeVariant(providerID, cfg.thinkingLevel);
  const useTextFormat = shouldUseOpenCodeTextFormat(providerID, variant, params.format);
  const startTime = Date.now();

  const response = await params.context.client!.session.prompt(
    {
      sessionID: params.context.sessionID,
      directory: params.context.directory,
      model: { providerID, modelID: requested.modelID },
      agent: params.agent ?? MAIN_AGENT,
      ...(variant ? { variant } : {}),
      tools: params.tools ?? READ_ONLY_TOOLS,
      format: useTextFormat ? TEXT_FORMAT : params.format,
      parts: [{ type: "text", text: params.prompt }],
    },
    { throwOnError: true, signal: params.context.controller.signal },
  );

  const { info, parts } = response.data;
  const resolved = resolveOpenCodeAssistantText(info, textFromParts(parts));
  const turnCount = Math.max(1, parts.filter((part) => part.type === "step-finish").length);
  const toolUseCount = parts.filter((part) => part.type === "tool").length;
  const completed = info.time.completed ?? Date.now();
  const progress = progressFromParts(parts);
  if (useTextFormat) {
    progress.push({
      type: "thinking",
      message:
        "Anthropic thinking is incompatible with forced StructuredOutput; validating the text response",
    });
  }
  if (resolved.recoveredStructuredText) {
    progress.push({
      type: "thinking",
      message:
        "OpenCode returned text instead of calling StructuredOutput; validating the text response",
    });
  }

  return {
    resultText: resolved.resultText,
    turnCount,
    toolUseCount,
    progress,
    meta: {
      durationApiMs: Math.max(0, completed - info.time.created),
      numTurns: turnCount,
      costUsd: info.cost,
      agentSessionId: info.sessionID,
      usage: {
        inputTokens: info.tokens.input,
        outputTokens: info.tokens.output,
        cacheReadInputTokens: info.tokens.cache.read,
        cacheCreationInputTokens: info.tokens.cache.write,
      },
      durationMs: Date.now() - startTime,
    },
  };
}

async function runToollessFollowUp(params: {
  context: OpenCodeRunContext | undefined;
  prompt: string;
  config: Record<string, unknown>;
}): Promise<string | undefined> {
  if (!params.context) return undefined;
  const context = params.context;
  if (context.protocol === "v2") {
    // v2 prompts cannot carry a per-request agent override; switch the
    // session to the deny-all deepsec-json agent for the follow-up and
    // switch back afterwards.
    try {
      const switched = await v2Call(
        context.server.url,
        context.authHeader,
        context.dispatcher,
        context.controller.signal,
        "POST",
        `/api/session/${context.sessionID}/agent`,
        { agent: JSON_AGENT },
      );
      const result = await runV2Prompt({ context, prompt: params.prompt });
      if (!switched) {
        await v2Call(
          context.server.url,
          context.authHeader,
          context.dispatcher,
          context.controller.signal,
          "POST",
          `/api/session/${context.sessionID}/agent`,
          { agent: MAIN_AGENT },
        );
      }
      return result.resultText || undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const result = await runPrompt({
      context,
      prompt: params.prompt,
      format: TEXT_FORMAT,
      config: params.config,
      tools: NO_TOOLS,
      agent: JSON_AGENT,
    });
    return result.resultText;
  } catch {
    return undefined;
  }
}

async function runRefusalFollowUp(params: {
  context: OpenCodeRunContext | undefined;
  config: Record<string, unknown>;
}): Promise<RefusalReport | undefined> {
  const raw = await runToollessFollowUp({
    ...params,
    prompt: REFUSAL_FOLLOWUP_PROMPT,
  });
  return raw === undefined ? undefined : parseRefusalReport(raw);
}

export class OpenCodeAgentPlugin implements AgentPlugin {
  type = "opencode";

  async *investigate(params: InvestigateParams): AsyncGenerator<AgentProgress, InvestigateOutput> {
    const { batch, projectRoot, promptTemplate, projectInfo, config, signal, projectId } = params;
    const prompt = buildInvestigatePrompt({ promptTemplate, projectInfo, batch });
    const model = readConfig(config).model ?? DEFAULT_MODEL;
    const startTime = Date.now();
    let context: OpenCodeRunContext | undefined;
    let resultText = "";
    let lastError = "";
    let sdkMeta: Partial<BatchMeta> = {};
    let turnCount = 0;
    let toolUseCount = 0;
    let attempts = 0;

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        attempts = attempt;
        if (attempt > 1) {
          yield {
            type: "thinking",
            message: `Retrying OpenCode batch after transient error (attempt ${attempt}/${MAX_ATTEMPTS}): ${lastError.slice(0, 200)}`,
          };
          await disposeRunContext(context);
          context = undefined;
          resultText = "";
          lastError = "";
          sdkMeta = {};
          turnCount = 0;
          toolUseCount = 0;
        }

        try {
          context = await createRunContext({
            projectRoot,
            config,
            signal,
            title: `deepsec investigate (${batch.length} files)`,
          });
          if (attempt === 1) {
            yield {
              type: "started",
              message: `Investigating ${batch.length} file(s) with OpenCode (${model})`,
            };
          }
          const run = await runPrompt({
            context,
            prompt,
            format: INVESTIGATE_FORMAT,
            config,
          });
          resultText = run.resultText;
          sdkMeta = run.meta;
          turnCount = run.turnCount;
          toolUseCount = run.toolUseCount;
          for (const progress of run.progress) yield progress;
        } catch (err) {
          if (isStructuredOutputError(err)) {
            yield {
              type: "thinking",
              message:
                "OpenCode did not call StructuredOutput; requesting a tool-free JSON finalization",
            };
            const recovered = await runToollessFollowUp({
              context,
              prompt: buildInvestigateJsonRepairPrompt(batch),
              config,
            });
            if (recovered) resultText = recovered;
          }
          if (!resultText) {
            lastError = formatOpenCodeError(err);
            yield { type: "error", message: `OpenCode SDK error: ${lastError.slice(0, 300)}` };
          }
        }

        if (resultText) break;
        const quotaSource = classifyQuotaError(lastError);
        if (quotaSource) throw new QuotaExhaustedError(quotaSource, lastError);
        if (attempt >= MAX_ATTEMPTS || !isTransientError(lastError)) break;
        await backoff(attempt);
      }

      if (!resultText) {
        throw new Error(
          `OpenCode produced no investigation result after ${attempts} attempt(s). ` +
            `Last error: ${lastError || "(none captured)"}.`,
        );
      }

      let parsedOutcome: ParsedInvestigateResults;
      try {
        parsedOutcome = parseInvestigateResults(resultText, batch);
      } catch (err) {
        if (err instanceof AgentPolicyRefusalError) {
          writeParseFailureDebug({
            projectId,
            phase: "investigate",
            agentType: this.type,
            resultText,
            error: err,
            batch,
          });
          throw err;
        }
        yield {
          type: "thinking",
          message: "OpenCode returned non-JSON investigation output; requesting JSON-only repair",
        };
        const repairText = await runToollessFollowUp({
          context,
          prompt: buildInvestigateJsonRepairPrompt(batch),
          config,
        });
        if (repairText === undefined) {
          writeParseFailureDebug({
            projectId,
            phase: "investigate",
            agentType: this.type,
            resultText,
            error: err,
            batch,
          });
          throw err;
        }
        try {
          parsedOutcome = parseInvestigateResults(repairText, batch);
          resultText = repairText;
          yield { type: "thinking", message: "OpenCode JSON repair succeeded" };
        } catch (repairErr) {
          const combinedError = jsonRepairFailureError(err, repairErr);
          writeParseFailureDebug({
            projectId,
            phase: "investigate",
            agentType: this.type,
            resultText: formatJsonRepairFailureDebugText(resultText, repairText),
            error: combinedError,
            batch,
          });
          throw combinedError;
        }
      }
      let results: InvestigateResult[] = parsedOutcome.results;
      if (parsedOutcome.invalid.length > 0) {
        const fieldRepair = yield* runInvestigateFieldRepairLoop({
          results,
          invalid: parsedOutcome.invalid,
          batch,
          followUp: (prompt) => runToollessFollowUp({ context, prompt, config }),
          agentLabel: "OpenCode",
          agentType: this.type,
          projectId,
        });
        results = fieldRepair.results;
      }

      const refusal = await runRefusalFollowUp({ context, config });
      if (refusal?.refused) {
        yield {
          type: "thinking",
          message: `Refusal detected: ${refusal.reason ?? "see raw"}`,
        };
      }

      const durationMs = Date.now() - startTime;
      const costStr = sdkMeta.costUsd != null ? ` $${sdkMeta.costUsd.toFixed(3)}` : "";
      const tokensStr = sdkMeta.usage
        ? ` ${sdkMeta.usage.inputTokens + sdkMeta.usage.outputTokens} tokens`
        : "";
      yield {
        type: "complete",
        message: `Investigation complete (${(durationMs / 1000).toFixed(1)}s, ${turnCount} turns, ${toolUseCount} tool calls${costStr}${tokensStr}${refusal?.refused ? " refusal" : ""})`,
      };

      return {
        results,
        meta: {
          durationMs,
          ...sdkMeta,
          refusal,
        },
      };
    } finally {
      await disposeRunContext(context);
    }
  }

  async *revalidate(params: RevalidateParams): AsyncGenerator<AgentProgress, RevalidateOutput> {
    const { batch, projectRoot, projectInfo, config, force = false, signal, projectId } = params;
    const { prompt, totalFindings } = buildRevalidatePrompt({
      batch,
      projectRoot,
      projectInfo,
      force,
    });
    const model = readConfig(config).model ?? DEFAULT_MODEL;
    const startTime = Date.now();
    let context: OpenCodeRunContext | undefined;
    let resultText = "";
    let lastError = "";
    let sdkMeta: Partial<BatchMeta> = {};
    let turnCount = 0;
    let toolUseCount = 0;
    let attempts = 0;

    try {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        attempts = attempt;
        if (attempt > 1) {
          yield {
            type: "thinking",
            message: `Retrying OpenCode revalidation after transient error (attempt ${attempt}/${MAX_ATTEMPTS}): ${lastError.slice(0, 200)}`,
          };
          await disposeRunContext(context);
          context = undefined;
          resultText = "";
          lastError = "";
          sdkMeta = {};
          turnCount = 0;
          toolUseCount = 0;
        }

        try {
          context = await createRunContext({
            projectRoot,
            config,
            signal,
            title: `deepsec revalidate (${totalFindings} findings)`,
          });
          if (attempt === 1) {
            yield {
              type: "started",
              message: `Revalidating ${totalFindings} finding(s) across ${batch.length} file(s) with OpenCode (${model})`,
            };
          }
          const run = await runPrompt({
            context,
            prompt,
            format: REVALIDATE_FORMAT,
            config,
          });
          resultText = run.resultText;
          sdkMeta = run.meta;
          turnCount = run.turnCount;
          toolUseCount = run.toolUseCount;
          for (const progress of run.progress) yield progress;
        } catch (err) {
          if (isStructuredOutputError(err)) {
            yield {
              type: "thinking",
              message:
                "OpenCode did not call StructuredOutput; requesting a tool-free JSON finalization",
            };
            const recovered = await runToollessFollowUp({
              context,
              prompt: buildRevalidateJsonRepairPrompt(),
              config,
            });
            if (recovered) resultText = recovered;
          }
          if (!resultText) {
            lastError = formatOpenCodeError(err);
            yield { type: "error", message: `OpenCode SDK error: ${lastError.slice(0, 300)}` };
          }
        }

        if (resultText) break;
        const quotaSource = classifyQuotaError(lastError);
        if (quotaSource) throw new QuotaExhaustedError(quotaSource, lastError);
        if (attempt >= MAX_ATTEMPTS || !isTransientError(lastError)) break;
        await backoff(attempt);
      }

      if (!resultText) {
        throw new Error(
          `OpenCode produced no revalidation result after ${attempts} attempt(s). ` +
            `Last error: ${lastError || "(none captured)"}.`,
        );
      }

      let verdicts: RevalidateVerdict[];
      try {
        verdicts = parseRevalidateVerdicts(resultText);
      } catch (err) {
        yield {
          type: "thinking",
          message: "OpenCode returned non-JSON revalidation output; requesting JSON-only repair",
        };
        const repairText = await runToollessFollowUp({
          context,
          prompt: buildRevalidateJsonRepairPrompt(),
          config,
        });
        if (repairText === undefined) {
          writeParseFailureDebug({
            projectId,
            phase: "revalidate",
            agentType: this.type,
            resultText,
            error: err,
            batch,
          });
          throw err;
        }
        try {
          verdicts = parseRevalidateVerdicts(repairText);
          resultText = repairText;
          yield { type: "thinking", message: "OpenCode JSON repair succeeded" };
        } catch (repairErr) {
          const combinedError = jsonRepairFailureError(err, repairErr);
          writeParseFailureDebug({
            projectId,
            phase: "revalidate",
            agentType: this.type,
            resultText: formatJsonRepairFailureDebugText(resultText, repairText),
            error: combinedError,
            batch,
          });
          throw combinedError;
        }
      }

      const refusal = await runRefusalFollowUp({ context, config });
      if (refusal?.refused) {
        yield {
          type: "thinking",
          message: `Refusal detected during revalidation: ${refusal.reason ?? "see raw"}`,
        };
      }

      const durationMs = Date.now() - startTime;
      const costStr = sdkMeta.costUsd != null ? ` $${sdkMeta.costUsd.toFixed(3)}` : "";
      yield {
        type: "complete",
        message: `Revalidation complete (${(durationMs / 1000).toFixed(1)}s, ${turnCount} turns, ${toolUseCount} tool calls${costStr}, ${verdicts.length} verdicts${refusal?.refused ? " refusal" : ""})`,
      };

      return {
        verdicts,
        meta: { durationMs, ...sdkMeta, refusal },
      };
    } finally {
      await disposeRunContext(context);
    }
  }
}
