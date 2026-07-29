# Repository Ecosystem

Firecrawl is a polyglot service repository with independently built applications, SDKs, fixtures, examples, deployment assets, and external-project pointers.

The repository groups related delivery surfaces under one history but does not impose one root package manager or synchronized release train.

## Top-level organization

Top-level directories distinguish production services, client libraries, operational assets, learning material, and project knowledge.

| Area | Responsibility |
| --- | --- |
| `apps/api` | Main TypeScript API and worker process, plus native and Go conversion helpers. |
| `apps/browser-*`, `apps/playwright-service-ts` | Browser execution and interaction services. |
| `apps/nuq-postgres`, `apps/redis`, `apps/go-html-to-md-service` | Queue, persistence, cache, and conversion infrastructure. |
| `apps/*-sdk` | Independently packaged language clients described by [[sdk-architecture]]. |
| `apps/ui/ingestion-ui` | Legacy client-side integration template described by [[ui-and-extensions#Ingestion UI template]]. |
| `apps/test-site`, `apps/test-suite` | Deterministic fixtures and legacy load/evaluation assets described by [[ecosystem-integration]]. |
| `examples` | Copyable consumer recipes, notebooks, application samples, and Kubernetes deployment examples described by [[examples]]. |
| `docs/superpowers` | Time-stamped implementation plans and design specifications for selected infrastructure work. |
| `firecrawl-cli*`, `firecrawl-skills`, `firecrawl-workflows` | Locator stubs for separately maintained ecosystem repositories. |
| `compose*.yaml`, `docker-compose.yaml`, `host` | Local and self-hosted service composition. |

This is an ownership map, not a dependency graph. Runtime relationships are defined by service configuration and compose manifests, while publication relationships are defined by package workflows.

## Independent package roots

There is no repository-root `package.json`, `pnpm-workspace.yaml`, Cargo workspace, or equivalent polyglot build manifest.

Node applications carry their own `package.json` and usually their own `pnpm-lock.yaml`. Python, Go, Rust, Java, .NET, Elixir, PHP, and Ruby packages use native manifests inside their application directories.

Commands must run from the owning package directory unless a documented wrapper changes directories. One package's lockfile, runtime version, or dependency override does not automatically apply to another.

The root `.gitmodules` still names two legacy Go SDK submodule paths, but the repository index contains no gitlinks for them. The maintained Go client is ordinary source under `apps/go-sdk`; submodule initialization does not fetch its implementation.

### JavaScript workspace islands

Some Node packages use local pnpm workspaces, but those are package islands rather than one monorepo-wide workspace.

`apps/api`, `apps/js-sdk`, and `apps/js-sdk/firecrawl` each carry local workspace metadata. The SDK's outer `apps/js-sdk` package is an examples harness; the published implementation and lockfile live under `apps/js-sdk/firecrawl`.

`apps/ui/ingestion-ui`, `apps/test-site`, `apps/test-suite`, browser services, and the Playwright service remain separate installs with separate lockfiles.

## Build and CI routing

GitHub Actions routes tests, builds, deployments, and publications by application path.

Dedicated SDK test workflows cover JavaScript, Go, Java, PHP, Ruby, Rust, and .NET with package-native checks. Python and Elixir do not have equivalent standalone test workflows in this checkout, so their publication paths must not be treated as the same validation gate.

SDK publication workflows read versions from native manifests, then publish to npm, PyPI, Maven Central, NuGet, RubyGems, crates.io, Hex, or Go module tags. PHP first mirrors a subtree to its external repository and then notifies Packagist.

The server test workflow composes Node, Rust native code, Go conversion code, browser services, queues, search, and the deterministic test site. Deployment workflows are service-specific rather than a global monorepo deploy.

`validate-lockfiles.yml` currently validates only `apps/test-suite/pnpm-lock.yaml`; other lockfiles are enforced by their owning install or CI paths, not by that workflow.

## Documentation strata

Repository documentation serves different lifetimes and audiences.

The root README is product onboarding and cross-client quick start. Package READMEs explain local installation and usage. Native manifests and current package source are authoritative when a root snippet uses older coordinates or method names.

`LOCAL_DEPLOYMENT.md` documents the current repository-managed Compose wrapper and its data-preserving lifecycle. `SELF_HOST.md` is general self-host onboarding, while `CONTRIBUTING.md` describes a separate manual developer setup; neither is authority for the wrapper's present topology.

`docs/superpowers/specs` and `docs/superpowers/plans` preserve dated design and implementation artifacts. `lat.md` records durable architecture, behavior, and test intent.

Dated plans are historical evidence, not automatically current contracts. Durable decisions discovered there should be checked against source and promoted into the relevant `lat.md` concept instead of linking all future work to an old execution plan.

## Examples

The `examples` tree demonstrates consumer composition rather than providing a supported shared library.

Examples cover Python and JavaScript SDK use, structured extraction, crawling, research and enrichment with multiple model providers, notebooks, complete app references, and Kubernetes manifests including Helm. Their lifecycle and safety constraints are described by [[examples]].

### Licensing boundaries

Repository location does not establish one license for every deliverable.

The repository root is AGPL-3.0, while SDK manifests, package metadata, and local license files commonly declare MIT terms; the ingestion UI also carries its own MIT license. Consumers and release automation must use the owning package's included legal metadata.

Not every SDK subtree carries the same set of legal files, and legacy metadata can disagree with newer manifests. Packaging changes should verify the license embedded in the published artifact rather than infer it from another SDK or the root.

## Change ownership

Changes should remain inside the smallest owning package and update every independent consumer boundary they affect.

An API contract change may require server implementation, SDK model updates, CLI coordination, README examples, and client E2E coverage. A local service change may instead affect compose configuration and server tests without any SDK release.

`CODEOWNERS` is selective and has no catchall. It omits newer browser services, operational scripts and configuration, several SDKs, and `lat.md`, so an unmatched path has no owner assigned by that file.

The repository Husky hook is API-local: it runs `knip` and `lint-staged` from `apps/api`. It neither runs the server integration matrix nor defines server CI authority.

Do not assume a root install, root version bump, or root build validates the tree. Use path-scoped workflows and manifests to determine the required verification.
