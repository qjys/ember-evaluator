/** Forward native argv as tokens. Credentials and service/output routing belong to the binding. */
export function nativeArguments(value: unknown, reserved: readonly string[]): string[] {
  if (!Array.isArray(value) || !value.every((v): v is string => typeof v === "string" && !/[\0\r\n]/u.test(v))) throw new TypeError("native.args must be a list of string tokens");
  for (const token of value) {
    const flag = token.split("=", 1)[0]!;
    if (reserved.includes(flag) || reserved.some(option => option.startsWith("--") && flag.length > 2 && option.startsWith(flag)) || flag === "--" || /^(?:--?.*(?:api-key|authorization|headers?|password|secret|access-token)|-h|--help|--version)$/iu.test(flag))
      throw new TypeError("native.args cannot override managed option " + flag);
  }
  return [...value];
}

export const agentXManagedArgs = ["--url","--endpoint","--model","--tokenizer","--output-artifact-dir","--scenario"];
export const aisbenchManagedArgs = ["--agent-api-key","--api-key","--api-base","--ak","-k","--env-file","--mode","-m","--work-dir","-w","--url","--model-name","--host-ip","--host-port","--config-dir","--reuse"];
