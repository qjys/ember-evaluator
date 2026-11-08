import { resolveDifyConsole } from "agent-bundle-core";
import type { InputModality } from "../../core/contracts/task.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { expectRecord } from "../../core/validation/input.js";
import type { DifyFileModel } from "./multimodal.js";

/** Dify silently filters unsupported content, so inspect the deployed Provider first. */
export async function assertDifyModelCapabilities(
  baseUrl: string, models: readonly DifyFileModel[], modalities: readonly InputModality[], signal: AbortSignal,
): Promise<{ models: readonly DifyFileModel[]; features: string[] }> {
  const credentials = await resolveDifyConsole({ ...process.env, DIFY_BASE: baseUrl }, false);
  const headers: Record<string, string> = {};
  if (credentials.adminApiKey) headers.Authorization = `Bearer ${credentials.adminApiKey}`;
  else {
    const response = await fetch(`${baseUrl}/console/api/login`, { method: "POST", signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: credentials.email, password: Buffer.from(credentials.password ?? "").toString("base64"), remember_me: true }) });
    const cookies = new Map(response.headers.getSetCookie().map(value => {
      const pair = value.split(";", 1)[0]!; const split = pair.indexOf("=");
      return [pair.slice(0, split).trim(), pair.slice(split + 1).trim()];
    }));
    await response.body?.cancel();
    if (!response.ok || !cookies.has("access_token"))
      throw new EvaluatorError("MODEL_AUTH_FAILED", `Dify model capability inspection requires Console access (${response.status})`);
    headers.Cookie = [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
    if (cookies.has("csrf_token")) headers["X-CSRF-Token"] = cookies.get("csrf_token")!;
  }
  const response = await fetch(`${baseUrl}/console/api/workspaces/current/models/model-types/llm`, { headers, signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw new EvaluatorError("CONFIG_INVALID", `Cannot inspect Dify model capabilities (${response.status})`);
  }
  const body = expectRecord(await response.json(), "Dify models");
  const available = Array.isArray(body.data) ? body.data.map(value => expectRecord(value, "Dify model")) : [];
  const required = modalities.filter(kind => kind !== "text").map(kind => kind === "pdf" ? "document" : "vision");
  for (const model of models) {
    const match = available.find(value => value.model === model.name &&
      expectRecord(value.provider, "Dify model provider").provider === model.provider);
    const features = match?.features;
    if (!Array.isArray(features) || required.some(feature => !features.includes(feature)))
      throw new EvaluatorError("BENCHMARK_UNSUPPORTED", `Dify node ${model.nodeId}: Provider ${model.provider}/${model.name} must declare ${required.join(", ")}; otherwise Dify removes the files`);
  }
  return { models, features: required };
}
