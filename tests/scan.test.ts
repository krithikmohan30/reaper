import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "../src/scan.js";

function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reaper-"));
  fs.mkdirSync(path.join(dir, "src", "utils"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "fix", dependencies: { axios: "^1.0.0", lodash: "^4.0.0" } })
  );
  fs.writeFileSync(path.join(dir, "src", "index.ts"), `import { add } from "./utils/math";\nconsole.log(add(1,2));\n`);
  fs.writeFileSync(
    path.join(dir, "src", "utils", "math.ts"),
    `export function add(a:number,b:number){return a+b;}\nexport function formatCurrency(n:number){return "$"+n;}\n`
  );
  fs.writeFileSync(path.join(dir, "src", "utils", "legacy.ts"), `export const x = 1;\n`);
  return dir;
}

describe("reaper scan", () => {
  it("finds orphan files, dead exports, unused deps", async () => {
    const root = makeFixture();
    const res = await scanRepo(root);
    expect(res.totalFiles).toBe(3);
    expect(res.orphanedFiles.join()).toContain("legacy.ts");
    expect(res.deadExports.map((d) => d.name)).toContain("formatCurrency");
    expect(res.unusedDeps).toContain("axios");
    expect(res.unusedDeps).toContain("lodash");
  });
});
