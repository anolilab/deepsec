import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildOpenCodeConfig,
  buildOpenCodeV2Config,
  formatOpenCodeError,
  openCodeServerEnv,
  openCodeV2ProviderOverlays,
  parseOpenCodeModel,
  protocolFromVersionOutput,
  resolveOpenCodeAssistantText,
  resolveOpenCodeVariant,
  shouldUseOpenCodeTextFormat,
} from "../agents/opencode-sdk.js";

describe("OpenCodeAgentPlugin configuration", () => {
  const savedEnv = {
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("parses provider/model while preserving slashes in the model id", () => {
    expect(parseOpenCodeModel("openai/acme/gpt-sec")).toEqual({
      providerID: "openai",
      modelID: "acme/gpt-sec",
    });
  });

  it("rejects a bare model name with an actionable example", () => {
    expect(() => parseOpenCodeModel("claude-opus")).toThrow(/provider\/model/);
    expect(() => parseOpenCodeModel("claude-opus")).toThrow(/anthropic\/claude-opus-4-8/);
  });

  it("maps the shared thinking dial to provider variants", () => {
    expect(resolveOpenCodeVariant("anthropic", "xhigh")).toBe("max");
    expect(resolveOpenCodeVariant("anthropic", "medium")).toBe("high");
    expect(resolveOpenCodeVariant("openai", "low")).toBe("low");
    expect(resolveOpenCodeVariant("google", "minimal")).toBe("low");
    expect(resolveOpenCodeVariant("google", "high")).toBe("high");
    expect(resolveOpenCodeVariant("custom")).toBeUndefined();
    expect(resolveOpenCodeVariant("custom", "medium")).toBe("medium");
  });

  it("uses text output when Anthropic thinking conflicts with forced structured output", () => {
    expect(
      shouldUseOpenCodeTextFormat("anthropic", "high", {
        type: "json_schema",
        schema: { type: "object" },
      }),
    ).toBe(true);
    expect(
      shouldUseOpenCodeTextFormat("anthropic", undefined, {
        type: "json_schema",
        schema: { type: "object" },
      }),
    ).toBe(false);
    expect(
      shouldUseOpenCodeTextFormat("openai", "high", {
        type: "json_schema",
        schema: { type: "object" },
      }),
    ).toBe(false);
    expect(shouldUseOpenCodeTextFormat("anthropic", "high", { type: "text" })).toBe(false);
  });

  it("preserves nested network error details", () => {
    const cause = Object.assign(new Error("Headers Timeout Error"), {
      code: "UND_ERR_HEADERS_TIMEOUT",
    });
    const error = new TypeError("fetch failed", { cause });

    expect(formatOpenCodeError(error)).toBe(
      "fetch failed: Headers Timeout Error (UND_ERR_HEADERS_TIMEOUT)",
    );
  });

  it("uses plain text when a provider skips OpenCode's StructuredOutput tool", () => {
    expect(
      resolveOpenCodeAssistantText(
        {
          error: {
            name: "StructuredOutputError",
            data: {
              message: "Model did not produce structured output",
              retries: 0,
            },
          },
        },
        '[{"filePath":"src/a.ts","findings":[]}]',
      ),
    ).toEqual({
      resultText: '[{"filePath":"src/a.ts","findings":[]}]',
      recoveredStructuredText: true,
    });
  });

  it("keeps a structured-output failure when the provider returned no text", () => {
    expect(() =>
      resolveOpenCodeAssistantText(
        {
          error: {
            name: "StructuredOutputError",
            data: {
              message: "Model did not produce structured output",
              retries: 0,
            },
          },
        },
        "",
      ),
    ).toThrow(/StructuredOutputError: Model did not produce structured output/);
  });

  it("enforces read-only tools, capped steps, and structured provider routing", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "do-not-inline-this-secret";
    process.env.ANTHROPIC_BASE_URL = "https://ai-gateway.example";

    const config = buildOpenCodeConfig({
      model: "anthropic/claude-opus-4-8",
      maxTurns: 42,
      thinkingLevel: "xhigh",
    });
    const main = config.agent?.deepsec;

    expect(config.default_agent).toBe("deepsec");
    expect(config.share).toBe("disabled");
    expect(config.autoupdate).toBe(false);
    expect(config.tools).toMatchObject({
      read: true,
      glob: true,
      grep: true,
      list: true,
      bash: false,
      edit: false,
      task: false,
      webfetch: false,
    });
    expect(config.permission).toMatchObject({
      "*": "deny",
      read: "allow",
      bash: "deny",
      edit: "deny",
      external_directory: "deny",
    });
    expect(main?.steps).toBe(42);
    expect(main?.variant).toBe("max");
    expect(main?.permission).toEqual(config.permission);
    expect(config.provider?.anthropic?.options).toMatchObject({
      apiKey: "{env:ANTHROPIC_AUTH_TOKEN}",
      baseURL: "https://ai-gateway.example/v1",
    });
    expect(JSON.stringify(config)).not.toContain("do-not-inline-this-secret");
  });

  it("does not duplicate the Anthropic API version path", () => {
    process.env.ANTHROPIC_BASE_URL = "https://api.anthropic.com/v1/";

    const config = buildOpenCodeConfig({
      model: "anthropic/claude-haiku-4-5",
    });

    expect(config.provider?.anthropic?.options?.baseURL).toBe("https://api.anthropic.com/v1");
  });

  it("supports a custom provider override without changing the model id", () => {
    process.env.MARTIAN_API_KEY = "secret";
    const config = buildOpenCodeConfig({
      model: "openai/org/model",
      aiProvider: "martian",
      aiBaseUrl: "https://martian.example/v1",
      aiApiKeyEnv: "MARTIAN_API_KEY",
      aiHeaders: { "x-team": "security" },
    });

    expect(config.model).toBe("martian/org/model");
    expect(config.provider?.martian).toEqual({
      options: {
        apiKey: "{env:MARTIAN_API_KEY}",
        baseURL: "https://martian.example/v1",
      },
      headers: { "x-team": "security" },
    });
  });
});

