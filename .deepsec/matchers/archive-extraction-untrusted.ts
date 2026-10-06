import type { CandidateMatch, MatcherPlugin } from "@anolilab/deepsec/config";

/**
 * Archive-extraction sites where a tarball/zip is unpacked to disk. Without
 * an explicit entry-path validation pass (`path.relative(dest, x).startsWith(..)`,
 * realpath check, allowlist regex), a malicious archive can write outside the
 * destination via `..` segments, absolute paths, or symlinks (CWE-22 + CWE-59,
 * the "Zip Slip" / "Tar Slip" family).
 *
 * Specific to deepsec: `packages/deepsec/src/sandbox/download.ts` extracts a
 * tarball received from a remote Vercel Sandbox into the local `data/<id>/`
 * mirror. The sandbox is untrusted from the scanner host's POV — anything in
 * that tarball is attacker-controlled in the threat model. The built-in `rce`
 * matcher fires on the `spawn` call but doesn't reason about archive paths.
 *
 * The agent's job is to confirm whether the extraction site validates entry
 * paths before writing them.
 */
const PATTERNS: { regex: RegExp; label: string }[] = [
  {
    regex: /\bspawn(?:Sync)?\s*\(\s*["']tar["']\s*,\s*\[[^\]]*["']-[a-z]*x[a-zA-Z]*["']/,
    label: "shell tar with -x flag (extract)",
  },
  {
    regex: /\bexecSync\s*\(\s*[`"'][^`"']*\btar\s+(?:-[a-z]*x|x[a-z]*)\b/,
    label: "execSync with tar -x (extract)",
  },
  {
    regex: /\btar\.(?:x|extract)\s*\(/,
    label: "node-tar extract (tar.x / tar.extract)",
  },
  {
    regex: /\bunzipper\.Extract\s*\(/,
    label: "unzipper Extract stream",
  },
  {
    regex: /\bextractZip\s*\(|\brequire\s*\(\s*["']extract-zip["']\s*\)/,
    label: "extract-zip package",
  },
  {
    regex: /\bdecompress\s*\(/,
    label: "decompress() call",
  },
  {
    regex: /\bnew\s+AdmZip\s*\(|\b\.extractAllTo\s*\(/,
    label: "adm-zip extractAllTo",
  },
];

/**
 * Hints that the file already does entry-path validation. If any of these
 * appear within ~6 lines of the extract call, suppress — the file is likely
 * applying a Zip-Slip guard. Imperfect but cuts the obvious noise.
 */
const HAS_BOUNDARY_HINT =
  /\bpath\.relative\s*\([^)]*\)\.startsWith|\brealpath(?:Sync)?\s*\(|\bpath\.normalize\s*\(\s*entry|\bif\s*\(\s*entry\.path\.(?:includes|startsWith|match)|\bfilter\s*:\s*\([^)]*\)\s*=>|\bonentry\s*:|\bisAbsolute\s*\(\s*entry/;

export const archiveExtractionUntrusted: MatcherPlugin = {
  slug: "archive-extraction-untrusted",
  description:
    "Archive (tar/zip) extraction without visible entry-path validation — verify Zip-Slip guard",
  noiseTier: "normal",
  filePatterns: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
  match(content, filePath): CandidateMatch[] {
    if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filePath)) return [];
    if (/\.d\.ts$/.test(filePath)) return [];

    const lines = content.split("\n");
    const matches: CandidateMatch[] = [];

    for (const { regex, label } of PATTERNS) {
      const hitLines: number[] = [];
      let firstSnippet = "";

      for (let i = 0; i < lines.length; i++) {
        if (!regex.test(lines[i])) continue;

        const window = lines.slice(Math.max(0, i - 6), Math.min(lines.length, i + 6)).join("\n");
        if (HAS_BOUNDARY_HINT.test(window)) continue;

        hitLines.push(i + 1);
        if (!firstSnippet) {
          const start = Math.max(0, i - 2);
          const end = Math.min(lines.length, i + 4);
          firstSnippet = lines.slice(start, end).join("\n");
        }
      }

      if (hitLines.length > 0) {
        matches.push({
          vulnSlug: "archive-extraction-untrusted",
          lineNumbers: hitLines,
          snippet: firstSnippet,
          matchedPattern: label,
        });
      }
    }

    return matches;
  },
};
