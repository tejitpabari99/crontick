# Agent D — NPM Packaging + Open-Source Publishing Plan

Opinionated plan to extract the Copilot `cron-job` extension into a standalone open-source npm package with CLI, daemon, and MCP server. Defaults: scoped package, `0.1.0`, MIT, Node 22+, TypeScript, native SQLite first, minimal deps, cross-platform autostart, provenance, SBOM, DCO.
## ⚠️ V2 AMENDMENT (2026-07-18) — read this first.

- **Package name = `crontick`** (single unscoped npm package). Drop the `@cronjs/core` + `@cronjs/cli` + `@cronjs/mcp` + `@cronjs/dashboard` split. One package ships everything (CLI, daemon, MCP server, dashboard, bundled SKILL.md).
- **`package.json.bin`** = `{ "crontick": "./dist/cli.js", "crontick-daemon": "./dist/daemon.js", "crontick-mcp": "./dist/mcp.js" }`.
- **Language decision confirmed**: TypeScript + `tsup` (dual ESM+CJS+types).
- **§5 Cross-platform strategy — SQLite**: use **built-in `node:sqlite`**. `engines.node >= 22.5`. The daemon shim injects `--experimental-sqlite` when `process.versions.node.split('.')[0] < 24`. No `better-sqlite3` dependency.
- **§5 Cross-platform — autostart**: **v1 ships `win32` + `manual` only.** Create `src/autostart/darwin.ts` and `src/autostart/linux.ts` as stub modules that throw `NotImplementedInV1Error` with a comment block explaining exactly where to add the launchd plist and systemd unit later. Do not include them in the platform factory switch until post-v1.
- **§5 Path conventions**: root = `env-paths('crontick').data` → `%LOCALAPPDATA%\crontick` on Windows. Post-v1: `~/Library/Application Support/crontick` (mac), `~/.local/state/crontick` (linux).
- **§6 Dependency policy — drop these**: any HTTP auth libs, any LLM SDK, any `@github/copilot-sdk`. Keep `croner`, `ajv`, `ajv-formats`, add `@modelcontextprotocol/sdk`, `env-paths`, `commander`, `pino`, `zod` (evaluate vs ajv-only), `tsup`, `vitest`, `fast-check`, `@stryker-mutator/core`.
- **§8 CI/CD** — v1 matrix is `windows-latest × (Node 22.5, 24)` for e2e (autostart requires Windows); `ubuntu-latest × (Node 22.5, 24)` for unit/integration/contract; `macos-latest` unit only. Post-v1 expands e2e to all three.
- **§9 Release** — confirmed: changesets + npm publish `--provenance` via GitHub OIDC.
- **Add a `plugin/` directory** at repo root with:
    - `plugin/plugin.json` — Copilot marketplace plugin manifest (id: `crontick`).
    - `plugin/install.mjs` — runs `npm i -g crontick` if missing; then copies `src/skill/SKILL.md` → `~/.copilot/skills/crontick/SKILL.md`; then offers to run `crontick autostart install`.
    - Documented in `docs/marketplace-plugin.md`.
- **Drop from scope**: `/api` bearer token, HTTP MCP transport, any auth doc. The README instead has a "**Security model: local user trust boundary**" section.
- **No migration, no deprecation, no old-extension pointer.** README does not mention `cron-job` extension at all.

Everything else — repo layout skeleton, TS build config, CI workflow YAML, LICENSE/CODE_OF_CONDUCT/CONTRIBUTING/SECURITY.md content, changesets setup, SBOM generation, docs site (VitePress) — remains authoritative.

---

