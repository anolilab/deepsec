import { describe, expect, it, vi } from "vitest";
import { ensureConnectedWorkspace } from "../auth/ensure-connected-workspace.js";
import type { ResolvedModelRoute } from "../auth/model-route.js";

const route = { mode: "direct", provider: "openai", apiKeyEnv: "OPENAI_API_KEY" } as const;

function resolved(): ResolvedModelRoute {
  return {
    route,
    credentialEnv: "OPENAI_API_KEY",
    credential: "secret",
    environment: { OPENAI_API_KEY: "secret" },
    broker: {
      host: "api.openai.com",
      placeholderEnv: "OPENAI_API_KEY",
      header: { name: "authorization", value: "Bearer secret" },
    },
  };
}

describe("ensureConnectedWorkspace", () => {
  it("verifies model access and returns an auditable linked checkpoint", async () => {
    const verifyModelRoute = vi.fn(async () => undefined);
    const result = await ensureConnectedWorkspace({
      workspaceDir: "/workspace",
      interactive: false,
      modelRoute: route,
      agentTypes: ["codex"],
      env: { VERCEL_TOKEN: "v", VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "project" },
      dependencies: {
        ensureLink: async () => ({
          method: "access-token-triple",
          project: { teamId: "team", projectId: "project" },
          link: { orgId: "team", projectId: "project" },
        }),
        resolveRoute: async () => resolved(),
        verifyModelRoute,
        now: () => new Date("2026-01-01T00:00:00Z"),
      },
    });
    expect(result.modelRouteVerified).toBe(true);
    expect(result.sandboxReady).toBe(true);
    expect(verifyModelRoute).toHaveBeenCalledOnce();
  });

  it("short-circuits fresh matching verification while still resolving credentials", async () => {
    const verifyModelRoute = vi.fn(async () => undefined);
    const resolveRoute = vi.fn(async () => resolved());
    const previous = {
      project: { teamId: "team", projectId: "project" },
      route,
      agentTypes: ["codex"],
      modelVerifiedAt: "2026-01-01T00:00:00Z",
    };
    const result = await ensureConnectedWorkspace({
      workspaceDir: "/workspace",
      interactive: false,
      modelRoute: route,
      agentTypes: ["codex"],
      env: { VERCEL_TOKEN: "v", VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "project" },
      previous,
      dependencies: {
        ensureLink: async () => ({
          method: "existing-link",
          project: { teamId: "team", projectId: "project" },
          link: { orgId: "team", projectId: "project" },
        }),
        resolveRoute,
        verifyModelRoute,
        now: () => new Date("2026-01-01T01:00:00Z"),
      },
    });
    expect(resolveRoute).toHaveBeenCalledOnce();
    expect(verifyModelRoute).not.toHaveBeenCalled();
    expect(result.sandboxReady).toBe(true);
  });

  it("skips the platform link, credential resolution and verification for a local route", async () => {
    const resolveRoute = vi.fn(async () => resolved());
    const verifyModelRoute = vi.fn(async () => undefined);
    const ensureLink = vi.fn(async () => ({
      method: "access-token-triple" as const,
      project: { teamId: "team", projectId: "project" },
      link: { orgId: "team", projectId: "project" },
    }));
    const localRoute = { mode: "local", provider: "local" } as const;
    const env = { VERCEL_TOKEN: "v", VERCEL_TEAM_ID: "team", VERCEL_PROJECT_ID: "project" };
    const result = await ensureConnectedWorkspace({
      workspaceDir: "/workspace",
      interactive: false,
      modelRoute: localRoute,
      agentTypes: ["claude-agent-sdk"],
      env,
      dependencies: {
        ensureLink,
        resolveRoute,
        verifyModelRoute,
        now: () => new Date("2026-01-01T00:00:00Z"),
      },
    });
    expect(ensureLink).not.toHaveBeenCalled();
    expect(result.project).toBeUndefined();
    expect(resolveRoute).not.toHaveBeenCalled();
    expect(verifyModelRoute).not.toHaveBeenCalled();
    expect(result.modelAuth).toEqual(localRoute);
    expect(result.modelRouteVerified).toBe(false);
    expect(result.verification.route).toEqual(localRoute);
    // No model credential env vars were injected.
    expect(env).toEqual({
      VERCEL_TOKEN: "v",
      VERCEL_TEAM_ID: "team",
      VERCEL_PROJECT_ID: "project",
    });
  });

  it("never prompts for a Vercel login on a direct route without Vercel credentials (#164)", async () => {
    const verifyModelRoute = vi.fn(async () => undefined);
    const resolveRoute = vi.fn(async () => resolved());
    const ensureLink = vi.fn(async () => {
      const error = new Error("Vercel authentication required");
      Object.assign(error, { code: "VERCEL_AUTH_REQUIRED" });
      throw error;
    });
    const env: Record<string, string> = { OPENAI_API_KEY: "secret" };
    const result = await ensureConnectedWorkspace({
      workspaceDir: "/workspace",
      interactive: true,
      modelRoute: route,
      agentTypes: ["codex"],
      env,
      dependencies: {
        ensureLink,
        resolveRoute,
        verifyModelRoute,
        now: () => new Date("2026-01-01T00:00:00Z"),
      },
    });
    // Attempted a silent (non-interactive) link, never a prompted login.
    expect(ensureLink).toHaveBeenCalledWith(
      expect.objectContaining({ interactive: false }),
    );
    expect(resolveRoute).toHaveBeenCalledOnce();
    expect(verifyModelRoute).toHaveBeenCalledOnce();
    expect(env.OPENAI_API_KEY).toBe("secret");
    expect(result.project).toBeUndefined();
    expect(result.platformAuth).toBeUndefined();
    expect(result.sandboxReady).toBe(false);
    expect(result.modelRouteVerified).toBe(true);
    expect(result.verification.project).toBeUndefined();
  });

  it("reuses an existing Vercel link silently on a direct route with credentials", async () => {
    const verifyModelRoute = vi.fn(async () => undefined);
    const resolveRoute = vi.fn(async () => resolved());
    const env: Record<string, string> = {
      OPENAI_API_KEY: "secret",
      VERCEL_TOKEN: "v",
      VERCEL_TEAM_ID: "team",
      VERCEL_PROJECT_ID: "project",
    };
    const result = await ensureConnectedWorkspace({
      workspaceDir: "/workspace",
      interactive: true,
      modelRoute: route,
      agentTypes: ["codex"],
      env,
      dependencies: {
        ensureLink: async () => ({
          method: "access-token-triple" as const,
          project: { teamId: "team", projectId: "project" },
          link: { orgId: "team", projectId: "project" },
        }),
        resolveRoute,
        verifyModelRoute,
        now: () => new Date("2026-01-01T00:00:00Z"),
      },
    });
    expect(resolveRoute).toHaveBeenCalledOnce();
    expect(result.project).toEqual({ teamId: "team", projectId: "project" });
    expect(result.sandboxReady).toBe(true);
    expect(result.verification.project).toEqual({ teamId: "team", projectId: "project" });
  });

  it("rethrows link failures other than missing Vercel auth on a direct route", async () => {
    const ensureLink = vi.fn(async () => {
      throw new Error("network unreachable");
    });
    await expect(
      ensureConnectedWorkspace({
        workspaceDir: "/workspace",
        interactive: true,
        modelRoute: route,
        agentTypes: ["codex"],
        env: { OPENAI_API_KEY: "secret" },
        dependencies: {
          ensureLink,
          resolveRoute: vi.fn(async () => resolved()),
          verifyModelRoute: vi.fn(async () => undefined),
          now: () => new Date("2026-01-01T00:00:00Z"),
        },
      }),
    ).rejects.toThrow("network unreachable");
  });
});
