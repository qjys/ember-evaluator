import type { PluginCliRegistrar } from "ember-evaluator";

export function registerCli(cli: PluginCliRegistrar): void {
  cli.addCommand({
    name: "tracer",
    description: "Manage the tracer Collector (serve, stop, status, logs)",
    async run(argv, io, signal) {
      const { runPluginCli } = await import("./cli.js");
      return runPluginCli(argv, io, signal);
    },
  });
  cli.extendCommand("run", {
    flags: "--tracer [url]",
    description: "Mirror the run into tracer; the optional URL overrides the Collector endpoint",
    configure(value, activation) {
      activation.enable(typeof value === "string" ? { url: value } : {});
    },
  });
}
