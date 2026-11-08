import { expect, test } from "vitest";
import { parse } from "yaml";
import { mergeJiuwenswarmModelConfig } from "../../src/runtimes/jiuwenswarm/prepare.js";

test("JiuwenSwarm keeps candidate model settings while enabling native input and tool images", () => {
  const config = parse(mergeJiuwenswarmModelConfig(`react:
  max_iterations: 7
models:
  defaults:
    - model_client_config:
        model_name: \${MODEL_NAME}
      model_config_obj:
        temperature: 0.2
`, true));
  expect(config.react).toEqual({ max_iterations: 7, enable_read_image_multimodal: true });
  expect(config.models.defaults[0]).toMatchObject({ model_client_config: { model_name: "${MODEL_NAME}", supports_vision: true }, model_config_obj: { temperature: 0.2 } });
});

test.each([
  "react:\n  enable_read_image_multimodal: false\n",
  "models:\n  defaults:\n    - model_client_config:\n        supports_vision: false\n",
])("JiuwenSwarm refuses candidate settings that disable native images", config => {
  expect(() => mergeJiuwenswarmModelConfig(config, true)).toThrow(/disables native image/);
});

test("text-only JiuwenSwarm does not enable vision or erase an explicit opt-out", () => {
  const config = parse(mergeJiuwenswarmModelConfig("react:\n  enable_read_image_multimodal: false\n"));
  expect(config.react.enable_read_image_multimodal).toBe(false);
  expect(config.models.defaults[0].model_client_config.supports_vision).toBeUndefined();
});
