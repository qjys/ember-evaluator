import type { ProcessHandle } from "../../core/contracts/environment.js";
import type { SolveResult, Usage } from "../../core/contracts/result.js";
import type { AttemptContext } from "../../core/contracts/solver.js";
import type { JsonValue } from "../../core/contracts/task.js";
import { classifyError } from "../../core/errors/classify.js";
import { redactDiagnostic } from "../../core/errors/diagnostics.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { unsupportedToolPolicy } from "../../core/validation/solver-tool-policy.js";
import { consumeCliJsonl, record, tokenCount, type CliEvent } from "../shared/cli-jsonl.js";

function usageFrom(value: JsonValue | undefined): Usage {
  const usage = record(value);
  const input = tokenCount(usage?.input_tokens);
  const cached = usage?.cache_read_input_tokens == null ? 0 : tokenCount(usage.cache_read_input_tokens);
  const written = usage?.cache_creation_input_tokens == null ? 0 : tokenCount(usage.cache_creation_input_tokens);
  const inputTokens = input === null || cached === null || written === null ? null : tokenCount(input + cached + written);
  const outputTokens = tokenCount(usage?.output_tokens);
  const totalTokens = inputTokens === null || outputTokens === null ? null : tokenCount(inputTokens + outputTokens);
  return { inputTokens, outputTokens, totalTokens };
}

export function consumeClaudeCode(
  handle: ProcessHandle, context: AttemptContext, secret: string, requiredWebTools: readonly string[] = [],
): Promise<SolveResult> {
  let result: CliEvent | undefined;
  let firstFailedResult: CliEvent | undefined;
  const turnUsages: Usage[] = [];
  return consumeCliJsonl(handle, context, [secret], {
    solver: "claudecode",
    label: "Claude Code",
    accept(event) {
      if (event.type === "assistant" || event.type === "user") context.activity?.({});
      if (event.type === "system" && event.subtype === "init" && typeof event.permissionMode === "string" && !["dontAsk", "bypassPermissions"].includes(event.permissionMode)) {
        unsupportedToolPolicy("claudecode", `CLI selected unexpected permission mode ${event.permissionMode}`);
      }
      if (requiredWebTools.length && event.type === "system" && event.subtype === "init") {
        const tools = Array.isArray(event.tools) ? event.tools : [];
        const missing = requiredWebTools.filter(name => !tools.includes(name));
        if (missing.length) {
          const settings = missing.map(name => name === "WebFetch" ? "webFetch: enabled" : "webSearch: enabled");
          unsupportedToolPolicy("claudecode", `${settings.join(", ")} requires ${missing.join(", ")}, but the CLI did not expose the requested tool for the selected model service`);
        }
      }
      if (event.type !== "result") return;
      if (result) {
        const previousIndex = tokenCount(result.result_index);
        const index = tokenCount(event.result_index);
        if (previousIndex === null || index !== previousIndex + 1) {
          throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "Claude Code emitted duplicate or out-of-order result events");
        }
      }
      // The CLI can complete queued turns after its initial result. Each
      // indexed result accounts for work since the previous result.
      result = event;
      if (event.is_error !== false || event.subtype !== "success") firstFailedResult ??= event;
      turnUsages.push(usageFrom(event.usage));
    },
    finish(exit, stderr) {
      if (firstFailedResult?.subtype === "error_max_turns") {
        throw new EvaluatorError("SOLVER_RESULT_INCOMPLETE", "Claude Code reached maxTurns before producing a final answer");
      }
      if (exit.code !== 0 || exit.signal !== null || firstFailedResult) {
        const diagnosticResult = firstFailedResult ?? result;
        const errors = Array.isArray(diagnosticResult?.errors) ? diagnosticResult.errors.filter(item => typeof item === "string").join("\n") : "";
        const resultText = typeof diagnosticResult?.result === "string" ? diagnosticResult.result : "";
        const diagnostic = redactDiagnostic(errors || resultText || stderr || `Claude Code exited with code ${exit.code} and signal ${exit.signal}`, [secret]);
        const status = tokenCount(diagnosticResult?.api_error_status);
        const failure = classifyError(Object.assign(new Error(diagnostic), status === null ? {} : { status }), {
          phase: "solve", component: "claudecode", fallbackCode: diagnosticResult?.is_error ? "SOLVER_RESULT_INCOMPLETE" : "SOLVER_PROCESS_CRASHED",
        });
        throw new EvaluatorError(failure.code, failure.message, failure.details);
      }
      if (!result) throw new EvaluatorError("SOLVER_RESULT_INCOMPLETE", "Claude Code exited without a result event");
      if (typeof result.result !== "string") throw new EvaluatorError("SOLVER_PROTOCOL_INVALID", "Claude Code result is missing its final text");
      const sum = (field: keyof Usage): number | null => {
        let value = 0;
        for (const usage of turnUsages) {
          const tokens = usage[field];
          if (tokens === null) return null;
          value += tokens;
        }
        return tokenCount(value);
      };
      return { finalText: result.result,
        usage: { inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), totalTokens: sum("totalTokens") } };
    },
  });
}
