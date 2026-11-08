import type { EnvironmentSpec, TransferSpec } from "./environment.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Explicit run-level overrides; absence preserves the task's declaration. */
export type PhaseTimeoutOverrides = { solveTimeoutSeconds?: number; verifyTimeoutSeconds?: number };

export type TaskRef = {
  id: string;
  recordKey: JsonValue;
};

export type TaskAttachment = {
  /** Public file relative to the solve workspace, using forward slashes. */
  path: string;
  sha256: string;
} & ({ kind: "image"; mediaType: "image/png" | "image/jpeg" | "image/webp" }
  | { kind: "pdf"; mode: "native" }
  | { kind: "pdf"; mode: "pages"; pages: number[]; dpi: number; rendererVersion: string });

export type InputModality = "text" | "image" | "pdf";

export type PublicTask = {
  id: string;
  prompt: string;
  attachments?: TaskAttachment[];
  skillsDirectories?: string[];
  mcpServers?: { name: string; transport: "sse" | "http"; url: string }[];
  /** Public structured input; never carries verifier-private material. */
  payload?: JsonValue;
};

export type DataFile = {
  path: string;
  sha256: string;
  origin: string;
};

export type SourceLock = {
  source: string;
  revision: string;
  files: DataFile[];
  metadata: JsonValue;
};

export type PreparedTask = {
  /** Ordered phases sharing one solve environment; private plans never reach the Solver. */
  steps?: PreparedStep[];
  /** Native graders may score surviving work even when a Solver phase failed. */
  scoreAfterSolveFailure?: boolean;
  input: PublicTask;
  verification: JsonValue;
  /** Node-local dependency receipt; never included in PublicTask. */
  verificationRuntime?: JsonValue;
  solveEnv: EnvironmentSpec;
  /** Independent grading may require an environment without transferring files. */
  verifyEnv: EnvironmentSpec | null;
  transfer: TransferSpec | null;
  /** Snapshot declared deliverables without restoring into another environment. */
  artifactCollection?: Extract<TransferSpec, { kind: "artifacts" }>;
  /** Omitted preserves non-Harbor benchmarks' existing verification contract. */
  verificationMode?: "none" | "shared" | "separate";
  verificationNetwork?: NonNullable<EnvironmentSpec["network"]>;
  /** Trusted task-declared collection, after the solver stops and before export. */
  collect?: { executable: string; args: string[]; timeoutSeconds: number; cwd: string; env: Record<string, string>; service?: string }[];
  /** Environment preparation bases, multiplied by min(node preparation concurrency, 10). */
  preparationTimeoutSeconds?: { solve?: number; verify?: number };
  /** Optional execution-stage ceilings; the task deadline still applies. */
  phaseTimeoutSeconds?: { solve?: number; verify?: number };
};

export type PreparedStep = {
  name: string;
  task: PreparedTask;
  minReward?: number | Record<string, number>;
  /** Public files uploaded only when this step starts. */
  workdirFiles?: string;
  setupScript?: boolean;
};
