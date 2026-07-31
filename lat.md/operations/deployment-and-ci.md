# Deployment and CI Operations

Firecrawl keeps example Kubernetes topologies, while repository automation is limited to validation on GitHub-hosted runners.

The examples complement [[local-runtime#Local Runtime Operations|Local Runtime Operations]]. CI does not deploy, publish, evaluate, mutate registries, or call secret-bearing external services.

## Kubernetes examples

The repository contains a direct manifest set and a configurable Helm chart for self-hosted Kubernetes.

`examples/kubernetes/cluster-install/` is a small, manually applied reference. `examples/kubernetes/firecrawl-helm/` is the broader topology and should be rendered with deployment-specific values before installation.

### Workload topology

The Helm chart separates API admission, queue execution, extraction, NuQ execution, prefetching, rendering, and infrastructure into distinct Deployments.

The default topology contains API, queue worker, extract worker, NuQ worker, NuQ prefetch worker, Playwright, Redis, RabbitMQ, and NuQ Postgres. API, Playwright, Redis, RabbitMQ, and NuQ Postgres use ClusterIP services.

API probes `/v0/health/liveness` and `/v0/health/readiness`. Workers use their process health ports, while Playwright probes `/health`; these probes establish process readiness, not end-to-end scrape success.

Shared configuration is rendered into one ConfigMap and one Secret. `config.extra` and `secret.extra` extend those environment contracts without changing templates.

### Capability boundary

Kubernetes examples implement the basic self-hosted stack, not the hardened local browser topology or hosted product.

They do not deploy Browser Service, Browser Interaction Worker, its model egress proxy, application Postgres, MinIO artifact storage, or local migration and initialization jobs. Browser interaction, retained profiles, replay reconciliation, and local artifact retention therefore require separate deployment work.

The chart provides no Ingress, NetworkPolicy, autoscaler, PodDisruptionBudget, certificate management, or external secret controller. Operators own those cluster boundaries.

### Persistence and production values

Checked-in chart values are examples and are unsafe as production defaults.

NuQ Postgres persistence and global resource requests are disabled by default. Redis and RabbitMQ also have no persistent volume in the chart, so pod replacement loses their local state.

The default values use mutable `latest` images, example database credentials, and empty application secrets. NuQ credentials are also interpolated into ConfigMap connection URLs. Production rendering must supply restricted secrets, immutable images, persistent storage, resources, and registry access.

The `dev` and `prod` overlays are placeholders containing no overrides. Their names do not confer environment hardening.

## Repository CI

One validation-only workflow provides a stable repository gate for active runtime surfaces.

`.github/workflows/ci.yml` runs for pull requests, pushes to `main`, and manual dispatch. Every job uses GitHub-hosted `ubuntu-24.04`, has only `contents: read` permission, and receives no repository secrets.

The workflow has no path filters. Every eligible event exercises the same required validation set, avoiding branch-protection drift caused by checks that appear only for selected paths.

### Active-runtime validation

CI validates the build and local-operation contracts needed by this repository's active runtime.

The jobs cover repository and local-script contracts, the API Docker image build, Browser Service test and runtime Docker targets, Playwright Service install/build/test, and Test Site install/build.

Docker builds are buildability checks only. CI does not log in to a registry, push images, create tags, or promote an artifact.

A stable aggregate job depends on every validation job and is the intended branch-protection target. See [[testing/runtime-operations#Runtime and Operations Testing#CI coverage boundary]] for package-level coverage and exclusions.

### Automation exclusions

Repository automation intentionally stops at deterministic validation.

There are no deployment, staging, package-publication, release, evaluation-dispatch, registry-cleanup, vulnerability-remediation, or archived workflows. CI has no custom-runner references and no secret-dependent jobs.

SDKs, the legacy load suite, hosted integrations, and other optional ecosystems remain outside required CI. Their owning package commands or external release processes must supply any validation beyond the active runtime gate.

## Dependency updates

Dependabot tracks only the action dependencies needed by the validation workflow.

GitHub Actions updates run weekly and are grouped into one update set. Package-manager ecosystems are intentionally excluded because repository CI does not provide a complete cross-package release or compatibility gate.
