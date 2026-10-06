import type { CandidateMatch, MatcherPlugin } from "@anolilab/deepsec/config";

/**
 * API route handlers that don't go through the `withRateLimit(...)`
 * wrapper or call `rateLimiter.check(...)`. The webapp's convention is
 * that every public-facing handler (`src/api/**`) wraps its export
 * with `withRateLimit(handler, { window, max })`. Handlers that skip
 * the wrapper are candidates for abuse / cost amplification.
 *
 * Skips internal-only routes under `src/api/_internal/` and webhook
 * receivers (which are gated by signature verification instead).
 */
export const webappRouteNoRateLimit: MatcherPlugin = {
  slug: "webapp-route-no-rate-limit",
  description: "Public API handler not wrapped in withRateLimit / rateLimiter.check",
  noiseTier: "normal",
  filePatterns: ["src/api/**/route.ts", "src/api/**/handler.ts"],
  match(content, filePath): CandidateMatch[] {
    if (/\.(test|spec)\.(ts|tsx)$/.test(filePath)) return [];
    if (/\/_internal\//.test(filePath)) return [];
    if (/\/webhooks?\//.test(filePath)) return [];

    const HAS_RATE_LIMIT =
      /\bwithRateLimit\s*\(|\brateLimiter\s*\.\s*check\s*\(|\bratelimit\s*\.\s*limit\s*\(/;
    if (HAS_RATE_LIMIT.test(content)) return [];

    const lines = content.split("\n");
    const matches: CandidateMatch[] = [];
    const exportRe =
      /export\s+(?:async\s+)?(?:default|const|function)\s+(?:GET|POST|PUT|DELETE|PATCH|handler)\b/;

    for (let i = 0; i < lines.length; i++) {
      if (!exportRe.test(lines[i])) continue;
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 6);
      matches.push({
        vulnSlug: "webapp-route-no-rate-limit",
        lineNumbers: [i + 1],
        snippet: lines.slice(start, end).join("\n"),
        matchedPattern: "exported handler with no rate-limit wrapper in file",
      });
    }
    return matches;
  },
};
