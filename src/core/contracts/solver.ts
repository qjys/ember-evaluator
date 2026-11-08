import type { ErrorCode } from "../errors/registry.js";
import type { EnvironmentSession, RuntimeInstallation, RuntimeRequirement } from "./environment.js";
import type { AttemptKey, AttemptPaths, SolveResult } from "./result.js";
import type { InputModality, PublicTask } from "./task.js";
import type { ActivityListener } from "./activity.js";

export type AttemptContext = {
  key: AttemptKey;
  paths: AttemptPaths;
  signal: AbortSignal;
  activity?: ActivityListener;
  /** Nonfatal Solver diagnostics; do not change scoring or terminate the task. */
  warning?: (warning: { code: ErrorCode; message: string }) => void;
};

export interface PreparedSolver {
  inputModalities?: readonly InputModality[];
  solve(input: PublicTask, context: AttemptContext): Promise<SolveResult>;
  dispose?(signal: AbortSignal): Promise<void>;
}

/** Opaque, credential-free candidate/runtime identifiers; never host paths. */
export type SolverProvenance = Record<string, string>;

export interface Solver {
  inputModalities?: readonly InputModality[];
  requirements(): RuntimeRequirement[];
  /** Previous identity permits immutable dependency pins to be reused on resume. */
  provenance?(signal: AbortSignal, previous?: SolverProvenance): Promise<SolverProvenance>;
  runtimeInstallation?(signal: AbortSignal): Promise<RuntimeInstallation>;
  prepare?(session: EnvironmentSession, context: AttemptContext): Promise<PreparedSolver>;
  solve(input: PublicTask, session: EnvironmentSession, context: AttemptContext): Promise<SolveResult>;
}