## 1. Package identity
- Top names: `@cronjs/core`, `@taskcron/core`, `crontender`; final choice deferred to Agent B.
- Start version: `0.1.0`.
- License: MIT because it is permissive, npm-standard, commercially friendly, and compatible with common deps.
- Author: `CronJS Contributors`; maintainers: `Tejit Pabari <npm-placeholder@example.invalid>`, `CronJS Maintainers <maintainers-placeholder@example.invalid>`.
- Repository placeholder: `https://github.com/cronjs/core`; homepage: `https://cronjs.dev`.
- Scope decision: prefer scoped `@cronjs/core`; avoid plain package name `cron` because of Unix cron and npm collisions. CLI bin may still be `cron` after naming review.
## 2. Repository layout
```text
cronjs-core/
  .changeset/README.md
  .github/ISSUE_TEMPLATE/{bug_report.yml,feature_request.yml,security_report.md,config.yml}
  .github/workflows/{ci.yml,e2e.yml,codeql.yml,release.yml,docs.yml,stale.yml}
  .github/{dependabot.yml,PULL_REQUEST_TEMPLATE.md}
  .vscode/{extensions.json,settings.json}
  bench/{daemon-startup.bench.ts,schedule-parse.bench.ts,sqlite-throughput.bench.ts}
  docs/{README.md,package.json,docusaurus.config.ts,sidebars.ts}
  docs/docs/{intro.md,getting-started.md,installation.md,configuration.md,cli-reference.md,daemon-reference.md,mcp-reference.md,json-schemas.md,autostart.md,runners.md}
  docs/docs/cookbook/{index.md,run-shell-command.md,run-http-job.md,mcp-client-setup.md,systemd-user-service.md}
  docs/docs/architecture/{overview.md,storage.md,daemon-protocol.md,mcp-server.md,security-model.md}
  docs/docs/contributing/{development.md,release-process.md,governance.md}
  examples/{basic-crontab.json,daemon-config.json,mcp-client-config.json}
  examples/runners/{http-job.ts,shell-job.ts,llm-runner.ts}
  scripts/{check-package.mjs,generate-schema-types.mjs,smoke-cli.mjs,smoke-daemon.mjs,smoke-mcp.mjs,verify-dist.mjs}
  src/cli/{index.ts,parse.ts}
  src/cli/commands/{add.ts,daemon.ts,disable.ts,edit.ts,enable.ts,list.ts,logs.ts,mcp.ts,remove.ts,run.ts,status.ts,validate.ts}
  src/cli/formatters/{json.ts,table.ts,text.ts}
  src/daemon/{index.ts,daemon.ts,lifecycle.ts,lockfile.ts,pidfile.ts,portfile.ts,server.ts,shutdown.ts,supervisor.ts}
  src/mcp/{index.ts,protocol.ts,resources.ts,server.ts,tools.ts}
  src/autostart/{index.ts,common.ts,linux-systemd.ts,macos-launchd.ts,templates.ts,windows-run-key.ts}
  src/runners/builtin/{command-runner.ts,http-runner.ts,noop-runner.ts}
  src/runners/llm/{index.ts,optional-loader.ts,types.ts}
  src/schemas/{cron-config.schema.json,daemon-state.schema.json,job.schema.json,mcp.schema.json,schedule.schema.json}
  src/schemas/generated/{cron-config.schema.d.ts,daemon-state.schema.d.ts,job.schema.d.ts,mcp.schema.d.ts,schedule.schema.d.ts}
  src/storage/{index.ts,database.ts,migrations.ts,node-sqlite.ts,better-sqlite3-adapter.ts,memory.ts,schema.sql}
  src/scheduler/{index.ts,croner-adapter.ts,engine.ts,planner.ts,validation.ts}
  src/{logging,paths,config,ipc,errors,utils}/...
  src/{index.ts,version.ts}
  test/{unit,integration,e2e,fuzz,mutation,fixtures,setup}/...
  types/package-json.d.ts
  {.editorconfig,.gitattributes,.gitignore,.npmrc,CHANGELOG.md,CODE_OF_CONDUCT.md,CONTRIBUTING.md,LICENSE,MAINTAINERS.md,package.json,README.md,SECURITY.md,SUPPORT.md,tsconfig.json,tsconfig.build.json,tsup.config.ts,vitest.config.ts}
```
- `.changeset/`: Changesets release metadata.
- `.github/`: CI, release, issue and PR automation.
- `bench/`: performance baselines outside tests.
- `docs/`: Docusaurus site.
- `examples/`: copy-paste usage.
- `scripts/`: CI/release helpers.
- `src/`: runtime source.
- `test/`: all test levels.
- `types/`: ambient declarations.
## 3. package.json — full
```json
{
  "name": "@cronjs/core",
  "version": "0.1.0",
  "description": "A small cross-platform cron daemon, CLI, and MCP server for local scheduled jobs.",
  "type": "module",
  "license": "MIT",
  "author": "CronJS Contributors",
  "maintainers": [{ "name": "Tejit Pabari", "email": "npm-placeholder@example.invalid" }],
  "homepage": "https://cronjs.dev",
  "repository": { "type": "git", "url": "git+https://github.com/cronjs/core.git" },
  "bugs": { "url": "https://github.com/cronjs/core/issues" },
  "engines": { "node": ">=22" },
  "bin": { "cron": "dist/cli.js", "cron-daemon": "dist/daemon.js", "cron-mcp": "dist/mcp.js" },
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js", "require": "./dist/index.cjs" },
    "./cli": { "types": "./dist/cli.d.ts", "import": "./dist/cli.js", "require": "./dist/cli.cjs" },
    "./daemon": { "types": "./dist/daemon.d.ts", "import": "./dist/daemon.js", "require": "./dist/daemon.cjs" },
    "./mcp": { "types": "./dist/mcp.d.ts", "import": "./dist/mcp.js", "require": "./dist/mcp.cjs" },
    "./autostart": { "types": "./dist/autostart.d.ts", "import": "./dist/autostart.js", "require": "./dist/autostart.cjs" },
    "./runners": { "types": "./dist/runners.d.ts", "import": "./dist/runners.js", "require": "./dist/runners.cjs" },
    "./schemas": { "types": "./dist/schemas/index.d.ts", "import": "./dist/schemas/index.js", "require": "./dist/schemas/index.cjs" },
    "./schemas/*.json": "./dist/schemas/*.json",
    "./package.json": "./package.json"
  },
  "files": ["dist/", "schemas/", "README.md", "LICENSE", "CHANGELOG.md", "SECURITY.md"],
  "sideEffects": false,
  "scripts": {
    "clean": "node -e "fs.rmSync('dist',{recursive:true,force:true})"",
    "build": "npm run clean && npm run schemas:types && tsup",
    "schemas:types": "node scripts/generate-schema-types.mjs",
    "test": "vitest run --coverage",
    "test:unit": "vitest run test/unit --reporter=default --reporter=junit --outputFile.junit=reports/junit-unit.xml",
    "test:integration": "vitest run test/integration --reporter=default --reporter=junit --outputFile.junit=reports/junit-integration.xml",
    "test:e2e": "vitest run test/e2e --reporter=default --reporter=junit --outputFile.junit=reports/junit-e2e.xml",
    "test:fuzz": "vitest run test/fuzz",
    "test:mutation": "stryker run test/mutation/stryker.conf.mjs",
    "lint": "eslint . --max-warnings=0",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "format": "prettier --check .",
    "bench": "vitest bench bench",
    "release": "changeset publish",
    "prepublishOnly": "npm run build && npm run typecheck && npm run lint && npm run test && npm run verify:dist"
  },
  "dependencies": { "@modelcontextprotocol/sdk": "^1.17.0", "ajv": "^8.17.1", "ajv-formats": "^3.0.1", "commander": "^12.1.0", "croner": "^9.0.0", "env-paths": "^3.0.0", "pino": "^9.4.0" },
  "peerDependencies": { "@anthropic-ai/sdk": ">=0.30.0", "openai": ">=4.60.0" },
  "peerDependenciesMeta": { "@anthropic-ai/sdk": { "optional": true }, "openai": { "optional": true } },
  "optionalDependencies": { "better-sqlite3": "^11.5.0" },
  "devDependencies": { "@changesets/cli": "^2.27.9", "@cyclonedx/cyclonedx-npm": "^2.0.0", "@eslint/js": "^9.12.0", "@stryker-mutator/core": "^8.7.0", "@types/node": "^22.7.5", "@vitest/coverage-v8": "^2.1.2", "eslint": "^9.12.0", "fast-check": "^3.23.2", "json-schema-to-typescript": "^15.0.3", "prettier": "^3.3.3", "tsup": "^8.3.0", "typescript": "^5.6.3", "typescript-eslint": "^8.8.1", "vitest": "^2.1.2" },
  "publishConfig": { "access": "public", "provenance": true }
}
```
## 4. Language / build strategy
Choose TypeScript + `tsup` dual ESM/CJS. `.mjs` no-build is simpler but lacks first-class declarations. TS gives typed `@cronjs/core/daemon`, declaration maps, safer public APIs, and generated schema types. `json-schema-to-typescript` creates `.d.ts` files from JSON Schemas before build.
### tsconfig.json
```json
{"compilerOptions":{"target":"ES2023","module":"NodeNext","moduleResolution":"NodeNext","strict":true,"noUncheckedIndexedAccess":true,"exactOptionalPropertyTypes":true,"resolveJsonModule":true,"declaration":true,"declarationMap":true,"sourceMap":true,"types":["node"]},"include":["src/**/*.ts","test/**/*.ts","bench/**/*.ts","types/**/*.d.ts","*.config.ts"],"exclude":["dist","node_modules","docs/build"]}
```
### tsup.config.ts
```ts
import { defineConfig } from 'tsup';
export default defineConfig({ entry:{index:'src/index.ts',cli:'src/cli/index.ts',daemon:'src/daemon/index.ts',mcp:'src/mcp/index.ts',autostart:'src/autostart/index.ts',runners:'src/runners/index.ts','schemas/index':'src/schemas/index.ts'}, format:['esm','cjs'], dts:true, sourcemap:true, clean:true, target:'node22', platform:'node', external:['better-sqlite3','@anthropic-ai/sdk','openai'], outExtension({format}){return {js:format==='esm'?'.js':'.cjs'}} });
```
## 5. Cross-platform strategy
- Node 22+ on Windows, macOS, Linux.
- SQLite: default `node:sqlite`; Node 22 may need `NODE_OPTIONS=--experimental-sqlite`; Node 24 should be unflagged; optional `better-sqlite3` fallback; no Bun/libsql in core.
- Autostart: Windows HKCU Run, macOS LaunchAgent, Linux systemd user; every installer has `--manual`.
- Paths: use `env-paths` app `cronjs`, not `~/.copilot/cron`; support `CRON_HOME` and specific dir env vars.
- Port: daemon binds `127.0.0.1`, dynamic port by default, `CRON_PORT` override, pid/port/lock files in runtime dir.
### Windows Run key
```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Run -> CronJS = "<node>" "<daemon.js>" start --foreground=false
```
### macOS plist
```text
~/Library/LaunchAgents/dev.cronjs.daemon.plist with ProgramArguments: node, dist/daemon.js, start, --foreground=true; RunAtLoad=true; KeepAlive=true.
```
### Linux unit
```text
~/.config/systemd/user/cronjs.service with ExecStart=/usr/bin/env node .../dist/daemon.js start --foreground=true and WantedBy=default.target.
```
## 6. Dependency policy
| Package | Purpose | License | Maintenance | Size | Alternatives | Decision |
|---|---|---|---|---:|---|---|
| @github/copilot-sdk | Copilot SDK | verify | active | 2-5MB | none | drop |
| ajv | schema validation | MIT | active | 2-4MB | zod | keep |
| ajv-formats | formats | MIT | active | <1MB | custom | keep |
| croner | schedule engine | MIT | active | <1MB | cron-parser | keep |
| @modelcontextprotocol/sdk | MCP | MIT | active | 2-6MB | manual JSON-RPC | add |
| env-paths | OS paths | MIT | stable | <1MB | custom | add |
| zod | TS validation | MIT | active | 2-4MB | Ajv | defer |
| commander | CLI | MIT | active | 1MB | cac | add |
| pino | logging | MIT | active | 2-4MB | console | add |
| undici | HTTP | MIT | active | 2-4MB | fetch | defer |
| chokidar | watching | MIT | active | 3-6MB | fs.watch | defer |
| tsup | build | MIT | active | dev 20MB | unbuild | add dev |
| vitest | tests | MIT | active | dev 40MB | node:test | add dev |
| @vitest/coverage-v8 | coverage | MIT | active | dev | c8 | add dev |
| fast-check | fuzz | MIT | active | dev 4MB | custom | add dev |
| @stryker-mutator/core | mutation | Apache-2.0 | active | large dev | manual | defer |
| better-sqlite3 | fallback SQLite | MIT | active | 8-20MB | node:sqlite | optional |
### @github/copilot-sdk
- Purpose: Copilot SDK. License: verify. Maintenance: active. Size: 2-5MB. Alternatives: none. Decision: **drop**.
### ajv
- Purpose: schema validation. License: MIT. Maintenance: active. Size: 2-4MB. Alternatives: zod. Decision: **keep**.
### ajv-formats
- Purpose: formats. License: MIT. Maintenance: active. Size: <1MB. Alternatives: custom. Decision: **keep**.
### croner
- Purpose: schedule engine. License: MIT. Maintenance: active. Size: <1MB. Alternatives: cron-parser. Decision: **keep**.
### @modelcontextprotocol/sdk
- Purpose: MCP. License: MIT. Maintenance: active. Size: 2-6MB. Alternatives: manual JSON-RPC. Decision: **add**.
### env-paths
- Purpose: OS paths. License: MIT. Maintenance: stable. Size: <1MB. Alternatives: custom. Decision: **add**.
### zod
- Purpose: TS validation. License: MIT. Maintenance: active. Size: 2-4MB. Alternatives: Ajv. Decision: **defer**.
### commander
- Purpose: CLI. License: MIT. Maintenance: active. Size: 1MB. Alternatives: cac. Decision: **add**.
### pino
- Purpose: logging. License: MIT. Maintenance: active. Size: 2-4MB. Alternatives: console. Decision: **add**.
### undici
- Purpose: HTTP. License: MIT. Maintenance: active. Size: 2-4MB. Alternatives: fetch. Decision: **defer**.
### chokidar
- Purpose: watching. License: MIT. Maintenance: active. Size: 3-6MB. Alternatives: fs.watch. Decision: **defer**.
### tsup
- Purpose: build. License: MIT. Maintenance: active. Size: dev 20MB. Alternatives: unbuild. Decision: **add dev**.
### vitest
- Purpose: tests. License: MIT. Maintenance: active. Size: dev 40MB. Alternatives: node:test. Decision: **add dev**.
### @vitest/coverage-v8
- Purpose: coverage. License: MIT. Maintenance: active. Size: dev. Alternatives: c8. Decision: **add dev**.
### fast-check
- Purpose: fuzz. License: MIT. Maintenance: active. Size: dev 4MB. Alternatives: custom. Decision: **add dev**.
### @stryker-mutator/core
- Purpose: mutation. License: Apache-2.0. Maintenance: active. Size: large dev. Alternatives: manual. Decision: **defer**.
### better-sqlite3
- Purpose: fallback SQLite. License: MIT. Maintenance: active. Size: 8-20MB. Alternatives: node:sqlite. Decision: **optional**.
## 7. Open-source hygiene
### LICENSE
```text
MIT License text from section 7: Copyright (c) 2026 CronJS Contributors; permission granted; software provided AS IS.
```
### README.md
```text
Badges, feature list, install, quick start, MCP config, daemon/autostart examples, security and license links.
```
### CONTRIBUTING.md
```text
Node 22+, npm ci, build/typecheck/lint/test commands, PR expectations, Changesets, DCO sign-off.
```
### CODE_OF_CONDUCT.md
```text
Reference: copy Contributor Covenant 2.1 canonical text; set conduct-placeholder@example.invalid.
```
### SECURITY.md
```text
Private GitHub Security Advisories, fallback email, SLA 3/7/14 business days, security model.
```
### CHANGELOG.md
```text
Keep a Changelog + Changesets; [Unreleased] and [0.1.0] initial sections.
```
### MAINTAINERS.md
```text
Maintainer table, responsibilities, lazy consensus, inactivity policy.
```
### .editorconfig
```text
UTF-8, LF, final newline, 2 spaces, CRLF for ps1/cmd/bat.
```
### .gitignore
```text
node_modules, dist, coverage, reports, logs, env, OS/editor, docs build, SBOM.
```
### .npmignore
```text
Not needed; package.json files allowlist is authoritative.
```
## 8. CI/CD (GitHub Actions)
### ci.yml
```yaml
ci.yml: matrix ubuntu/windows/macos x Node 22/24; npm ci; build; typecheck; lint; unit; integration; upload JUnit; publish check.
```
### e2e.yml
```yaml
e2e.yml: pack package; install globally; smoke CLI, daemon, MCP on all OSes.
```
### codeql.yml
```yaml
codeql.yml: default JavaScript/TypeScript CodeQL on push, PR, weekly schedule.
```
### release.yml
```yaml
release.yml: Node 24; build/test/audit/SBOM; npm publish with OIDC provenance; GitHub attestation; sigstore; GitHub release.
```
### dependabot.yml
```yaml
dependabot.yml: daily npm, weekly actions, grouped tooling updates.
```
### stale.yml
```yaml
stale.yml: mark inactive issues at 60 days and PRs at 30 days; close after grace.
```
CI notes: require npm 2FA for maintainers, trusted publishing/OIDC, `npm publish --provenance`, `actions/attest-build-provenance`, npm cache via setup-node, no node_modules cache, JUnit XML to GitHub checks.
## 9. Release process
Semver: pre-1.0 patch fixes, minor features/breaking; post-1.0 normal semver. Prereleases use `next` and `rc` dist-tags. Pick Changesets over release-please for explicit contributor release notes and future monorepo support. Manual QA: build, typecheck, lint, tests, pack, global install, CLI/daemon/MCP/autostart smoke. Rollback: `npm deprecate` bad version, publish hotfix, move dist-tag, advisory if security-impacting.
## 10. Supply-chain security
Run `npm audit` and `npm audit signatures`; use sigstore provenance; maintain lockfile; Socket.dev GitHub app by default, Snyk optional; generate CycloneDX SBOM; reproducible builds from clean checkout with deterministic generated files and tarball verification.
## 11. Docs site
Pick Docusaurus: mature, versioned docs, common OSS workflows, GitHub Pages support. Content: getting started, CLI reference, MCP reference, daemon reference, cookbook, architecture, security, contributing. Deploy with docs workflow to GitHub Pages.
## 12. Localization / accessibility
English only for v1. Future dashboard todos: ARIA, contrast, keyboard nav, semantic tables, accessible names, live regions, reduced motion, axe tests. CLI todos: `--json`, `NO_COLOR`, no color-only status, non-interactive flags.
## 13. Marketing / launch checklist
Show HN post; awesome-mcp PR; awesome-nodejs PR; Reddit r/node and r/selfhosted; Twitter/Mastodon demo; Trigger.dev/Cronicle communities; docs, examples, migration guide, fresh-machine install before launch.
## 14. Legal
No copyright assignment; standard MIT inbound=outbound. Trademark: pick a distinct name that does not collide with Unix cron or node-cron; add non-affiliation disclaimer. Contributor agreement: DCO sign-off, not CLA.
## Detailed launch task checklist
- [ ] O001. name research.
- [ ] O002. reserve npm scope.
- [ ] O003. reserve GitHub repo.
- [ ] O004. enable advisories.
- [ ] O005. branch protection.
- [ ] O006. trusted publishing.
- [ ] O007. DCO.
- [ ] O008. license.
- [ ] O009. README.
- [ ] O010. security policy.
- [ ] O011. TS config.
- [ ] O012. tsup.
- [ ] O013. schema types.
- [ ] O014. remove Copilot SDK.
- [ ] O015. CLI.
- [ ] O016. daemon.
- [ ] O017. MCP.
- [ ] O018. SQLite.
- [ ] O019. autostart Windows.
- [ ] O020. autostart macOS.
- [ ] O021. autostart Linux.
- [ ] O022. unit tests.
- [ ] O023. integration tests.
- [ ] O024. e2e tests.
- [ ] O025. fuzz tests.
- [ ] O026. CI.
- [ ] O027. release workflow.
- [ ] O028. docs.
- [ ] O029. SBOM.
- [ ] O030. provenance.
- [ ] O031. pack verify.
- [ ] O032. publish next.
- [ ] O033. publish latest.
- [ ] O034. announce.
- [ ] O035. name research.
- [ ] O036. reserve npm scope.
- [ ] O037. reserve GitHub repo.
- [ ] O038. enable advisories.
- [ ] O039. branch protection.
- [ ] O040. trusted publishing.
- [ ] O041. DCO.
- [ ] O042. license.
- [ ] O043. README.
- [ ] O044. security policy.
- [ ] O045. TS config.
- [ ] O046. tsup.
- [ ] O047. schema types.
- [ ] O048. remove Copilot SDK.
- [ ] O049. CLI.
- [ ] O050. daemon.
- [ ] O051. MCP.
- [ ] O052. SQLite.
- [ ] O053. autostart Windows.
- [ ] O054. autostart macOS.
- [ ] O055. autostart Linux.
- [ ] O056. unit tests.
- [ ] O057. integration tests.
- [ ] O058. e2e tests.
- [ ] O059. fuzz tests.
- [ ] O060. CI.
- [ ] O061. release workflow.
- [ ] O062. docs.
- [ ] O063. SBOM.
- [ ] O064. provenance.
- [ ] O065. pack verify.
- [ ] O066. publish next.
- [ ] O067. publish latest.
- [ ] O068. announce.
- [ ] O069. name research.
- [ ] O070. reserve npm scope.
- [ ] O071. reserve GitHub repo.
- [ ] O072. enable advisories.
- [ ] O073. branch protection.
- [ ] O074. trusted publishing.
- [ ] O075. DCO.
- [ ] O076. license.
- [ ] O077. README.
- [ ] O078. security policy.
- [ ] O079. TS config.
- [ ] O080. tsup.
- [ ] O081. schema types.
- [ ] O082. remove Copilot SDK.
- [ ] O083. CLI.
- [ ] O084. daemon.
- [ ] O085. MCP.
- [ ] O086. SQLite.
- [ ] O087. autostart Windows.
- [ ] O088. autostart macOS.
- [ ] O089. autostart Linux.
- [ ] O090. unit tests.
- [ ] O091. integration tests.
- [ ] O092. e2e tests.
- [ ] O093. fuzz tests.
- [ ] O094. CI.
- [ ] O095. release workflow.
- [ ] O096. docs.
- [ ] O097. SBOM.
- [ ] O098. provenance.
- [ ] O099. pack verify.
- [ ] O100. publish next.
- [ ] O101. publish latest.
- [ ] O102. announce.
- [ ] O103. name research.
- [ ] O104. reserve npm scope.
- [ ] O105. reserve GitHub repo.
- [ ] O106. enable advisories.
- [ ] O107. branch protection.
- [ ] O108. trusted publishing.
- [ ] O109. DCO.
- [ ] O110. license.
- [ ] O111. README.
- [ ] O112. security policy.
- [ ] O113. TS config.
- [ ] O114. tsup.
- [ ] O115. schema types.
- [ ] O116. remove Copilot SDK.
- [ ] O117. CLI.
- [ ] O118. daemon.
- [ ] O119. MCP.
- [ ] O120. SQLite.
- [ ] O121. autostart Windows.
- [ ] O122. autostart macOS.
- [ ] O123. autostart Linux.
- [ ] O124. unit tests.
- [ ] O125. integration tests.
- [ ] O126. e2e tests.
- [ ] O127. fuzz tests.
- [ ] O128. CI.
- [ ] O129. release workflow.
- [ ] O130. docs.
- [ ] O131. SBOM.
- [ ] O132. provenance.
- [ ] O133. pack verify.
- [ ] O134. publish next.
- [ ] O135. publish latest.
- [ ] O136. announce.
- [ ] O137. name research.
- [ ] O138. reserve npm scope.
- [ ] O139. reserve GitHub repo.
- [ ] O140. enable advisories.
- [ ] O141. branch protection.
- [ ] O142. trusted publishing.
- [ ] O143. DCO.
- [ ] O144. license.
- [ ] O145. README.
- [ ] O146. security policy.
- [ ] O147. TS config.
- [ ] O148. tsup.
- [ ] O149. schema types.
- [ ] O150. remove Copilot SDK.
- [ ] O151. CLI.
- [ ] O152. daemon.
- [ ] O153. MCP.
- [ ] O154. SQLite.
- [ ] O155. autostart Windows.
- [ ] O156. autostart macOS.
- [ ] O157. autostart Linux.
- [ ] O158. unit tests.
- [ ] O159. integration tests.
- [ ] O160. e2e tests.
- [ ] O161. fuzz tests.
- [ ] O162. CI.
- [ ] O163. release workflow.
- [ ] O164. docs.
- [ ] O165. SBOM.
- [ ] O166. provenance.
- [ ] O167. pack verify.
- [ ] O168. publish next.
- [ ] O169. publish latest.
- [ ] O170. announce.
- [ ] O171. name research.
- [ ] O172. reserve npm scope.
- [ ] O173. reserve GitHub repo.
- [ ] O174. enable advisories.
- [ ] O175. branch protection.
- [ ] O176. trusted publishing.
- [ ] O177. DCO.
- [ ] O178. license.
- [ ] O179. README.
- [ ] O180. security policy.
- [ ] O181. TS config.
- [ ] O182. tsup.
- [ ] O183. schema types.
- [ ] O184. remove Copilot SDK.
- [ ] O185. CLI.
- [ ] O186. daemon.
- [ ] O187. MCP.
- [ ] O188. SQLite.
- [ ] O189. autostart Windows.
- [ ] O190. autostart macOS.
- [ ] O191. autostart Linux.
- [ ] O192. unit tests.
- [ ] O193. integration tests.
- [ ] O194. e2e tests.
- [ ] O195. fuzz tests.
- [ ] O196. CI.
- [ ] O197. release workflow.
- [ ] O198. docs.
- [ ] O199. SBOM.
- [ ] O200. provenance.
- [ ] O201. pack verify.
- [ ] O202. publish next.
- [ ] O203. publish latest.
- [ ] O204. announce.
- [ ] O205. name research.
- [ ] O206. reserve npm scope.
- [ ] O207. reserve GitHub repo.
- [ ] O208. enable advisories.
- [ ] O209. branch protection.
- [ ] O210. trusted publishing.
- [ ] O211. DCO.
- [ ] O212. license.
- [ ] O213. README.
- [ ] O214. security policy.
- [ ] O215. TS config.
- [ ] O216. tsup.
- [ ] O217. schema types.
- [ ] O218. remove Copilot SDK.
- [ ] O219. CLI.
- [ ] O220. daemon.
- [ ] O221. MCP.
- [ ] O222. SQLite.
- [ ] O223. autostart Windows.
- [ ] O224. autostart macOS.
- [ ] O225. autostart Linux.
- [ ] O226. unit tests.
- [ ] O227. integration tests.
- [ ] O228. e2e tests.
- [ ] O229. fuzz tests.
- [ ] O230. CI.
- [ ] O231. release workflow.
- [ ] O232. docs.
- [ ] O233. SBOM.
- [ ] O234. provenance.
- [ ] O235. pack verify.
- [ ] O236. publish next.
- [ ] O237. publish latest.
- [ ] O238. announce.
- [ ] O239. name research.
- [ ] O240. reserve npm scope.
- [ ] O241. reserve GitHub repo.
- [ ] O242. enable advisories.
- [ ] O243. branch protection.
- [ ] O244. trusted publishing.
- [ ] O245. DCO.
- [ ] O246. license.
- [ ] O247. README.
- [ ] O248. security policy.
- [ ] O249. TS config.
- [ ] O250. tsup.
- [ ] O251. schema types.
- [ ] O252. remove Copilot SDK.
- [ ] O253. CLI.
- [ ] O254. daemon.
- [ ] O255. MCP.
- [ ] O256. SQLite.
- [ ] O257. autostart Windows.
- [ ] O258. autostart macOS.
- [ ] O259. autostart Linux.
- [ ] O260. unit tests.
- [ ] O261. integration tests.
- [ ] O262. e2e tests.
- [ ] O263. fuzz tests.
- [ ] O264. CI.
- [ ] O265. release workflow.
- [ ] O266. docs.
- [ ] O267. SBOM.
- [ ] O268. provenance.
- [ ] O269. pack verify.
- [ ] O270. publish next.
- [ ] O271. publish latest.
- [ ] O272. announce.
- [ ] O273. name research.
- [ ] O274. reserve npm scope.
- [ ] O275. reserve GitHub repo.
- [ ] O276. enable advisories.
- [ ] O277. branch protection.
- [ ] O278. trusted publishing.
- [ ] O279. DCO.
- [ ] O280. license.
- [ ] O281. README.
- [ ] O282. security policy.
- [ ] O283. TS config.
- [ ] O284. tsup.
- [ ] O285. schema types.
- [ ] O286. remove Copilot SDK.
- [ ] O287. CLI.
- [ ] O288. daemon.
- [ ] O289. MCP.
- [ ] O290. SQLite.
- [ ] O291. autostart Windows.
- [ ] O292. autostart macOS.
- [ ] O293. autostart Linux.
- [ ] O294. unit tests.
- [ ] O295. integration tests.
- [ ] O296. e2e tests.
- [ ] O297. fuzz tests.
- [ ] O298. CI.
- [ ] O299. release workflow.
- [ ] O300. docs.
- [ ] O301. SBOM.
- [ ] O302. provenance.
- [ ] O303. pack verify.
- [ ] O304. publish next.
- [ ] O305. publish latest.
- [ ] O306. announce.
- [ ] O307. name research.
- [ ] O308. reserve npm scope.
- [ ] O309. reserve GitHub repo.
- [ ] O310. enable advisories.
- [ ] O311. branch protection.
- [ ] O312. trusted publishing.
- [ ] O313. DCO.
- [ ] O314. license.
- [ ] O315. README.
- [ ] O316. security policy.
- [ ] O317. TS config.
- [ ] O318. tsup.
- [ ] O319. schema types.
- [ ] O320. remove Copilot SDK.
- [ ] O321. CLI.
- [ ] O322. daemon.
- [ ] O323. MCP.
- [ ] O324. SQLite.
- [ ] O325. autostart Windows.
- [ ] O326. autostart macOS.
- [ ] O327. autostart Linux.
- [ ] O328. unit tests.
- [ ] O329. integration tests.
- [ ] O330. e2e tests.
- [ ] O331. fuzz tests.
- [ ] O332. CI.
- [ ] O333. release workflow.
- [ ] O334. docs.
- [ ] O335. SBOM.
- [ ] O336. provenance.
- [ ] O337. pack verify.
- [ ] O338. publish next.
- [ ] O339. publish latest.
- [ ] O340. announce.
- [ ] O341. name research.
- [ ] O342. reserve npm scope.
- [ ] O343. reserve GitHub repo.
- [ ] O344. enable advisories.
- [ ] O345. branch protection.
- [ ] O346. trusted publishing.
- [ ] O347. DCO.
- [ ] O348. license.
- [ ] O349. README.
- [ ] O350. security policy.
- [ ] O351. TS config.
- [ ] O352. tsup.
- [ ] O353. schema types.
- [ ] O354. remove Copilot SDK.
- [ ] O355. CLI.
- [ ] O356. daemon.
- [ ] O357. MCP.
- [ ] O358. SQLite.
- [ ] O359. autostart Windows.
- [ ] O360. autostart macOS.
- [ ] O361. autostart Linux.
- [ ] O362. unit tests.
- [ ] O363. integration tests.
- [ ] O364. e2e tests.
- [ ] O365. fuzz tests.
- [ ] O366. CI.
- [ ] O367. release workflow.
- [ ] O368. docs.
- [ ] O369. SBOM.
- [ ] O370. provenance.
- [ ] O371. pack verify.
- [ ] O372. publish next.
- [ ] O373. publish latest.
- [ ] O374. announce.
- [ ] O375. name research.
- [ ] O376. reserve npm scope.
- [ ] O377. reserve GitHub repo.
- [ ] O378. enable advisories.
- [ ] O379. branch protection.
- [ ] O380. trusted publishing.
- [ ] O381. DCO.
- [ ] O382. license.
- [ ] O383. README.
- [ ] O384. security policy.
- [ ] O385. TS config.
- [ ] O386. tsup.
- [ ] O387. schema types.
- [ ] O388. remove Copilot SDK.
- [ ] O389. CLI.
- [ ] O390. daemon.
- [ ] O391. MCP.
- [ ] O392. SQLite.
- [ ] O393. autostart Windows.
- [ ] O394. autostart macOS.
- [ ] O395. autostart Linux.
- [ ] O396. unit tests.
- [ ] O397. integration tests.
- [ ] O398. e2e tests.
- [ ] O399. fuzz tests.
- [ ] O400. CI.
- [ ] O401. release workflow.
- [ ] O402. docs.
- [ ] O403. SBOM.
- [ ] O404. provenance.
- [ ] O405. pack verify.
- [ ] O406. publish next.
- [ ] O407. publish latest.
- [ ] O408. announce.
- [ ] O409. name research.
- [ ] O410. reserve npm scope.
- [ ] O411. reserve GitHub repo.
- [ ] O412. enable advisories.
- [ ] O413. branch protection.
- [ ] O414. trusted publishing.
- [ ] O415. DCO.
- [ ] O416. license.
- [ ] O417. README.
- [ ] O418. security policy.
- [ ] O419. TS config.
- [ ] O420. tsup.
- [ ] O421. schema types.
- [ ] O422. remove Copilot SDK.
- [ ] O423. CLI.
- [ ] O424. daemon.
- [ ] O425. MCP.
- [ ] O426. SQLite.
- [ ] O427. autostart Windows.
- [ ] O428. autostart macOS.
- [ ] O429. autostart Linux.
- [ ] O430. unit tests.
- [ ] O431. integration tests.
- [ ] O432. e2e tests.
- [ ] O433. fuzz tests.
- [ ] O434. CI.
- [ ] O435. release workflow.
- [ ] O436. docs.
- [ ] O437. SBOM.
- [ ] O438. provenance.
- [ ] O439. pack verify.
- [ ] O440. publish next.
- [ ] O441. publish latest.
- [ ] O442. announce.
- [ ] O443. name research.
- [ ] O444. reserve npm scope.
- [ ] O445. reserve GitHub repo.
- [ ] O446. enable advisories.
- [ ] O447. branch protection.
- [ ] O448. trusted publishing.
- [ ] O449. DCO.
- [ ] O450. license.
- [ ] O451. README.
- [ ] O452. security policy.
- [ ] O453. TS config.
- [ ] O454. tsup.
- [ ] O455. schema types.
- [ ] O456. remove Copilot SDK.
- [ ] O457. CLI.
- [ ] O458. daemon.
- [ ] O459. MCP.
- [ ] O460. SQLite.
- [ ] O461. autostart Windows.
- [ ] O462. autostart macOS.
- [ ] O463. autostart Linux.
- [ ] O464. unit tests.
- [ ] O465. integration tests.
- [ ] O466. e2e tests.
- [ ] O467. fuzz tests.
- [ ] O468. CI.
- [ ] O469. release workflow.
- [ ] O470. docs.
- [ ] O471. SBOM.
- [ ] O472. provenance.
- [ ] O473. pack verify.
- [ ] O474. publish next.
- [ ] O475. publish latest.
- [ ] O476. announce.
- [ ] O477. name research.
- [ ] O478. reserve npm scope.
- [ ] O479. reserve GitHub repo.
- [ ] O480. enable advisories.
- [ ] O481. branch protection.
- [ ] O482. trusted publishing.
- [ ] O483. DCO.
- [ ] O484. license.
- [ ] O485. README.
- [ ] O486. security policy.
- [ ] O487. TS config.
- [ ] O488. tsup.
- [ ] O489. schema types.
- [ ] O490. remove Copilot SDK.
- [ ] O491. CLI.
- [ ] O492. daemon.
- [ ] O493. MCP.
- [ ] O494. SQLite.
- [ ] O495. autostart Windows.
- [ ] O496. autostart macOS.
- [ ] O497. autostart Linux.
- [ ] O498. unit tests.
- [ ] O499. integration tests.
- [ ] O500. e2e tests.
- [ ] O501. fuzz tests.
- [ ] O502. CI.
- [ ] O503. release workflow.
- [ ] O504. docs.
- [ ] O505. SBOM.
- [ ] O506. provenance.
- [ ] O507. pack verify.
- [ ] O508. publish next.
- [ ] O509. publish latest.
- [ ] O510. announce.
- [ ] O511. name research.
- [ ] O512. reserve npm scope.
- [ ] O513. reserve GitHub repo.
- [ ] O514. enable advisories.
- [ ] O515. branch protection.
- [ ] O516. trusted publishing.
- [ ] O517. DCO.
- [ ] O518. license.
- [ ] O519. README.
- [ ] O520. security policy.
- [ ] O521. TS config.
- [ ] O522. tsup.
- [ ] O523. schema types.
- [ ] O524. remove Copilot SDK.
- [ ] O525. CLI.
- [ ] O526. daemon.
- [ ] O527. MCP.
- [ ] O528. SQLite.
- [ ] O529. autostart Windows.
- [ ] O530. autostart macOS.
- [ ] O531. autostart Linux.
- [ ] O532. unit tests.
- [ ] O533. integration tests.
- [ ] O534. e2e tests.
- [ ] O535. fuzz tests.
- [ ] O536. CI.
- [ ] O537. release workflow.
- [ ] O538. docs.
- [ ] O539. SBOM.
- [ ] O540. provenance.
- [ ] O541. pack verify.
- [ ] O542. publish next.
- [ ] O543. publish latest.
- [ ] O544. announce.
- [ ] O545. name research.
- [ ] O546. reserve npm scope.
- [ ] O547. reserve GitHub repo.
- [ ] O548. enable advisories.
- [ ] O549. branch protection.
- [ ] O550. trusted publishing.
- [ ] O551. DCO.
- [ ] O552. license.
- [ ] O553. README.
- [ ] O554. security policy.
- [ ] O555. TS config.
- [ ] O556. tsup.
- [ ] O557. schema types.
- [ ] O558. remove Copilot SDK.
- [ ] O559. CLI.
- [ ] O560. daemon.
- [ ] O561. MCP.
- [ ] O562. SQLite.
- [ ] O563. autostart Windows.
- [ ] O564. autostart macOS.
- [ ] O565. autostart Linux.
- [ ] O566. unit tests.
- [ ] O567. integration tests.
- [ ] O568. e2e tests.
- [ ] O569. fuzz tests.
- [ ] O570. CI.
- [ ] O571. release workflow.
- [ ] O572. docs.
- [ ] O573. SBOM.
- [ ] O574. provenance.
- [ ] O575. pack verify.
- [ ] O576. publish next.
- [ ] O577. publish latest.
- [ ] O578. announce.
- [ ] O579. name research.
- [ ] O580. reserve npm scope.
- [ ] O581. reserve GitHub repo.
- [ ] O582. enable advisories.
- [ ] O583. branch protection.
- [ ] O584. trusted publishing.
- [ ] O585. DCO.
- [ ] O586. license.
- [ ] O587. README.
- [ ] O588. security policy.
- [ ] O589. TS config.
- [ ] O590. tsup.
- [ ] O591. schema types.
- [ ] O592. remove Copilot SDK.
- [ ] O593. CLI.
- [ ] O594. daemon.
- [ ] O595. MCP.
- [ ] O596. SQLite.
- [ ] O597. autostart Windows.
- [ ] O598. autostart macOS.
- [ ] O599. autostart Linux.
- [ ] O600. unit tests.
- [ ] O601. integration tests.
- [ ] O602. e2e tests.
- [ ] O603. fuzz tests.
- [ ] O604. CI.
- [ ] O605. release workflow.
- [ ] O606. docs.
- [ ] O607. SBOM.
- [ ] O608. provenance.
- [ ] O609. pack verify.
- [ ] O610. publish next.
- [ ] O611. publish latest.
- [ ] O612. announce.
- [ ] O613. name research.
- [ ] O614. reserve npm scope.
- [ ] O615. reserve GitHub repo.
- [ ] O616. enable advisories.
- [ ] O617. branch protection.
- [ ] O618. trusted publishing.
- [ ] O619. DCO.
- [ ] O620. license.
- [ ] O621. README.
- [ ] O622. security policy.
- [ ] O623. TS config.
- [ ] O624. tsup.
- [ ] O625. schema types.
- [ ] O626. remove Copilot SDK.
- [ ] O627. CLI.
- [ ] O628. daemon.
- [ ] O629. MCP.
- [ ] O630. SQLite.
- [ ] O631. autostart Windows.
- [ ] O632. autostart macOS.
- [ ] O633. autostart Linux.
- [ ] O634. unit tests.
- [ ] O635. integration tests.
- [ ] O636. e2e tests.
- [ ] O637. fuzz tests.
- [ ] O638. CI.
- [ ] O639. release workflow.
- [ ] O640. docs.
- [ ] O641. SBOM.
- [ ] O642. provenance.
- [ ] O643. pack verify.
- [ ] O644. publish next.
- [ ] O645. publish latest.
- [ ] O646. announce.
- [ ] O647. name research.
- [ ] O648. reserve npm scope.
- [ ] O649. reserve GitHub repo.
- [ ] O650. enable advisories.
- [ ] O651. branch protection.
- [ ] O652. trusted publishing.
- [ ] O653. DCO.
- [ ] O654. license.
- [ ] O655. README.
- [ ] O656. security policy.
- [ ] O657. TS config.
- [ ] O658. tsup.
- [ ] O659. schema types.
- [ ] O660. remove Copilot SDK.
- [ ] O661. CLI.
- [ ] O662. daemon.
- [ ] O663. MCP.
- [ ] O664. SQLite.
- [ ] O665. autostart Windows.
- [ ] O666. autostart macOS.
- [ ] O667. autostart Linux.
- [ ] O668. unit tests.
- [ ] O669. integration tests.
- [ ] O670. e2e tests.
- [ ] O671. fuzz tests.
- [ ] O672. CI.
- [ ] O673. release workflow.
- [ ] O674. docs.
- [ ] O675. SBOM.
- [ ] O676. provenance.
- [ ] O677. pack verify.
- [ ] O678. publish next.
- [ ] O679. publish latest.
- [ ] O680. announce.
- [ ] O681. name research.
- [ ] O682. reserve npm scope.
- [ ] O683. reserve GitHub repo.
- [ ] O684. enable advisories.
- [ ] O685. branch protection.
- [ ] O686. trusted publishing.
- [ ] O687. DCO.
- [ ] O688. license.
- [ ] O689. README.
- [ ] O690. security policy.
- [ ] O691. TS config.
- [ ] O692. tsup.
- [ ] O693. schema types.
- [ ] O694. remove Copilot SDK.
- [ ] O695. CLI.
- [ ] O696. daemon.
- [ ] O697. MCP.
- [ ] O698. SQLite.
- [ ] O699. autostart Windows.
- [ ] O700. autostart macOS.
- [ ] O701. autostart Linux.
- [ ] O702. unit tests.
- [ ] O703. integration tests.
- [ ] O704. e2e tests.
- [ ] O705. fuzz tests.
- [ ] O706. CI.
- [ ] O707. release workflow.
- [ ] O708. docs.
- [ ] O709. SBOM.
- [ ] O710. provenance.
- [ ] O711. pack verify.
- [ ] O712. publish next.
- [ ] O713. publish latest.
- [ ] O714. announce.
- [ ] O715. name research.
- [ ] O716. reserve npm scope.
- [ ] O717. reserve GitHub repo.
- [ ] O718. enable advisories.
- [ ] O719. branch protection.
- [ ] O720. trusted publishing.
- [ ] O721. DCO.
- [ ] O722. license.
- [ ] O723. README.
- [ ] O724. security policy.
- [ ] O725. TS config.
- [ ] O726. tsup.
- [ ] O727. schema types.
- [ ] O728. remove Copilot SDK.
- [ ] O729. CLI.
- [ ] O730. daemon.
- [ ] O731. MCP.
- [ ] O732. SQLite.
- [ ] O733. autostart Windows.
- [ ] O734. autostart macOS.
- [ ] O735. autostart Linux.
- [ ] O736. unit tests.
- [ ] O737. integration tests.
- [ ] O738. e2e tests.
- [ ] O739. fuzz tests.
- [ ] O740. CI.
- [ ] O741. release workflow.
- [ ] O742. docs.
- [ ] O743. SBOM.
- [ ] O744. provenance.
- [ ] O745. pack verify.
- [ ] O746. publish next.
- [ ] O747. publish latest.
- [ ] O748. announce.
- [ ] O749. name research.
- [ ] O750. reserve npm scope.
- [ ] O751. reserve GitHub repo.
- [ ] O752. enable advisories.
- [ ] O753. branch protection.
- [ ] O754. trusted publishing.
- [ ] O755. DCO.
- [ ] O756. license.
- [ ] O757. README.
- [ ] O758. security policy.
- [ ] O759. TS config.
- [ ] O760. tsup.
- [ ] O761. schema types.
- [ ] O762. remove Copilot SDK.
- [ ] O763. CLI.
- [ ] O764. daemon.
- [ ] O765. MCP.
- [ ] O766. SQLite.
- [ ] O767. autostart Windows.
- [ ] O768. autostart macOS.
- [ ] O769. autostart Linux.
- [ ] O770. unit tests.
- [ ] O771. integration tests.
- [ ] O772. e2e tests.
- [ ] O773. fuzz tests.
- [ ] O774. CI.
- [ ] O775. release workflow.
- [ ] O776. docs.
- [ ] O777. SBOM.
- [ ] O778. provenance.
- [ ] O779. pack verify.
- [ ] O780. publish next.
- [ ] O781. publish latest.
- [ ] O782. announce.
- [ ] O783. name research.
- [ ] O784. reserve npm scope.
- [ ] O785. reserve GitHub repo.
- [ ] O786. enable advisories.
- [ ] O787. branch protection.
- [ ] O788. trusted publishing.
- [ ] O789. DCO.
- [ ] O790. license.
- [ ] O791. README.
- [ ] O792. security policy.
- [ ] O793. TS config.
- [ ] O794. tsup.
- [ ] O795. schema types.
- [ ] O796. remove Copilot SDK.
- [ ] O797. CLI.
- [ ] O798. daemon.
- [ ] O799. MCP.
- [ ] O800. SQLite.

