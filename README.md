# REAPER — Dependency Bloat & Dead-Code CLI

Static reachability engine for JS/TS repos. Finds what ESLint can't: orphan files, dead exports, ghost dependencies.

## Why this solves a real problem

JS/TS repos accumulate `export function ...` that nothing imports, `src/` files nothing reaches, and `package.json` deps with 0 imports. This bloats bundles, slows CI, widens security surface.

`npx reaper scan` builds a BFS dependency graph from entry points via AST (`ts-morph`), then reports `AllFiles - Visited`.

## Working model (v0.1.0)

- `reaper scan` — orphan files + dead exports + unused deps, `--json` / `--ci` for GitHub Actions
- `reaper prune --dry-run` — preview AST cleanup, `--safe-prune` runs `npm test` + `git checkout .` revert
- Framework-aware: Next.js `app/**/page.tsx`, `pages/**`, `.reaperrc.json` entries
- Tested with `vitest` fixture repo

## Run

```powershell
npm install; if ($?) { npm run build }
node dist/index.js scan
node dist/index.js scan --json
npx vitest run
```

## Example

```
⚡ Reaper scanned 142 files in 0.84s
📁 ORPHANED FILES
 ✖ src/components/OldCheckoutModal.tsx
🔌 UNUSED EXPORTS
 ✖ src/utils/math.ts -> formatCurrency (line 42)
📦 UNUSED NPM PACKAGES
 ✖ axios (0 imports)
```

## Placement notes

Stack: TypeScript strict, `ts-morph`, `fast-glob`, `commander`, `ora`, `picocolors`, `vitest`. See `src/scan.ts:1`, `src/index.ts:1`, `tests/scan.test.ts:1`.
