import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type { ModelConfig } from "../../core/contracts/config.js";

/** Resolve only the pinned, offline catalog; never guess from a model name. */
export async function resolveModelInput(model: ModelConfig): Promise<ModelConfig> {
  if (model.inputModalities !== undefined) return model;
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false });
  const matches = runtime.getModels().filter(candidate => candidate.id === model.name &&
    (model.provider === null || candidate.provider === model.provider));
  return { ...model, inputModalities: matches.length === 1 ? [...matches[0]!.input] : ["text"] };
}
