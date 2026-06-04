# nodehomematic — Fase 0: Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Creare lo scheletro del pacchetto npm `nodehomematic` (TypeScript strict, build, test, lint, CI, licenza, README) e il repository GitHub `apocaliss92/nodehomematic`, con una toolchain verde end-to-end.

**Architecture:** Pacchetto npm singolo. TypeScript strict compilato in ESM+CJS via `tsup`. Test con `vitest`. Lint con ESLint flat config + `typescript-eslint` + Prettier. CI su GitHub Actions. La struttura cartelle (`transport/`, `central/`, `model/`, `api/`, `support/`) viene creata come stub vuoti con un `index.ts` pubblico minimale, così le fasi successive vi si innestano.

**Tech Stack:** Node 20+ (dev su 22), TypeScript 5, tsup, vitest, ESLint 9 (flat config), typescript-eslint, Prettier, GitHub Actions.

**Working dir:** `/Users/gianlucaruocco/Documents/Git/nodehomematic` (git già inizializzato, branch `main`; contiene già `docs/` e `.gitignore`).

---

### Task 1: package.json

**Files:**
- Create: `package.json`

- [ ] **Step 1: Scrivere `package.json`**

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

- [ ] **Step 2: Installare le dipendenze**

Run: `cd /Users/gianlucaruocco/Documents/Git/nodehomematic && npm install`
Expected: crea `node_modules/` e `package-lock.json` senza errori (warning di peer-deps tollerati).

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: package.json e dipendenze di base"
```

---

### Task 2: tsconfig.json

**Files:**
- Create: `tsconfig.json`

- [ ] **Step 1: Scrivere `tsconfig.json`**

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

- [ ] **Step 2: Verificare che `tsc` non trovi errori su progetto vuoto**

Run: `npx tsc --noEmit`
Expected: nessun output di errore (il src è ancora vuoto; aggiungiamo i file nei task successivi). Exit code 0. Se `src` è vuoto e `tsc` lamenta "No inputs were found", è atteso fino al Task 4 — proseguire.

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

- [ ] **Step 1: Scrivere `tsup.config.ts`**

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

- [ ] **Step 2: Scrivere `vitest.config.ts`**

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
git commit -m "chore: config tsup (ESM+CJS) e vitest (coverage 80%)"
```

---

### Task 4: Struttura src + entrypoint pubblico + primo modulo testabile

**Files:**
- Create: `src/index.ts`
- Create: `src/support/version.ts`
- Create: `src/transport/.gitkeep`, `src/central/.gitkeep`, `src/model/.gitkeep`, `src/api/.gitkeep`
- Test: `tests/unit/version.test.ts`

- [ ] **Step 1: Scrivere il test che fallisce**

`tests/unit/version.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { LIBRARY_NAME, isSupportedNodeVersion } from '../../src/support/version.js';

describe('support/version', () => {
  it('espone il nome libreria', () => {
    expect(LIBRARY_NAME).toBe('nodehomematic');
  });

  it('accetta Node >= 20', () => {
    expect(isSupportedNodeVersion('v20.0.0')).toBe(true);
    expect(isSupportedNodeVersion('v22.19.0')).toBe(true);
  });

  it('rifiuta Node < 20', () => {
    expect(isSupportedNodeVersion('v18.20.0')).toBe(false);
  });
});
```

- [ ] **Step 2: Eseguire il test per vederlo fallire**

Run: `npx vitest run tests/unit/version.test.ts`
Expected: FAIL — `Cannot find module '../../src/support/version.js'`.

- [ ] **Step 3: Implementare il modulo minimo**

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

- [ ] **Step 4: Creare l'entrypoint pubblico e gli stub di cartella**

`src/index.ts`:
```ts
// Public API surface. In the current phase only metadata is exported;
// the Homematic facade lands in Phase 3 (api/).
export { LIBRARY_NAME } from './support/version.js';
```

Creare i marker delle cartelle a strati (verranno popolate nelle fasi successive):
```bash
mkdir -p src/transport src/central src/model src/api
touch src/transport/.gitkeep src/central/.gitkeep src/model/.gitkeep src/api/.gitkeep
```

- [ ] **Step 5: Eseguire test, typecheck e build**

Run: `npx vitest run tests/unit/version.test.ts`
Expected: PASS (3 test verdi).

Run: `npx tsc --noEmit`
Expected: nessun errore.

Run: `npm run build`
Expected: genera `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts` senza errori.

- [ ] **Step 6: Commit**

```bash
git add src tests
git commit -m "feat: scaffold src a strati + modulo version con test"
```

---

### Task 5: ESLint flat config + Prettier

**Files:**
- Create: `eslint.config.js`
- Create: `.prettierrc.json`
- Create: `.prettierignore`

