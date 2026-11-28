import { createInterface } from "node:readline";
import { once } from "node:events";

import { fetchWeb, searchWeb, startSearchMcp } from "../../../infrastructure/network/web-search.mjs";
import { text } from "node:stream/consumers";

const [mode, config] = process.argv.slice(2);
if (mode === "--fetch") {
  const result = await fetchWeb(await text(process.stdin), JSON.parse(config ?? "{}").allowedHosts, AbortSignal.timeout(95_000));
  process.stdout.write(JSON.stringify(result));
} else if (mode === "--query") {
  const result = await searchWeb(await text(process.stdin), AbortSignal.timeout(65_000));
  process.stdout.write(JSON.stringify(result));
} else {
  const tools = mode === "--serve" && config ? JSON.parse(config) : {};
  const backend = mode === "--serve" ? await startSearchMcp({ webSearch: tools.search === false ? "disabled" : undefined },
    undefined, tools.fetch ? (url, signal) => fetchWeb(url, tools.allowedHosts, signal) : undefined) : undefined;
  try {
    await forward(backend?.url ?? mode);
  } finally {
    backend?.close();
  }
}

async function forward(url) {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const response = await fetch(url, { method: "POST", redirect: "error",
      headers: { "content-type": "application/json" }, body: line });
    if (!response.ok) throw Error("Local search server returned HTTP " + response.status);
    if (response.status === 202) continue;
    if (!process.stdout.write(JSON.stringify(await response.json()) + "\n")) await once(process.stdout, "drain");
  }
}
