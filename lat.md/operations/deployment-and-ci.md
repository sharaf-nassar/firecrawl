# Deployment and CI Operations

Firecrawl ships example Kubernetes topologies and path-scoped GitHub Actions, but deployment capability and release guarantees differ by artifact.

These assets complement [[local-runtime#Local Runtime Operations|Local Runtime Operations]]. They do not inherit the local wrapper's ordering, migration, provenance, health, rollback, or secret-generation guarantees.

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

## Container publication

GitHub Actions publish API and support-service images independently when their paths change.

### API image release

`.github/workflows/deploy-image.yml` publishes the API as a versioned multi-architecture GHCR image after independent amd64 and arm64 builds.

`.github/scripts/resolve_api_image_version.py` resolves full `vX.Y.Z` Git tags, treating older `vX.Y` tags as patch zero. Main pushes default to a patch bump; manual dispatch may request patch or minor.

The workflow first pushes SHA-and-platform images. After both builds succeed, it creates or reuses the annotated release tag and publishes version, major-minor, major, and `latest` manifest aliases.

Release retries exclude tags already pointing at the same commit when selecting the base. This reuses a partially published target version instead of consuming another version.

The manual staging workflow publishes separate staging manifests without creating a Git tag. It includes current-commit tags when selecting its base, unlike production retry logic, and must not be treated as the production release record.

### Support-service images

Playwright is published for amd64 and arm64 under platform tags and a mutable `latest` manifest.

Go HTML-to-Markdown, NuQ Postgres, and the custom Redis image are each built on one runner and pushed only as `latest`. Their workflows do not create immutable release tags or multi-architecture manifests.

Browser Service and Browser Interaction Worker have no GHCR publication workflow in this checkout. The local stack builds them from source, so external deployments must supply their own image pipeline and provenance.

## CI verification boundaries

Continuous integration is a collection of path-scoped workflows rather than one repository-wide required test command.

SDK workflows and [[testing/ecosystem-integration#Ecosystem and Client Testing#Server integration matrix|the server matrix]] validate their own packages. Go HTML-to-Markdown has a build, vet, and test workflow. The NPM audit runs across selected JavaScript packages on pull requests, daily, and manually.

Image publication workflows do not declare dependencies on test workflows. Branch protection must enforce required checks; a successful image build alone does not prove unit, integration, or runtime-operation tests passed.

Browser Service, Browser Interaction Worker, Playwright package tests, and `scripts/local-firecrawl.test.mjs` have no dedicated GitHub Actions job in this checkout. See [[testing/runtime-operations#Runtime and Operations Testing#CI coverage gap]] before relying on their local suites.

### Test Suite lockfile gate

One narrow pull-request workflow protects the legacy load-test package's dependency graph.

`.github/workflows/validate-lockfiles.yml` runs only when `apps/test-suite/package.json` or its pnpm lockfile changes. It installs that package with pnpm 10 and `--frozen-lockfile`, proving the manifest resolves exactly to the committed lockfile.

The workflow does not run the package's Artillery scenario, inspect benchmark datasets, or validate other package lockfiles. Its success is dependency-integrity evidence for [[testing/ecosystem-integration#Ecosystem and Client Testing#Legacy test-suite package]], not behavioral test coverage.

## Dependency audit automation

NPM vulnerability handling separates detection from remediation.

`.github/workflows/npm-audit.yml` lets each package audit finish, records its outcome, then fails in one aggregate reporting step when any configured audit fails.

The audit matrix covers seven JavaScript roots: API, Playwright Service, both JavaScript SDK roots, Test Suite, Ingestion UI, and Test Site. It omits Browser Service and Browser Interaction Worker, so those dependency trees are outside this vulnerability gate.

After a failed audit, the remediation workflow rescans the default branch, subtracts findings already represented by marked open remediation pull requests, and may ask Claude Code to open a new reviewed pull request for uncovered advisories.

Automated remediation does not merge changes. Package overrides and ignored advisories remain package-local policy and still require engineering review.

Dependabot's package entries are effectively disabled with `open-pull-requests-limit: 0`, and its Playwright entry targets the stale `/apps/playwright-service` path rather than `playwright-service-ts`. Only the GitHub Actions entry is enabled, so Dependabot is not general package-update coverage.

## Evaluation automation

Quality evaluation runs outside the deterministic pull-request test suites.

After a successful API image workflow, `eval-prod.yml` waits two minutes and submits one benchmark run to an external evaluation API. Success proves run admission only; the workflow does not poll the benchmark result or verify that the image has reached production.

Scrape quality and OCR evaluations are opt-in through pull-request titles, bodies, or comments. After organization-membership validation, the workflow dispatches the external `firecrawl/scrape-evals` repository with exact pull-request and commit identity.

External evaluators can measure live quality but do not replace [[testing/ecosystem-integration#Ecosystem and Client Testing#Deterministic test website|deterministic fixture tests]].

## Registry maintenance

Registry cleanup is manual and deliberately narrow.

`.github/workflows/ghcr-clean.yml` deletes untagged API images while retaining the five newest. It does not apply retention to tagged releases or the other service repositories.