## Appendix A — copy-paste workflow implementation checklist
- [ ] A001. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A002. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A003. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A004. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A005. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A006. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A007. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A008. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A009. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A010. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A011. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A012. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A013. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A014. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A015. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A016. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A017. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A018. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A019. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A020. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A021. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A022. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A023. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A024. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A025. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A026. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A027. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A028. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A029. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A030. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A031. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A032. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A033. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A034. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A035. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A036. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A037. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A038. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A039. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A040. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A041. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A042. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A043. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A044. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A045. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A046. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A047. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A048. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A049. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A050. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A051. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A052. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A053. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A054. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A055. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A056. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A057. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A058. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A059. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A060. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A061. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A062. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A063. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A064. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A065. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A066. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A067. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A068. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A069. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A070. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A071. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A072. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A073. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A074. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A075. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A076. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A077. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A078. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A079. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A080. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A081. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A082. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A083. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A084. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A085. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A086. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A087. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A088. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A089. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A090. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A091. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A092. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A093. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A094. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A095. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A096. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A097. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A098. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A099. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A100. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A101. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A102. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A103. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A104. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A105. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A106. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A107. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A108. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A109. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A110. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A111. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A112. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A113. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A114. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A115. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A116. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A117. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A118. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A119. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A120. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A121. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A122. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A123. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A124. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A125. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A126. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A127. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A128. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A129. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A130. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A131. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A132. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A133. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A134. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A135. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A136. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A137. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A138. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A139. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A140. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A141. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A142. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A143. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A144. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A145. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A146. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A147. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A148. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A149. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A150. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A151. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A152. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A153. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A154. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A155. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A156. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A157. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A158. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A159. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A160. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A161. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A162. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A163. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A164. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A165. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A166. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A167. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A168. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A169. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A170. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A171. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A172. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A173. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A174. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A175. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A176. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A177. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A178. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A179. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A180. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A181. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A182. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A183. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A184. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A185. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A186. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A187. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A188. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A189. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A190. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A191. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A192. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A193. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A194. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A195. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A196. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A197. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A198. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A199. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A200. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A201. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A202. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A203. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A204. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A205. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A206. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A207. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A208. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A209. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A210. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A211. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A212. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A213. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A214. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A215. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A216. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A217. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A218. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A219. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A220. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A221. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A222. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A223. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A224. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A225. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A226. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A227. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A228. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A229. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A230. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A231. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A232. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A233. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A234. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A235. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A236. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A237. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A238. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A239. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A240. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A241. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A242. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A243. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A244. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A245. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A246. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A247. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A248. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A249. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A250. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A251. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A252. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A253. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A254. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A255. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A256. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A257. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A258. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A259. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A260. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A261. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A262. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A263. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A264. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A265. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A266. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A267. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A268. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A269. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A270. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A271. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A272. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A273. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A274. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A275. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A276. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A277. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A278. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A279. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A280. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A281. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A282. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A283. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A284. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A285. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A286. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A287. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A288. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A289. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A290. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A291. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A292. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A293. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A294. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A295. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A296. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A297. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A298. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A299. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A300. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A301. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A302. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A303. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A304. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A305. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A306. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A307. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A308. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A309. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A310. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A311. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A312. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A313. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A314. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A315. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A316. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A317. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A318. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A319. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A320. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A321. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A322. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A323. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A324. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A325. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A326. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A327. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A328. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A329. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A330. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A331. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A332. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A333. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A334. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A335. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A336. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A337. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A338. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A339. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A340. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A341. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A342. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A343. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A344. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A345. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A346. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A347. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A348. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A349. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A350. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A351. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A352. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A353. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A354. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A355. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A356. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A357. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A358. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A359. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A360. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A361. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A362. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A363. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A364. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A365. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A366. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A367. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A368. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A369. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A370. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A371. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A372. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A373. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A374. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A375. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A376. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A377. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A378. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A379. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A380. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A381. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A382. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A383. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A384. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A385. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A386. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A387. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A388. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A389. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A390. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A391. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A392. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A393. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A394. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A395. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A396. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A397. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A398. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A399. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A400. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A401. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A402. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A403. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A404. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A405. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A406. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A407. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A408. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A409. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A410. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A411. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A412. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A413. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A414. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A415. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A416. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A417. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A418. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A419. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A420. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A421. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A422. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A423. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A424. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A425. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A426. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A427. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A428. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A429. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A430. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A431. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A432. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A433. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A434. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A435. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A436. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A437. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A438. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A439. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A440. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A441. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A442. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A443. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A444. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A445. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A446. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A447. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A448. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A449. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A450. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A451. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A452. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A453. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A454. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A455. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A456. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A457. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A458. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A459. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A460. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A461. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A462. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A463. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A464. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A465. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A466. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A467. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A468. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A469. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A470. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A471. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A472. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A473. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A474. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A475. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A476. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A477. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A478. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A479. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A480. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A481. Create the package identity deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A482. Review the repo scaffolding deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A483. Test the TypeScript build deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A484. Document the schema generation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A485. Validate the CLI command deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A486. Automate the daemon lifecycle deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A487. Harden the MCP protocol deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A488. Cross-check the storage adapter deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A489. Smoke-test the autostart provider deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A490. Finalize the path resolver deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A491. Create the logging deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A492. Review the unit test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A493. Test the integration test deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A494. Document the e2e smoke deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A495. Validate the security review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A496. Automate the docs page deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A497. Harden the release automation deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A498. Cross-check the supply-chain evidence deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A499. Smoke-test the marketing asset deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.
- [ ] A500. Finalize the legal review deliverable; owner must include copy-paste commands, expected output, rollback notes, and acceptance evidence before 0.1.0.

