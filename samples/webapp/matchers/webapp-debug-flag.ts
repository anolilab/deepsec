import type { CandidateMatch, MatcherPlugin } from "@anolilab/deepsec/config";
import { regexMatcher } from "@anolilab/deepsec/config";

/**
 * Debug surfaces gated only by an env-var flag. The webapp uses
 * `if (process.env.NODE_ENV !== "production")` and `DEBUG_API` flags
 * around routes that mount admin tools, dump caches, etc.
 *
 * Production envs occasionally leak NODE_ENV != "production" (preview
 * deploys, staging without strict env, container default), which means
 * these gates aren't a real authorization boundary. The AI's job is to
 * confirm whether the gated surface is sensitive and whether it has
 * any other guard.
 */
export const webappDebugFlag: MatcherPlugin = {
  slug: "webapp-debug-flag",
  description: "Routes/handlers gated only by env-var debug flags",
  noiseTier: "normal",
  filePatterns: ["src/api/**/*.ts", "src/server/**/*.ts"],
  match(content, filePath): CandidateMatch[] {
    if (/\.(test|spec)\.(ts|tsx)$/.test(filePath)) return [];
    return regexMatcher(
      "webapp-debug-flag",
      [
        {
          regex: /process\.env\.NODE_ENV\s*!==\s*['"]production['"]/,
          label: "NODE_ENV !== 'production' guard",
        },
        {
          regex: /process\.env\.NODE_ENV\s*===\s*['"](?:development|test|local)['"]/,
          label: "NODE_ENV === 'development' guard",
        },
        { regex: /process\.env\.DEBUG_API\b/, label: "DEBUG_API env flag" },
        { regex: /process\.env\.ENABLE_INTERNAL_TOOLS\b/, label: "ENABLE_INTERNAL_TOOLS env flag" },
      ],
      content,
    );
  },
};
