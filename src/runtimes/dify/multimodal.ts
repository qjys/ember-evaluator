import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { checkedPath } from "../../core/artifacts/artifacts.js";
import { expectNonEmptyString, expectRecord } from "../../core/validation/input.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";

export type DifyFileModel = { nodeId: string; provider: string; name: string };

/** Bind original files directly to an LLM, not a document extractor's text. */
export async function assertDifyFileWorkflow(bundle: string, variable: string, modelName: string): Promise<DifyFileModel[]> {
  const manifest = expectRecord(parse(await readFile(await checkedPath(bundle, "bundle.yaml"), "utf8")), "Dify bundle");
  const entry = expectNonEmptyString(manifest.entry, "Dify entry").replace(/^\.\//, "");
  const doc = expectRecord(parse(await readFile(await checkedPath(bundle, entry), "utf8")), "Dify workflow");
  const workflow = expectRecord(doc.workflow, "Dify workflow");
  const graph = expectRecord(workflow.graph, "Dify graph");
  const nodes = Array.isArray(graph.nodes) ? graph.nodes.map(node => expectRecord(node, "Dify node")) : [];
  const starts = nodes.filter(node => expectRecord(node.data, "Dify node data").type === "start").map(node => node.id);
  const edges = Array.isArray(graph.edges) ? graph.edges.map(edge => expectRecord(edge, "Dify edge")) : [];
  const reaches = (source: unknown, target: unknown): boolean => {
    const pending = [source]; const seen = new Set<unknown>();
    while (pending.length) {
      const next = pending.pop();
      if (next === target) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      for (const edge of edges) if (edge.source === next) pending.push(edge.target);
    }
    return false;
  };
  const ends = nodes.filter(node => expectRecord(node.data, "Dify node data").type === "end");
  const bound: DifyFileModel[] = [];
  for (const node of nodes) {
    const data = expectRecord(node.data, "Dify node data");
    if (data.type !== "llm") continue;
    const vision = data.vision ? expectRecord(data.vision, "Dify vision") : undefined;
    const selector = vision?.enabled === true ? expectRecord(vision.configs, "Dify vision configs").variable_selector : undefined;
    const prompts = Array.isArray(data.prompt_template) ? data.prompt_template : [data.prompt_template];
    const source = starts.find(start =>
      Array.isArray(selector) && selector.length === 2 && selector[0] === start && selector[1] === variable ||
      prompts.some(prompt => {
        if (!prompt) return false;
        const value = expectRecord(prompt, "Dify prompt");
        return value.edition_type !== "jinja2" && typeof value.text === "string" && value.text.includes(`{{#${String(start)}.${variable}#}}`);
      }));
    if (source === undefined || !reaches(source, node.id) || !ends.some(end => reaches(node.id, end.id))) continue;
    const model = expectRecord(data.model, "Dify file model");
    if (model.name !== modelName || data.model_selector !== undefined)
      throw new EvaluatorError("CONFIG_INVALID", "Dify file node model differs from the declared evaluation model or uses a dynamic model selector");
    bound.push({ nodeId: expectNonEmptyString(node.id, "Dify node id"),
      provider: expectNonEmptyString(model.provider, "Dify model provider"), name: modelName });
  }
  if (!bound.length) throw new EvaluatorError("CONFIG_INVALID", `Dify workflow must bind start.${variable} directly to an LLM file input on a path to the output`);
  return bound;
}
