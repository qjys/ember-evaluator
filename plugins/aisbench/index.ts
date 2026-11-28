import type { Context } from "@deepseek-ai/cordis";
import { readProfileDirectory } from "arsi-evaluator";
import { AisbenchBenchmark } from "./benchmark.js";
import { parseAisbenchConfig, parseAisbenchSshConfig } from "./config.js";
import { AisbenchSshSolver } from "./solver.js";
import { AisbenchPerformanceMetrics } from "./metrics.js";
import { AisbenchMarkdownReporter } from "./reporter.js";
import { expectRecord, rejectUnknown } from "./validation.js";
import { profileDirectory, verifyResources } from "./ssh/bundle.js";

import { NativeBenchmark } from "./native-benchmark.js";
import { parseNativeConfig } from "./native-config.js";
import { NativeMarkdownReporter, NativePerformanceMetrics } from "./native-results.js";

export { AisbenchBenchmark } from "./benchmark.js";
export { parseAisbenchConfig, parseAisbenchSshConfig } from "./config.js";
export type { AisbenchConfig, AisbenchSshConfig, AisbenchWorkload } from "./config.js";
export { AisbenchSshSolver } from "./solver.js";
export { AisbenchPerformanceMetrics } from "./metrics.js";
export { AisbenchMarkdownReporter } from "./reporter.js";

export const inject = ["evaluator"];

function emptyConfig(value: unknown): Record<string, never> {
  rejectUnknown(expectRecord(value, "AISBench reporting config"), [], "AISBench reporting config");
  return {};
}

export async function apply(ctx: Context): Promise<void> {
  await verifyResources();
  for (const profile of await readProfileDirectory(profileDirectory)) ctx.evaluator.registerProfile(profile);
  ctx.evaluator.register("benchmark", "aisbench", parseAisbenchConfig, config => new AisbenchBenchmark(config));
  ctx.evaluator.register("benchmark", "aisbench-native", parseNativeConfig, (config, runtime) => new NativeBenchmark(config, runtime));
  ctx.evaluator.register("metrics", "aisbench-native-performance", emptyConfig, () => new NativePerformanceMetrics());
  ctx.evaluator.register("reporter", "aisbench-native-markdown", emptyConfig, () => new NativeMarkdownReporter());
  ctx.evaluator.register("solver", "aisbench-ssh", parseAisbenchSshConfig, (config, runtime) => {
    const solver = new AisbenchSshSolver({ ...config, remote: { ...config.remote, ssh: { ...config.remote.ssh,
      ...(config.remote.ssh.identityFile === undefined ? {} : { identityFile: runtime.resolvePath(config.remote.ssh.identityFile) }) } } }, runtime);
    ctx.effect(() => () => solver.dispose(), "AISBench generated dataset");
    return solver;
  });
  ctx.evaluator.register("metrics", "aisbench-performance", emptyConfig, () => new AisbenchPerformanceMetrics());
  ctx.evaluator.register("reporter", "aisbench-markdown", emptyConfig, () => new AisbenchMarkdownReporter());
}
