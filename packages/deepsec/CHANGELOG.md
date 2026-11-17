## [2.4.1](https://github.com/anolilab/deepsec/compare/v2.4.0...v2.4.1) (2026-11-17)

### Bug Fixes

* **init:** run the login hint outside devEngines and detect quoted strictDepBuilds ([b7ab7ce](https://github.com/anolilab/deepsec/commit/b7ab7cecd1b25ab0efa4b16b5e447a482a021478))
* **init:** support pnpm 11+ and devEngines repositories ([fb6d64c](https://github.com/anolilab/deepsec/commit/fb6d64c1d44d62b5081587d02acc660ed16f4899)), closes [vercel-labs/deepsec#197](https://github.com/vercel-labs/deepsec/issues/197)

### Miscellaneous Chores

* **deps:** fix pnpm audit vulnerabilities ([239b4a7](https://github.com/anolilab/deepsec/commit/239b4a754a88442083979360f7861efb338ae41f))
* **deps:** update the Claude, Codex, and pi agent SDKs ([3ac8fe1](https://github.com/anolilab/deepsec/commit/3ac8fe1f0d706e35d695cc46e08313409b823c21)), closes [vercel-labs/deepsec#195](https://github.com/vercel-labs/deepsec/issues/195)

## [2.4.0](https://github.com/anolilab/deepsec/compare/v2.3.10...v2.4.0) (2026-10-07)

### Features

* **agents:** add OpenCode v2 runtime support to the opencode agent ([7ef0a08](https://github.com/anolilab/deepsec/commit/7ef0a088a507b03bac9434bebc152fdc0ced2fc0))
* **agents:** wire the Vercel AI Gateway option into the OpenCode v2 runtime ([250a7cb](https://github.com/anolilab/deepsec/commit/250a7cbf288b16608ca962cc9dfccd480abde543))

### Bug Fixes

* centralize severity ordering ([eaaa142](https://github.com/anolilab/deepsec/commit/eaaa1428c7f6b3492917d35f963ab55910704f82))
* **cli:** round token metrics to prevent table layout breakage ([cc1814f](https://github.com/anolilab/deepsec/commit/cc1814fa1f4c84c2981785b57f57df1fefd00e89))
* **codex:** prefer the codex CLI subscription login over ambient API keys ([#32](https://github.com/anolilab/deepsec/issues/32)) ([2b2cb39](https://github.com/anolilab/deepsec/commit/2b2cb3958c908a68e32758044a12852f3906ef2d))
* config matchers filter, no Vercel prompt for direct/custom routes, docs, flaky mac test ([1834dbf](https://github.com/anolilab/deepsec/commit/1834dbf5a88155b964781cdf8b0bbff78b91a7d3)), closes [#36](https://github.com/anolilab/deepsec/issues/36) [#164](https://github.com/anolilab/deepsec/issues/164) [#55](https://github.com/anolilab/deepsec/issues/55) [#51](https://github.com/anolilab/deepsec/issues/51)
* **processor:** adapt OpenCode plugin to evolved parse API + bump @opencode-ai/sdk to ^1.18.35 ([bfbadce](https://github.com/anolilab/deepsec/commit/bfbadce99c11ad1adf2cb002009eba7a09a5691d))
* **scanner:** error on unknown --matchers slugs instead of silently ignoring ([46ee4cd](https://github.com/anolilab/deepsec/commit/46ee4cdab849393435ff8670221bcb9fc639340e)), closes [#34](https://github.com/anolilab/deepsec/issues/34)
* **test:** use unlinkSync to clean up samples/webapp symlink (fixes [#51](https://github.com/anolilab/deepsec/issues/51)) ([08c971c](https://github.com/anolilab/deepsec/commit/08c971c40c87daa0f702583facaa17ae05a9c4ee)), closes [#50](https://github.com/anolilab/deepsec/issues/50)

### Documentation

* **models:** add recommended models & ensemble strategy section ([c4bfb4b](https://github.com/anolilab/deepsec/commit/c4bfb4b512fc477958086593bd2b68464d2bb4e2))
* **readme:** add 'What's improved vs. the original' section ([290f42b](https://github.com/anolilab/deepsec/commit/290f42b2488b5376829808e02533bc1d27b2754b)), closes [#164](https://github.com/anolilab/deepsec/issues/164) [#36](https://github.com/anolilab/deepsec/issues/36) [#32](https://github.com/anolilab/deepsec/issues/32)
* **readme:** add the AI agents section with the OpenCode backend option ([0c5c06e](https://github.com/anolilab/deepsec/commit/0c5c06e2404c9f04ba3b9e5c5a5d966a993aa05f))

### Miscellaneous Chores

* **release:** replace the OIDC workflow with semantic-release ([550ddcb](https://github.com/anolilab/deepsec/commit/550ddcb84a5c4fff2e64734ab0ad4634dead8b7f))
* **release:** use the release environment to match the npm trusted publisher ([eff5d2c](https://github.com/anolilab/deepsec/commit/eff5d2ca7f820843af7388233e940e9d9c1a7bc2))
* update all dependencies to latest, pnpm 8 -> 12, fix audit findings ([08f5c96](https://github.com/anolilab/deepsec/commit/08f5c9634d2798f0b4e2c4b851221d6f2bea3bc9))