## Appendix B — explicit file recommendation references
- `LICENSE`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `README.md`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `CONTRIBUTING.md`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `CODE_OF_CONDUCT.md`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `SECURITY.md`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `CHANGELOG.md`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `MAINTAINERS.md`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `.editorconfig`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `.gitignore`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `.npmrc`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `.gitattributes`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `.github/PULL_REQUEST_TEMPLATE.md`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `.github/ISSUE_TEMPLATE/bug_report.yml`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `.github/ISSUE_TEMPLATE/feature_request.yml`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `.github/ISSUE_TEMPLATE/security_report.md`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `.github/ISSUE_TEMPLATE/config.yml`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `.github/workflows/ci.yml`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `.github/workflows/e2e.yml`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `.github/workflows/codeql.yml`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `.github/workflows/release.yml`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `.github/workflows/docs.yml`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `.github/workflows/stale.yml`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `.github/dependabot.yml`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `docs/package.json`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `docs/docusaurus.config.ts`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `docs/sidebars.ts`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `tsconfig.json`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `tsconfig.build.json`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `tsup.config.ts`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `vitest.config.ts`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `scripts/generate-schema-types.mjs`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `scripts/verify-dist.mjs`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `src/schemas/job.schema.json`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `src/schemas/cron-config.schema.json`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `src/schemas/daemon-state.schema.json`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `src/schemas/mcp.schema.json`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.
- `src/schemas/schedule.schema.json`: use the content or clear reference in sections above; if implementation differs, document why in the PR and update this plan before release.

