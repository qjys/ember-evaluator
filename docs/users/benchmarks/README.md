# Benchmark Guides

> English | [中文](./README.zh-CN.md)

Choose a task guide, then an executable YAML. Profiles and source locks determine available tasks; `--dry-run` and the manifest show the actual selected range.

[User documentation](../README.md) · [Playbook configurations](../../../playbook/README.md) · [Scoring](../reference/scoring.md)

| Scenario | Guide | Quick start / configuration |
| --- | --- | --- |
| Recommendation service latency | [SGLang-GR](recommendation.md) | [North Star](../../../playbook/recommendation/north-star.yaml), [custom workload](../../../playbook/recommendation/custom.yaml) |
| Math, knowledge, and record-based QA | [Two-question quick start](../quick-start.md), [scoring](../reference/scoring.md) | [All Playbooks](../../../playbook/README.md) |
| Custom Harbor task packages | [Sources, images, networking, and verification](harbor.md) | [Custom source configuration](harbor.md#add-a-dataset-with-yaml-only) |
| Office, Code, Web, Security | [WorkBuddy](workbuddy.md) | [Scenario configurations](../../../playbook/workbuddy/) |
| Full-document retrieval and fiscal QA | [OfficeQA Pro V2](officeqa-pro-v2.md) | [Two questions with parsed JSON](../../../playbook/officeqa-pro-v2/officeqa-pro-v2-parsed-json-simpleagent.yaml), [original PDF](../../../playbook/officeqa-pro-v2/officeqa-pro-v2-original-pdf.yaml), [parsed JSON + Ray](../../../playbook/officeqa-pro-v2/officeqa-pro-v2-parsed-json-ray.yaml); excludes image-only protocol |
| Software engineering code edits | [DeepSWE](deepswe.md) | [Single-machine configuration](../../../playbook/deepswe/deepswe-simpleagent.yaml) |
| Terminal operations | [Terminal-Bench](terminalbench.md) | [4.0 quick start](../quick-start/terminalbench.md) |
| SWE-bench Verified | [Harbor execution rules](harbor.md) | [AgentBundle configuration](../../../playbook/swebench/swebench-agentbundle.yaml) |
| Model service throughput and latency | [AgentX](agentx.md) | [Performance quick start](../quick-start/agentx.md) |
| Remote SSH load testing and prefix cache | [AISBench plugin](../../../plugins/aisbench/README.md) | [SSH configuration](../../../plugins/aisbench/playbook/01-ssh.yaml) |

Each benchmark guide documents its versions, scoring, and limitations. See [FAQ](../faq/README.md) for general Docker/download issues, and [development documentation](../../development/README.en.md) for benchmark implementation and plugins.
