import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  pnpm: { type: "string" }, "temp-root": { type: "string" },
  "dependency-overrides": { type: "string" }, offline: { type: "boolean", default: false },
} });
const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
const hostRoot = resolve(pluginRoot, "../..");
const pnpmEntry = values.pnpm ?? process.env.npm_execpath;
assert(pnpmEntry && /pnpm\.(?:c?js|mjs)$/u.test(pnpmEntry), "Run via pnpm check:package, or pass --pnpm <pnpm.mjs>");
const host = JSON.parse(await readFile(join(hostRoot, "package.json"), "utf8"));
const plugin = JSON.parse(await readFile(join(pluginRoot, "package.json"), "utf8"));
await stat(join(hostRoot, "dist/index.js"));
await stat(join(pluginRoot, "dist/index.js"));
const tempRoot = resolve(values["temp-root"] ?? tmpdir());
await mkdir(tempRoot, { recursive: true });
const directory = await mkdtemp(join(tempRoot, "aisbench-package-"));
const fromHost = relative(await realpath(hostRoot), await realpath(directory));
assert(isAbsolute(fromHost) || fromHost === ".." || fromHost.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`),
  "Package consumer must be outside the source checkout");
function pnpm(args, cwd) {
  try {
    return execFileSync(process.execPath, [pnpmEntry, ...args], {
      cwd, encoding: "utf8", timeout: 180000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, npm_config_ignore_scripts: "true" },
    });
  } catch (error) {
    if (error.stdout) console.error(error.stdout);
    throw error;
  }
}
let failure;
try {
  const tarballs = join(directory, "tarballs");
  const consumer = join(directory, "consumer");
  await mkdir(tarballs);
  await mkdir(consumer);
  for (const [root, name] of [[hostRoot, "host.tgz"], [pluginRoot, "plugin.tgz"]]) {
    pnpm(["--ignore-workspace", "--config.ignore-scripts=true", "pack", "--out", join(tarballs, name)], root);
  }
  let overrides = {};
  if (values["dependency-overrides"]) {
    // Optional local tarballs let an offline/private dependency cache be supplied explicitly.
    // These remain package artifacts, never links to another checkout's node_modules.
    overrides = JSON.parse(await readFile(resolve(values["dependency-overrides"]), "utf8"));
    assert(overrides && typeof overrides === "object" && !Array.isArray(overrides), "Dependency overrides must be an object");
    for (const [name, target] of Object.entries(overrides)) {
      assert(typeof target === "string" && target.startsWith("file:") && target.endsWith(".tgz"), `${name} override must be a file: tarball`);
      const artifact = resolve(target.slice(5));
      await stat(artifact);
      const local = join(tarballs, `dependency-${Object.keys(overrides).indexOf(name)}.tgz`);
      await copyFile(artifact, local);
      overrides[name] = `file:${local.replaceAll("\\", "/")}`;
    }
  }
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    name: "aisbench-package-consumer", private: true, type: "module", packageManager: host.packageManager,
    dependencies: { [host.name]: "file:../tarballs/host.tgz", [plugin.name]: "file:../tarballs/plugin.tgz" },
  }, null, 2));
  // JSON is valid YAML; pnpm 11 reads settings here, not package.json.pnpm.
  await writeFile(join(consumer, "pnpm-workspace.yaml"), JSON.stringify({ packages: ["."], overrides, blockExoticSubdeps: false }, null, 2));
  pnpm(["install", "--ignore-scripts", "--config.auto-install-peers=false", ...(values.offline ? ["--offline"] : [])], consumer);
  const installedHost = await realpath(join(consumer, "node_modules", host.name));
  const installedPlugin = await realpath(join(consumer, "node_modules", plugin.name));
  for (const installed of [installedHost, installedPlugin]) {
    const path = relative(consumer, installed);
    assert(path && !isAbsolute(path) && !path.startsWith(".."), "Installed packages must resolve inside the isolated consumer");
  }
  const installedMetadata = JSON.parse(await readFile(join(installedPlugin, "package.json"), "utf8"));
  assert.equal(installedMetadata.peerDependencies[host.name], host.version);
  assert(!installedMetadata.dependencies?.[host.name]?.startsWith("link:"));
  for (const asset of [
    "dist/index.js", "dist/profiles/aisbench.yaml", "dist/profiles/aisbench-native.yaml", "dist/runtime/remote.py", "dist/runtime/synthetic.py",
    "dist/runtime/upstream/aisbench_test.py", "dist/runtime/upstream/generate_dataset.py",
    "dist/runtime/upstream/data_picker.py", "dist/runtime/upstream/default_api.py",
    "dist/runtime/upstream/cal_prefix_hit_rate.py", "dist/runtime/upstream/save_file.py",
    "dist/runtime/upstream/GSM8K.jsonl", "dist/runtime/upstream/LICENSE", "dist/runtime/upstream/NOTICE.md",
    "cordis.patch.yaml", "README.md", "playbook/01-ssh.yaml",
  ]) assert((await stat(join(installedPlugin, asset))).size > 0, `Missing packed asset: ${asset}`);
  for (const file of ["consumer.mjs", "no-external.mjs"]) {
    await copyFile(join(pluginRoot, "tests/integration", file), join(consumer, file));
  }
  const env = { ...process.env, AISBENCH_TEST_EXTERNAL_LOG: join(consumer, "external.log") };
  delete env.NODE_PATH;
  delete env.AISBENCH_OFFLINE_KEY;
  const result = execFileSync(process.execPath, [
    "--import", pathToFileURL(join(consumer, "no-external.mjs")).href,
    join(consumer, "consumer.mjs"), "all", consumer,
  ], { cwd: consumer, env, encoding: "utf8", timeout: 100000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(JSON.parse(result).passed, true);
  console.log(JSON.stringify({ passed: true, isolated: true, host: host.version, plugin: plugin.version,
    dependencyOverrides: Object.keys(overrides), checks: ["resources", "no-patch", "providers", "dry-run", "offline-report", "provider-version"] }));
} catch (error) {
  failure = error;
  throw error;
} finally {
  // directory is the exact mkdtemp result under the checked temp root.
  assert.equal(dirname(directory), tempRoot);
  try { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch (error) {
    if (!failure) throw error;
    console.error(`Temporary package consumer cleanup failed: ${error.message}`);
  }
}
