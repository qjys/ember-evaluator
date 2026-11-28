import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { fetchWeb, searchWeb } from "./infrastructure/network/web-search.mjs";

const event = JSON.parse(await text(process.stdin));
const output = process.argv[2];
const isFetch = event.tool_name === "WebFetch";
const record = async entry => {
  if (!output) return;
  await mkdir(output, { recursive: true });
  await appendFile(join(output, isFetch ? "web-fetch.jsonl" : "web-search.jsonl"), JSON.stringify({ tool: event.tool_name, ...entry }) + "\n", { mode: 0o600 });
};
if (event.tool_name === "WebSearch") {
  const args = event.tool_input;
  const results = event.tool_response?.results;
  const entries = Array.isArray(results) ? results.flatMap(item => item?.content ?? []) : [];
  const sources = entries.filter(item => typeof item?.url === "string" && /^https?:\/\//u.test(item.url));
  if (sources.length) {
    await record({ backend: "native", sources: sources.map(({ url, title }) => ({ url, title })) });
  } else if (args?.allowed_domains?.length || args?.blocked_domains?.length) {
    await record({ backend: "native", failure: "no sources; supplementary search cannot enforce these domain filters" });
  } else {
    let additionalContext;
    try {
      const result = await searchWeb(args?.query, AbortSignal.timeout(65_000));
      await record({ backend: result.backend, sources: result.results, failures: ["native: no sources"] });
      additionalContext = JSON.stringify({ backend: result.backend, sources: result.results });
    } catch (error) {
      await record({ failure: error.message });
      additionalContext = "Supplementary search failed: " + error.message;
    }
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext } }));
  }
}

if (isFetch) {
  const network = JSON.parse(process.argv[3] ?? '"bridge"');
  if (network !== "none" && network !== "model-api") {
    if (event.hook_event_name === "PostToolUseFailure") {
      let additionalContext;
      try {
        const result = await fetchWeb(event.tool_input?.url, network?.allowedHosts, AbortSignal.timeout(95_000));
        await record({ backend: result.backend, failures: ["native: tool failed"] });
        additionalContext = JSON.stringify(result);
      } catch (error) {
        await record({ failure: error.message });
        additionalContext = "Supplementary fetch failed: " + error.message;
      }
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext } }));
    } else {
      await record({ origin: "native", backend: "native" });
    }
  }
}