describe("OpenCode v2 support", () => {
  const savedEnv = {
    MARTIAN_API_KEY: process.env.MARTIAN_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  };

  beforeEach(() => {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("maps opencode --version output onto the runtime protocol", () => {
    expect(protocolFromVersionOutput("opencode v2.0.24")).toBe("v2");
    expect(protocolFromVersionOutput("opencode v2.1.0-alpha.3")).toBe("v2");
    expect(protocolFromVersionOutput("1.18.35")).toBe("v1");
    expect(protocolFromVersionOutput("opencode 1.18.35")).toBe("v1");
    expect(protocolFromVersionOutput("")).toBe("v1");
    expect(protocolFromVersionOutput("not-a-version")).toBe("v1");
  });

  it("builds a read-only v2 config with ordered permission rules", () => {
    const config = buildOpenCodeV2Config({
      model: "anthropic/claude-opus-4-8",
      maxTurns: 42,
    });

    expect(config.share).toBe("disabled");
    expect(config.update).toBe("disable");
    expect(config.snapshots).toBe(false);
    expect(config.model).toBe("anthropic/claude-opus-4-8");
    expect(config.default_agent).toBe("deepsec");

    const readOnly = [
      { action: "*", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
      { action: "glob", resource: "*", effect: "allow" },
      { action: "grep", resource: "*", effect: "allow" },
      { action: "list", resource: "*", effect: "allow" },
    ];
    expect(config.permissions).toEqual(readOnly);

    const main = (config.agents as Record<string, any>)["deepsec"];
    expect(main.mode).toBe("primary");
    expect(main.steps).toBe(42);
    expect(main.permissions).toEqual(readOnly);
    expect(String(main.system)).toContain("static source inspection only");

    const json = (config.agents as Record<string, any>)["deepsec-json"];
    expect(json.hidden).toBe(true);
    expect(json.steps).toBe(1);
    expect(json.permissions).toEqual([{ action: "*", resource: "*", effect: "deny" }]);
  });

  it("remaps a custom provider override onto the standard provider env for v2", () => {
    process.env.MARTIAN_API_KEY = "martian-secret";
    const env = openCodeServerEnv(
      {
        model: "openai/gpt-5.5",
        aiBaseUrl: "https://api.withmartian.com/v1",
        aiApiKeyEnv: "MARTIAN_API_KEY",
      },
      "v2",
    );
    expect(env).toEqual({
      OPENAI_API_KEY: "martian-secret",
      OPENAI_BASE_URL: "https://api.withmartian.com/v1",
    });

    const anthropic = openCodeServerEnv(
      {
        model: "anthropic/claude-opus-4-8",
        aiProvider: "anthropic",
        aiBaseUrl: "https://proxy.example",
        aiApiKeyEnv: "MARTIAN_API_KEY",
      },
      "v2",
    );
    expect(anthropic).toEqual({
      ANTHROPIC_API_KEY: "martian-secret",
      ANTHROPIC_BASE_URL: "https://proxy.example",
    });
  });

  it("rejects custom provider headers on the v2 runtime", () => {
    process.env.MARTIAN_API_KEY = "martian-secret";
    expect(() =>
      openCodeServerEnv(
        {
          model: "openai/gpt-5.5",
          aiBaseUrl: "https://api.withmartian.com/v1",
          aiApiKeyEnv: "MARTIAN_API_KEY",
          aiHeaders: { "x-team": "security" },
        },
        "v2",
      ),
    ).toThrow(/--ai-header/);
  });

  it("passes no extra server env for v1 or uncustomized routes", () => {
    expect(openCodeServerEnv({ model: "anthropic/claude-opus-4-8" }, "v1")).toEqual({});
    expect(openCodeServerEnv({ model: "anthropic/claude-opus-4-8" }, "v2")).toEqual({});
    expect(
      openCodeServerEnv({ model: "openai/gpt-5.5", aiBaseUrl: "https://x.example" }, "v2"),
    ).toEqual({});
  });

  it("bridges the gateway bearer token to the v2 anthropic env var", () => {
    process.env.ANTHROPIC_AUTH_TOKEN = "vck_gateway_token";
    process.env.ANTHROPIC_BASE_URL = "https://ai-gateway.vercel.sh";
    const env = openCodeServerEnv({ model: "anthropic/claude-opus-4-8" }, "v2");
    expect(env).toEqual({ ANTHROPIC_API_KEY: "vck_gateway_token" });

    // An explicit API key wins — no bridge needed.
    process.env.ANTHROPIC_API_KEY = "sk-ant-direct";
    expect(openCodeServerEnv({ model: "anthropic/claude-opus-4-8" }, "v2")).toEqual({});
  });

  it("translates the gateway expansion into v2 provider baseURL overlays", () => {
    process.env.ANTHROPIC_BASE_URL = "https://ai-gateway.vercel.sh";
    process.env.OPENAI_BASE_URL = "https://ai-gateway.vercel.sh/v1";
    const overlays = openCodeV2ProviderOverlays({ model: "anthropic/claude-opus-4-8" });
    expect(overlays).toEqual({
      anthropic: { settings: { baseURL: "https://ai-gateway.vercel.sh" } },
      openai: { settings: { baseURL: "https://ai-gateway.vercel.sh/v1" } },
    });
    expect(openCodeServerEnv({ model: "anthropic/claude-opus-4-8" }, "v2")).toEqual({});
  });

  it("includes provider overlays in the v2 config content", () => {
    process.env.ANTHROPIC_BASE_URL = "https://ai-gateway.vercel.sh";
    const config = buildOpenCodeV2Config({ model: "anthropic/claude-opus-4-8" });
    expect(config.providers).toEqual({
      anthropic: { settings: { baseURL: "https://ai-gateway.vercel.sh" } },
    });
  });

  it("redirects the model's own provider for custom v2 routes", () => {
    const overlays = openCodeV2ProviderOverlays({
      model: "openai/gpt-5.5",
      aiProvider: "martian",
      aiBaseUrl: "https://api.withmartian.com/v1",
      aiApiKeyEnv: "MARTIAN_API_KEY",
    });
    expect(overlays).toEqual({
      openai: { settings: { baseURL: "https://api.withmartian.com/v1" } },
    });
  });

  it("requires the configured credential env for custom v2 routes", () => {
    delete process.env.MARTIAN_API_KEY;
    expect(() =>
      openCodeServerEnv(
        {
          model: "openai/gpt-5.5",
          aiBaseUrl: "https://api.withmartian.com/v1",
          aiApiKeyEnv: "MARTIAN_API_KEY",
        },
        "v2",
      ),
    ).toThrow(/MARTIAN_API_KEY/);
  });
});
