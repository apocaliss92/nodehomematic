# nodehomematic — Phase 0: Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the skeleton of the `nodehomematic` npm package (strict TypeScript, build, test, lint, CI, license, README) and the GitHub repository `apocaliss92/nodehomematic`, with a green end-to-end toolchain.

**Architecture:** Single npm package. Strict TypeScript compiled to ESM+CJS via `tsup`. Tests with `vitest`. Lint with ESLint flat config + `typescript-eslint` + Prettier. CI on GitHub Actions. The folder structure (`transport/`, `central/`, `model/`, `api/`, `support/`) is created as empty stubs with a minimal public `index.ts`, so that the later phases plug into it.

**Tech Stack:** Node 20+ (dev su 22), TypeScript 5, tsup, vitest, ESLint 9 (flat config), typescript-eslint, Prettier, GitHub Actions.

**Working dir:** `/Users/gianlucaruocco/Documents/Git/nodehomematic` (git already initialized, branch `main`; already contains `docs/` and `.gitignore`).

---

### Task 1: package.json

**Files:**
- Create: `package.json`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "nodehomematic",
  "version": "0.0.0",
  "description": "Node.js/TypeScript port of aiohomematic — async library for Homematic/HomematicIP via CCU3/RaspberryMatic",
  "license": "MIT",
  "author": "apocaliss92",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=20" },
  "repository": { "type": "git", "url": "git+https://github.com/apocaliss92/nodehomematic.git" },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:cov": "vitest run --coverage",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "keywords": ["homematic", "homematicip", "ccu3", "raspberrymatic", "home-automation", "xml-rpc"],
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@vitest/coverage-v8": "^2.1.0",
    "eslint": "^9.0.0",
    "prettier": "^3.3.0",
    "tsup": "^8.3.0",
    "typescript": "^5.6.0",
    "typescript-eslint": "^8.0.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Install the dependencies**

Run: `cd /Users/gianlucaruocco/Documents/Git/nodehomematic && npm install`
Expected: creates `node_modules/` and `package-lock.json` without errors (peer-deps warnings tolerated).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: package.json and base dependencies"
```

---

### Task 2: tsconfig.json

**Files:**
- Create: `tsconfig.json`

- [ ] **Step 1: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "verbatimModuleSyntax": true,
    "declaration": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 2: Verify that `tsc` finds no errors on an empty project**

Run: `npx tsc --noEmit`
Expected: no error output (src is still empty; we add the files in the later tasks). Exit code 0. If `src` is empty and `tsc` complains "No inputs were found", that is expected until Task 4 — proceed.

- [ ] **Step 3: Commit**

```bash
git add tsconfig.json
git commit -m "chore: tsconfig strict (NodeNext, noUncheckedIndexedAccess)"
```

---

### Task 3: tsup + vitest config

**Files:**
- Create: `tsup.config.ts`
- Create: `vitest.config.ts`

- [ ] **Step 1: Write `tsup.config.ts`**

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
```

- [ ] **Step 2: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts'],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
```

- [ ] **Step 3: Commit**

```bash
git add tsup.config.ts vitest.config.ts
git commit -m "chore: tsup config (ESM+CJS) and vitest (80% coverage)"
```

---

### Task 4: src structure + public entrypoint + first testable module

**Files:**
- Create: `src/index.ts`
- Create: `src/support/version.ts`
- Create: `src/transport/.gitkeep`, `src/central/.gitkeep`, `src/model/.gitkeep`, `src/api/.gitkeep`
- Test: `tests/unit/version.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/unit/version.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { LIBRARY_NAME, isSupportedNodeVersion } from '../../src/support/version.js';