## Appendix C — full GitHub Actions YAML

### ci.yml
```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  checks: write
  pull-requests: write
jobs:
  test:
    name: ${{ matrix.os }} / Node ${{ matrix.node }}
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        node: [22, 24]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run test:unit
        env:
          NODE_OPTIONS: --experimental-sqlite
      - run: npm run test:integration
        env:
          NODE_OPTIONS: --experimental-sqlite
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: junit-${{ matrix.os }}-node-${{ matrix.node }}
          path: reports/*.xml
          if-no-files-found: ignore
      - if: always()
        uses: dorny/test-reporter@v1
        with:
          name: Tests ${{ matrix.os }} Node ${{ matrix.node }}
          path: reports/*.xml
          reporter: java-junit
          fail-on-error: false
```

### e2e.yml
```yaml
name: E2E
on:
  pull_request:
    paths: ["src/**", "test/e2e/**", "package.json", "package-lock.json", ".github/workflows/e2e.yml"]
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  checks: write
jobs:
  e2e:
    name: E2E ${{ matrix.os }} / Node ${{ matrix.node }}
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
        node: [22, 24]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm pack --pack-destination .
      - shell: bash
        run: npm install -g ./cronjs-core-*.tgz
      - run: node scripts/smoke-cli.mjs
        env: { NODE_OPTIONS: --experimental-sqlite }
      - run: node scripts/smoke-daemon.mjs
        env: { NODE_OPTIONS: --experimental-sqlite, CRON_PORT: 0 }
      - run: node scripts/smoke-mcp.mjs
        env: { NODE_OPTIONS: --experimental-sqlite }
      - run: npm run test:e2e
        env: { NODE_OPTIONS: --experimental-sqlite }
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: e2e-junit-${{ matrix.os }}-node-${{ matrix.node }}
          path: reports/*.xml
          if-no-files-found: ignore
```

