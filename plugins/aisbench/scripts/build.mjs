import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = resolve(root, "dist");
assert.equal(dirname(destination), resolve(root));
assert.equal(destination, resolve(root, "dist"));
const manifest = JSON.parse(await readFile(new URL("../resources.json", import.meta.url), "utf8"));
const assets = ["profiles/aisbench.yaml", "profiles/aisbench-native.yaml", ...manifest.runtime.map(name => `runtime/${name}`)];
const hashes = {}, contents = {};
for (const name of assets) {
  assert(!name.includes("..") && !name.includes("\\") && !name.startsWith("/"));
  contents[name] = (await readFile(resolve(root, name), "utf8")).replace(/\r\n/gu, "\n");
  hashes[name] = createHash("sha256").update(contents[name]).digest("hex");
}
await rm(destination, { recursive: true, force: true });
await build({
  absWorkingDir: root, entryPoints: ["index.ts"], outfile: "dist/index.js",
  bundle: true, platform: "node", format: "esm", target: "node24", packages: "external",
  define: { __AISBENCH_RESOURCE_HASHES__: JSON.stringify(hashes) },
});
for (const [name, content] of Object.entries(contents)) {
  const target = resolve(destination, name);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}
console.log(`Built AISBench entry and ${assets.length} verified resources.`);
