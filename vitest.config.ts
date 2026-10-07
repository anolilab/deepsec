import { defineConfig } from "vitest/config";

// pnpm/vitest 10+: the workspace file is gone; project globs live under
// `test.projects` in this root config. Project names (core, scanner,
// processor, cli, e2e) come from each package's vitest.config.ts.
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "e2e/vitest.config.ts"],
  },
});