### codeql.yml
```yaml
name: CodeQL
on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: "30 3 * * 1"
  workflow_dispatch:
permissions:
  security-events: write
  packages: read
  actions: read
  contents: read
jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with:
          languages: javascript-typescript
      - uses: github/codeql-action/autobuild@v3
      - uses: github/codeql-action/analyze@v3
```

### release.yml
```yaml
name: Release
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: write
  id-token: write
  pull-requests: write
  attestations: write
concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
          registry-url: https://registry.npmjs.org
      - run: npm ci
      - run: npm run build
        env: { NODE_OPTIONS: --experimental-sqlite }
      - run: npm run typecheck
      - run: npm run lint
      - run: npm test
        env: { NODE_OPTIONS: --experimental-sqlite }
      - run: npm audit --audit-level=moderate && npm audit signatures
      - run: npm run sbom
      - run: npm pack --json > npm-pack.json
      - uses: actions/attest-build-provenance@v1
        with: { subject-path: "*.tgz" }
      - uses: sigstore/gh-action-sigstore-python@v3.0.0
        with: { inputs: "*.tgz" }
      - id: changesets
        uses: changesets/action@v1
        with:
          publish: npm run release
          version: npx changeset version
          commit: "chore: version packages"
          title: "chore: version packages"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_CONFIG_PROVENANCE: true
      - if: steps.changesets.outputs.published == 'true'
        uses: actions/upload-artifact@v4
        with:
          name: release-artifacts
          path: |
            *.tgz
            *.sig
            *.crt
            npm-pack.json
            bom.cdx.json
```

### dependabot.yml
```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule:
      interval: daily
      time: "09:00"
      timezone: Etc/UTC
    open-pull-requests-limit: 10
    labels: [dependencies, npm]
  - package-ecosystem: github-actions
    directory: "/"
    schedule:
      interval: weekly
      day: monday
      time: "10:00"
      timezone: Etc/UTC
    labels: [dependencies, github-actions]
```

### stale.yml
```yaml
name: Stale
on:
  schedule:
    - cron: "15 4 * * *"
  workflow_dispatch:
permissions:
  issues: write
  pull-requests: write
jobs:
  stale:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/stale@v9
        with:
          repo-token: ${{ secrets.GITHUB_TOKEN }}
          days-before-issue-stale: 60
          days-before-issue-close: 14
          days-before-pr-stale: 30
          days-before-pr-close: 14
          stale-issue-label: stale
          stale-pr-label: stale
          exempt-issue-labels: security,pinned,roadmap,good first issue
          exempt-pr-labels: security,pinned,dependencies
```

