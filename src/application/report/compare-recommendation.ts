import { resolve } from "node:path";
import { compareRecommendation } from "../../plugins/benchmarks/recommendation/compare.js";
import { LocalRunStore } from "../../plugins/stores/local.js";

async function readRun(directory: string) {
  const store = new LocalRunStore();
  try {
    await store.open(resolve(directory));
    return await store.snapshot();
  } finally {
    await store.close();
  }
}

export async function compareRecommendationRuns(baseDirectory: string, fastDirectory: string) {
  return compareRecommendation(await readRun(baseDirectory), await readRun(fastDirectory));
}