- [ ] **Step 1: Scrivere `.prettierrc.json`**

```json
{
  "singleQuote": true,
  "semi": true,
  "trailingComma": "all",
  "printWidth": 100
}
```

- [ ] **Step 2: Scrivere `.prettierignore`**

```
dist
node_modules
coverage
```

- [ ] **Step 3: Scrivere `eslint.config.js`**

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

- [ ] **Step 4: Eseguire lint e format check**

Run: `npm run lint`
Expected: nessun errore (0 problemi) sui file `src/` esistenti.

Run: `npm run format:check`
Expected: tutti i file formattati correttamente; se segnala differenze, eseguire `npm run format` e ricontrollare.

- [ ] **Step 5: Commit**

```bash
git add eslint.config.js .prettierrc.json .prettierignore
git commit -m "chore: ESLint flat config type-checked + Prettier"
```

---

### Task 6: LICENSE (MIT, copyright preservato)

**Files:**
- Create: `LICENSE`

- [ ] **Step 1: Scrivere `LICENSE` MIT mantenendo il copyright originale del progetto sorgente**

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
git commit -m "docs: licenza MIT (copyright aiohomematic preservato + porting)"
```

---

### Task 7: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Scrivere `README.md`**

```markdown
# nodehomematic

Porting Node.js/TypeScript di [aiohomematic](https://github.com/sukramj/aiohomematic) — libreria asincrona per controllare e monitorare dispositivi Homematic / HomematicIP tramite **CCU3 / RaspberryMatic / OpenCCU**.

> ⚠️ **Stato:** in sviluppo attivo (0.x). API in evoluzione fino alla 1.0.

## Caratteristiche (roadmap)

- Connessione XML-RPC alle interfacce CCU (BidCos-RF, HmIP-RF, ...)
- Client JSON-RPC verso la WebUI CCU (nomi, stanze, programmi, system variables)
- Callback server per ricezione push degli eventi dalla CCU
- Riconnessione automatica rock-solid (health-ping + re-init + re-sync)
- Discovery automatica di device, canali e data point + cache persistente
- API pubblica agnostica event-driven: stream globale `valueChanged` + `setValue`
- Tipi custom (light, switch, cover, climate, lock, ...) — incrementali

## Requisiti

- Node.js >= 20

## Installazione

```bash
npm install nodehomematic
```

## Uso (anteprima API target)

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

> Nota: la facade `Homematic` arriva nella Fase 3. Vedi `docs/superpowers/specs/` per il design.

## Licenza

MIT — porting di aiohomematic (copyright originale SukramJ, Daniel Perna preservato). Vedi `LICENSE`.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README iniziale"
```

---

### Task 8: CI GitHub Actions

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Scrivere `.github/workflows/ci.yml`**

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

- [ ] **Step 2: Verificare localmente l'intera pipeline**

Run: `npm run lint && npm run format:check && npm run typecheck && npm run test:cov && npm run build`
Expected: tutti i passi verdi; coverage >= 80% (al momento un solo modulo coperto al 100%).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: pipeline GitHub Actions (lint, typecheck, test, build) su Node 20/22"
```

---

### Task 9: Creare il repository GitHub e push

**Files:** nessuno (operazione remota).

- [ ] **Step 1: Creare il repo remoto e fare push del branch main**

> Azione outward-facing: crea un repository pubblico sull'account `apocaliss92`. Confermare prima di eseguire.

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
Expected: il repo viene creato e il branch `main` viene pushato; `gh` stampa l'URL del repository.

- [ ] **Step 2: Verificare il remoto e lo stato CI**

Run: `gh repo view apocaliss92/nodehomematic --web` (apre il browser) oppure `gh run list --repo apocaliss92/nodehomematic --limit 1`
Expected: il repository esiste; il workflow CI parte sul push e diventa verde.

---

## Self-Review

**Spec coverage (Fase 0 dello spec §8):** repo GitHub (Task 9), TS strict (Task 2), tsup (Task 3), vitest (Task 3+4), eslint+prettier (Task 5), CI Actions (Task 8), README (Task 7), LICENSE MIT con copyright preservato (Task 6, §9 spec), struttura cartelle a strati (Task 4). ✅ Tutte le voci della Fase 0 sono coperte.

**Placeholder scan:** nessun "TBD/TODO"; ogni step ha contenuto reale (config/codice completi). ✅

**Type consistency:** `LIBRARY_NAME` e `isSupportedNodeVersion` definiti nel Task 4 e usati coerentemente nel test e in `index.ts`. ✅

**Note:** le cartelle a strati sono create come `.gitkeep` vuote; verranno popolate dalle fasi 1–5, ognuna con il proprio piano spec→plan.
