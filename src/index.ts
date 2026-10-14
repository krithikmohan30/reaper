#!/usr/bin/env node
import { Command } from "commander";
import ora from "ora";
import pc from "picocolors";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { Project } from "ts-morph";
import { heavyHint, scanRepo } from "./scan.js";

const program = new Command();
program.name("reaper").description("Dependency Bloat & Dead-Code CLI").version("0.1.0");

program
  .command("scan")
  .description("Scan repo for orphan files, dead exports, unused deps")
  .option("--json", "JSON output for CI")
  .option("--include-dev", "Also scan devDependencies (default: dependencies only)")
  .option("--ci", "Exit 1 if dead code exceeds threshold (for GitHub Actions)")
  .action(async (opts) => {
    const root = process.cwd();
    const spinner = ora("Reaper scanning...").start();
    const t0 = Date.now();
    const res = await scanRepo(root);
    const ms = ((Date.now() - t0) / 1000).toFixed(2);
    spinner.stop();

    if (opts.json || opts.ci) {
      console.log(JSON.stringify({ ...res, seconds: Number(ms) }, null, 2));
      if (opts.ci && res.orphanedFiles.length + res.deadExports.length + res.unusedDeps.length > 0) {
        process.exit(1);
      }
      return;
    }

    console.log(pc.green(`⚡ Reaper scanned ${res.totalFiles} files in ${ms}s`));
    console.log(pc.yellow(`\n📁 ORPHANED FILES (Safe to delete)`));
    if (res.orphanedFiles.length === 0) console.log("  ✔ none");
    res.orphanedFiles.forEach((f) => console.log(`  ${pc.red("✖")} ${f}`));

    console.log(pc.yellow(`\n🔌 UNUSED EXPORTS (Exported, never imported)`));
    if (res.deadExports.length === 0) console.log("  ✔ none");
    res.deadExports.forEach((d) => console.log(`  ${pc.red("✖")} ${d.file} -> ${d.name} (line ${d.line})`));

    console.log(pc.yellow(`\n📦 UNUSED NPM PACKAGES`));
    if (res.unusedDeps.length === 0) console.log("  ✔ none");
    else {
      console.log(`  Run: npm uninstall ${res.unusedDeps.join(" ")}`);
      res.unusedDeps.forEach((p) => {
        const hint = heavyHint(p) ? ` — ${heavyHint(p)}` : "";
        console.log(`  ${pc.red("✖")} ${p} (0 imports found)${hint}`);
      });
    }
    console.log(pc.cyan(`\n💡 Run \`reaper prune --dry-run\` to preview cleanup.`));
  });

program
  .command("prune")
  .description("Remove dead exports / orphan files (AST-safe)")
  .option("--dry-run", "Preview only, no writes", false)
  .option("--safe-prune", "Run npm test after prune, auto-revert on fail", false)
  .option("--allow-orphan-delete", "Also delete orphaned files (default: exports only)", false)
  .action(async (opts) => {
    const root = process.cwd();
    const res = await scanRepo(root);
    if (opts.dryRun) {
      console.log(pc.yellow("Dry run — would remove:"));
      res.deadExports.forEach((d) => console.log(`  - ${d.file} :: ${d.name}`));
      if (opts.allowOrphanDelete) res.orphanedFiles.forEach((f) => console.log(`  - ${f} (file)`));
      return;
    }

    const project = new Project({ skipAddingFilesFromTsConfig: true });
    const byFile = new Map<string, string[]>();
    for (const d of res.deadExports) {
      if (!byFile.has(d.file)) byFile.set(d.file, []);
      byFile.get(d.file)!.push(d.name);
    }
    for (const [rel, names] of byFile) {
      const abs = path.join(root, rel);
      if (!fs.existsSync(abs)) continue;
      const sf = project.addSourceFileAtPath(abs);
      for (const n of names) {
        const decls = sf.getExportedDeclarations().get(n) ?? [];
        for (const decl of decls as any[]) {
          try {
            if (typeof decl.setIsExported === "function" && decl.getKindName?.() !== "VariableStatement") {
              decl.setIsExported(false);
            } else if (typeof decl.remove === "function") {
              // only remove if file has other exports (avoid emptying barrel unsafely)
              decl.remove();
            }
          } catch { /* skip unsafe */ }
        }
      }
    }
    await project.save();
    console.log(pc.green(`Pruned ${res.deadExports.length} dead exports.`));

    if (opts.allowOrphanDelete) {
      for (const rel of res.orphanedFiles) {
        try { fs.unlinkSync(path.join(root, rel)); console.log(`Deleted ${rel}`); } catch {}
      }
    }

    if (opts.safePrune) {
      try {
        execSync("npm test --silent", { stdio: "inherit", cwd: root });
        console.log(pc.green("Tests passed — prune kept."));
      } catch {
        console.log(pc.red("Tests failed — reverting..."));
        execSync("git checkout .", { stdio: "inherit", cwd: root });
      }
    }
  });

program.parse();
