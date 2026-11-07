import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type InstalledPlugin = { id: string; version: string; entry: string; cli?: string };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid plugin manifest");
  return value as Record<string, unknown>;
}

function localPath(base: string, value: unknown): string {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\")) throw new TypeError("Invalid plugin entry path");
  const path = resolve(base, value);
  const rel = relative(base, path);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new TypeError("Plugin entry escapes its directory");
  return path;
}

export function readPluginCatalog(root = fileURLToPath(new URL("../", import.meta.url))): InstalledPlugin[] {
  const index = resolve(root, "dist/external-plugins/index.json");
  let entries: { value: unknown; base: string }[];
  if (existsSync(index)) {
    const body = record(JSON.parse(readFileSync(index, "utf8")));
    if (body.schemaVersion !== 1 || !Array.isArray(body.plugins)) throw new TypeError("Unsupported plugin index");
    entries = body.plugins.map(value => ({ value, base: dirname(index) }));
  } else {
    const directory = resolve(root, "plugins");
    const version: unknown = record(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"))).version;
    entries = existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
      const base = resolve(directory, entry.name);
      const file = resolve(base, "ember-plugin.json");
      if (!existsSync(file)) return [];
      const manifest = record(JSON.parse(readFileSync(file, "utf8")));
      if (manifest.schemaVersion !== 1) throw new TypeError(`Unsupported plugin manifest: ${entry.name}`);
      if (manifest.id !== entry.name) throw new TypeError(`Plugin id must match directory ${entry.name}`);
      return [{ value: { ...manifest, version: manifest.version ?? version }, base }];
    }) : [];
  }
  const ids = new Set<string>();
  return entries.map(({ value, base }) => {
    const item = record(value);
    if (typeof item.id !== "string" || !/^[a-z][a-z0-9-]*$/u.test(item.id) || ids.has(item.id)) throw new TypeError("Invalid or duplicate plugin id");
    if (typeof item.version !== "string" || !item.version.trim()) throw new TypeError(`Missing version for plugin ${item.id}`);
    ids.add(item.id);
    return { id: item.id, version: item.version, entry: localPath(base, item.entry),
      ...(item.cli === undefined ? {} : { cli: localPath(base, item.cli) }) };
  });
}

export async function loadInstalledPlugin(plugin: InstalledPlugin): Promise<unknown> {
  const module: Record<string, unknown> = await import(pathToFileURL(plugin.entry).href);
  return module.default ?? module;
}