describe('support/version', () => {
  it('exposes the library name', () => {
    expect(LIBRARY_NAME).toBe('nodehomematic');
  });

  it('accepts Node >= 20', () => {
    expect(isSupportedNodeVersion('v20.0.0')).toBe(true);
    expect(isSupportedNodeVersion('v22.19.0')).toBe(true);
  });

  it('rejects Node < 20', () => {
    expect(isSupportedNodeVersion('v18.20.0')).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx vitest run tests/unit/version.test.ts`
Expected: FAIL — `Cannot find module '../../src/support/version.js'`.

- [ ] **Step 3: Implement the minimal module**

`src/support/version.ts`:
```ts
export const LIBRARY_NAME = 'nodehomematic' as const;

const MIN_MAJOR = 20;

export function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\./.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  return Number.isInteger(major) && major >= MIN_MAJOR;
}
```

- [ ] **Step 4: Create the public entrypoint and the folder stubs**

`src/index.ts`:
```ts
// Public API surface. In the current phase only metadata is exported;
// the Homematic facade lands in Phase 3 (api/).
export { LIBRARY_NAME } from './support/version.js';
```

Create the markers for the layered folders (they will be populated in the later phases):
```bash
mkdir -p src/transport src/central src/model src/api
touch src/transport/.gitkeep src/central/.gitkeep src/model/.gitkeep src/api/.gitkeep
```

- [ ] **Step 5: Run test, typecheck and build**

Run: `npx vitest run tests/unit/version.test.ts`
Expected: PASS (3 green tests).

Run: `npx tsc --noEmit`
Expected: no errors.

Run: `npm run build`
Expected: generates `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts` without errors.

- [ ] **Step 6: Commit**

```bash
git add src tests
git commit -m "feat: layered src scaffold + version module with tests"
```

---

### Task 5: ESLint flat config + Prettier

**Files:**
- Create: `eslint.config.js`
- Create: `.prettierrc.json`
- Create: `.prettierignore`

- [ ] **Step 1: Write `.prettierrc.json`**

```json
{
  "singleQuote": true,
  "semi": true,
  "trailingComma": "all",
  "printWidth": 100
}
```

- [ ] **Step 2: Write `.prettierignore`**

```
dist
node_modules
coverage
```

- [ ] **Step 3: Write `eslint.config.js`**

```js
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': 'warn',
    },
  },
  {
    files: ['tests/**/*.ts', '*.config.ts', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
);
```

- [ ] **Step 4: Run lint and format check**

Run: `npm run lint`
Expected: no errors (0 problems) on the existing `src/` files.

Run: `npm run format:check`
Expected: all files formatted correctly; if it reports differences, run `npm run format` and re-check.

- [ ] **Step 5: Commit**

```bash
git add eslint.config.js .prettierrc.json .prettierignore
git commit -m "chore: ESLint flat config type-checked + Prettier"
```

---

### Task 6: LICENSE (MIT, copyright preserved)

**Files:**
- Create: `LICENSE`

- [ ] **Step 1: Write the MIT `LICENSE` keeping the original copyright of the source project**

```
MIT License

Copyright (c) 2021-2026 SukramJ, Daniel Perna (original aiohomematic project)
Copyright (c) 2026 apocaliss92 (nodehomematic Node.js port)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Commit**

```bash
git add LICENSE
git commit -m "docs: MIT license (aiohomematic copyright preserved + port)"
```

---

### Task 7: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

```markdown
# nodehomematic

Node.js/TypeScript port of [aiohomematic](https://github.com/sukramj/aiohomematic) — an asynchronous library to control and monitor Homematic / HomematicIP devices via **CCU3 / RaspberryMatic / OpenCCU**.

> ⚠️ **Status:** under active development (0.x). API evolving until 1.0.

## Features (roadmap)

- XML-RPC connection to the CCU interfaces (BidCos-RF, HmIP-RF, ...)
- JSON-RPC client to the CCU WebUI (names, rooms, programs, system variables)
- Callback server to receive event push notifications from the CCU
- Rock-solid automatic reconnection (health-ping + re-init + re-sync)
- Automatic discovery of devices, channels and data points + persistent cache
- Event-driven, system-agnostic public API: global `valueChanged` stream + `setValue`
- Custom types (light, switch, cover, climate, lock, ...) — incremental

## Requirements

- Node.js >= 20

## Installation

```bash
npm install nodehomematic
```

## Usage (target API preview)

```ts
import { Homematic } from 'nodehomematic';

const hm = new Homematic({
  host: '192.168.1.10',
  interfaces: ['HmIP-RF', 'BidCos-RF'],
  credentials: { username: 'Admin', password: '...' },
  callback: { host: '192.168.1.50', port: 9123 },
});

hm.on('valueChanged', (e) => console.log(e.dpId, e.value));
await hm.start();
```

> Note: the `Homematic` facade arrives in Phase 3. See `docs/superpowers/specs/` for the design.

## Licenza

MIT — port of aiohomematic (original copyright SukramJ, Daniel Perna preserved). See `LICENSE`.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: initial README"
```

---

### Task 8: CI GitHub Actions

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [20.x, 22.x]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run format:check
      - run: npm run typecheck
      - run: npm run test:cov
      - run: npm run build
```

- [ ] **Step 2: Verify the whole pipeline locally**

Run: `npm run lint && npm run format:check && npm run typecheck && npm run test:cov && npm run build`
Expected: all steps green; coverage >= 80% (currently a single module covered at 100%).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: GitHub Actions pipeline (lint, typecheck, test, build) on Node 20/22"
```

---

### Task 9: Create the GitHub repository and push

**Files:** none (remote operation).

- [ ] **Step 1: Create the remote repo and push the main branch**

> Outward-facing action: creates a public repository on the `apocaliss92` account. Confirm before running.

Run:
```bash
cd /Users/gianlucaruocco/Documents/Git/nodehomematic
gh repo create apocaliss92/nodehomematic \
  --public \
  --source=. \
  --remote=origin \
  --description "Node.js/TypeScript port of aiohomematic (Homematic/HomematicIP via CCU3/RaspberryMatic)" \
  --push
```
Expected: the repo is created and the `main` branch is pushed; `gh` prints the repository URL.

- [ ] **Step 2: Verify the remote and the CI status**

Run: `gh repo view apocaliss92/nodehomematic --web` (apre il browser) oppure `gh run list --repo apocaliss92/nodehomematic --limit 1`
Expected: the repository exists; the CI workflow starts on push and turns green.

---

## Self-Review

**Spec coverage (Phase 0 of the spec §8):** GitHub repo (Task 9), strict TS (Task 2), tsup (Task 3), vitest (Task 3+4), eslint+prettier (Task 5), CI Actions (Task 8), README (Task 7), MIT LICENSE with preserved copyright (Task 6, spec §9), layered folder structure (Task 4). ✅ All Phase 0 items are covered.

**Placeholder scan:** no "TBD/TODO"; every step has real content (complete config/code). ✅

**Type consistency:** `LIBRARY_NAME` and `isSupportedNodeVersion` defined in Task 4 and used consistently in the test and in `index.ts`. ✅

**Note:** the layered folders are created as empty `.gitkeep`; they will be populated by phases 1–5, each with its own spec→plan.
