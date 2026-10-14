import fg from "fast-glob";
import * as fs from "node:fs";
import * as path from "node:path";
import { Project, SourceFile } from "ts-morph";

export interface ScanResult {
  totalFiles: number;
  orphanedFiles: string[];
  deadExports: { file: string; name: string; line: number }[];
  unusedDeps: string[];
}

const SRC_GLOB = "src/**/*.{ts,tsx,js,jsx}";
const HEAVY_MAP: Record<string, string> = {
  moment: "Use Intl.DateTimeFormat / date-fns",
  lodash: "Use native Array/Object methods or lodash-es tree-shaken import",
};

function readJson(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  // ESM TS style: ./scan.js -> ./scan.ts
  const stripped = base.replace(/\.jsx?$/, "");
  const candidates = [
    base,
    stripped + ".ts",
    stripped + ".tsx",
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(stripped, "index.ts"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return path.normalize(c);
  }
  return null;
}

export async function scanRepo(root: string, opts: { includeDev?: boolean } = {}): Promise<ScanResult> {
  const pkg = readJson(path.join(root, "package.json"));
  const deps: string[] = Object.keys(pkg.dependencies ?? {});
  const hasNext = Boolean((pkg.dependencies ?? {}).next || (pkg.devDependencies ?? {}).next);

  let customEntries: string[] = [];
  const rcPath = path.join(root, ".reaperrc.json");
  if (fs.existsSync(rcPath)) {
    const rc = readJson(rcPath);
    if (Array.isArray(rc.entryPoints)) customEntries = rc.entryPoints;
  }

  const allRel = await fg(SRC_GLOB, { cwd: root, absolute: false, onlyFiles: true });
  const allFiles = new Set(allRel.map((f) => path.normalize(path.join(root, f))));

  // Entry points: conventions + framework magic + custom
  const entryCandidates = ["src/index.ts", "src/index.tsx", "src/main.ts", "src/main.tsx", "src/App.tsx"];
  const entries = new Set<string>();
  for (const e of [...entryCandidates, ...customEntries]) {
    const abs = path.normalize(path.join(root, e));
    if (allFiles.has(abs)) entries.add(abs);
  }
  if (hasNext) {
    const pages = await fg(["app/**/{page,layout,route}.tsx", "pages/**/*.{tsx,ts}"], {
      cwd: root,
      absolute: true,
      onlyFiles: true,
    });
    pages.forEach((p) => entries.add(path.normalize(p)));
  }
  if (entries.size === 0 && allFiles.size > 0) {
    // fallback: first file so scan never crashes on toy repos
    entries.add([...allFiles][0]);
  }

  const project = new Project({ useInMemoryFileSystem: false, skipAddingFilesFromTsConfig: true });
  const srcFiles: SourceFile[] = [];
  for (const f of allFiles) {
    try {
      srcFiles.push(project.addSourceFileAtPath(f));
    } catch {
      // ignore unparsable
    }
  }

  const usedPackages = new Set<string>();
  const fileImports = new Map<string, string[]>(); // absPath -> resolved abs imports

  for (const sf of srcFiles) {
    const fp = path.normalize(sf.getFilePath());
    const resolved: string[] = [];
    for (const imp of sf.getImportDeclarations()) {
      const spec = imp.getModuleSpecifierValue();
      if (spec.startsWith(".") || spec.startsWith("/")) {
        const r = resolveImport(fp, spec);
        if (r) resolved.push(r);
      } else {
        // bare specifier: axios, lodash/debounce, @scope/pkg/sub
        const pkgName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        usedPackages.add(pkgName);
      }
    }
    // dynamic import() calls
    const calls = sf.getDescendantsOfKind(207 as any) as any[]; // CallExpression kind-safe fallback
    for (const c of calls) {
      try {
        const expr: string = c.getExpression?.()?.getText?.() ?? "";
        const arg = c.getArguments?.()?.[0]?.getText?.() ?? "";
        if (expr === "import" && arg.startsWith("'") || expr === "import" && arg.startsWith('"')) {
          const spec = arg.slice(1, -1);
          if (spec.startsWith(".")) {
            const r = resolveImport(fp, spec);
            if (r) resolved.push(r);
          } else {
            usedPackages.add(spec.split("/")[0]);
          }
        }
      } catch { /* ignore */ }
    }
    fileImports.set(fp, resolved);
  }

  // BFS reachability
  const visited = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const cur = path.normalize(queue.shift()!);
    if (visited.has(cur)) continue;
    visited.add(cur);
    for (const nxt of fileImports.get(cur) ?? []) {
      if (allFiles.has(nxt) && !visited.has(nxt)) queue.push(nxt);
    }
  }

  const orphanedFiles = [...allFiles].filter((f) => !visited.has(f)).map((f) => path.relative(root, f));

  // Dead exports: exports never imported elsewhere
  const exportedByFile = new Map<string, string[]>();
  for (const sf of srcFiles) {
    const fp = path.normalize(sf.getFilePath());
    try {
      const decls = sf.getExportedDeclarations();
      exportedByFile.set(fp, [...decls.keys()]);
    } catch {
      exportedByFile.set(fp, []);
    }
  }
  const importedNames = new Set<string>();
  for (const sf of srcFiles) {
    for (const imp of sf.getImportDeclarations()) {
      for (const n of imp.getNamedImports()) importedNames.add(n.getName());
      const def: any = (imp as any).getDefaultImport?.();
      if (def) importedNames.add(typeof def === "string" ? def : def.getText?.() ?? String(def));
      const ns: any = (imp as any).getNamespaceImport?.();
      if (ns) importedNames.add(typeof ns === "string" ? ns : ns.getText?.() ?? String(ns));
    }
    // re-exports count as usage: export * / export {x} from
    for (const exp of sf.getExportDeclarations()) {
      for (const n of exp.getNamedExports()) importedNames.add(n.getName());
      if (exp.hasModuleSpecifier()) {
        const node = exp.getModuleSpecifierValue();
        if (node && !node.startsWith(".")) {
          const pkgName = node.split("/")[0];
          usedPackages.add(pkgName);
        }
      }
    }
  }

  const deadExports: ScanResult["deadExports"] = [];
  for (const [fp, names] of exportedByFile) {
    if (!visited.has(fp)) continue; // orphaned files already reported
    const sf = project.getSourceFile(fp);
    if (!sf) continue;
    for (const name of names) {
      if (name === "default" || importedNames.has(name)) continue;
      // line number via declaration
      let line = 0;
      try {
        const d = sf.getExportedDeclarations().get(name)?.[0] as any;
        line = d?.getStartLineNumber?.() ?? 0;
      } catch { /* ignore */ }
      deadExports.push({ file: path.relative(root, fp), name, line });
    }
  }

  const unusedDeps = deps.filter((d) => !usedPackages.has(d));

  return {
    totalFiles: allFiles.size,
    orphanedFiles,
    deadExports,
    unusedDeps,
  };
}

export function heavyHint(pkg: string): string | undefined {
  return HEAVY_MAP[pkg];
}
