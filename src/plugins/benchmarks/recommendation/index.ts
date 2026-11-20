import type { Context } from "@deepseek-ai/cordis";
import { readProfileDirectory } from "../../../infrastructure/profiles/read.js";
import { RecommendationBenchmark } from "./benchmark.js";
import { parseRecommendationConfig } from "./config.js";

export async function apply(ctx: Context): Promise<void> {
  for (const profile of await readProfileDirectory(new URL("./profiles/", import.meta.url))) ctx.evaluator.registerProfile(profile);
  ctx.evaluator.register("benchmark", "recommendation", parseRecommendationConfig, (config, runtime) =>
    new RecommendationBenchmark(config, runtime.resolvePath));
}
