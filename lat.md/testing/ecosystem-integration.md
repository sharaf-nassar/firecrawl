# Ecosystem and Client Testing

Client validation is package-scoped, while server integration tests use a deterministic local website and a separate legacy load-test package.

The testing layout reflects independent SDK release units and a service matrix rather than one repository-wide test runner.

## SDK test organization

Each SDK keeps tests beside its package and uses its language-native framework.

JavaScript and Python explicitly separate v2 unit tests from credentialed end-to-end suites, including crawl, batch, scrape, parse, search, map, extract, usage, and watcher behavior. Java separates environment-gated live tests from ordinary JUnit coverage.

Rust combines mocked unit tests in library modules with `tests/v2_e2e.rs`; CI runs formatting, build, clippy, mocked library tests, and example compilation but does not run the credentialed E2E file. PHP runs validation, static analysis, unit tests, and optional API-key-gated E2E groups.

.NET, Go, Ruby, and Elixir currently emphasize package-local unit and model/transport tests. Their path-scoped workflows do not imply live endpoint parity.

### JavaScript CI

The JavaScript SDK pull-request workflow builds the published package and runs its configured v2 E2E Jest glob.

It connects through Tailscale and supplies the optional ID multiplexer URL. Unit tests have a separate package script and are not invoked by the current workflow's `pnpm run test` command.

### Python CI gap

Python contains extensive synchronous, asynchronous, watcher, request-shaping, and E2E tests but has no dedicated `test-python-sdk.yml` workflow in this checkout.

Its publish workflow builds and uploads after version checks. Maintainers must not infer test execution from publication; Python test coverage needs an explicit local or external runner until a workflow is added.

### Go and Elixir CI gaps

Go and Elixir keep meaningful package tests that current workflows do not execute.

The Go suite covers wire serialization, multipart parse transport, input validation, and monitor models. `test-go-sdk.yml` and `publish-go-sdk.yml` run build and vet only; neither invokes `go test ./...`.

Elixir's ExUnit suite covers authentication sources, option validation, enum handling, file parsing, error mapping, and generated request shapes. Its combined regeneration and Hex publication workflow installs dependencies but never invokes `mix test`.

Changes to either client therefore need an explicit local package test run. A green path-scoped workflow or successful publication is not evidence that the checked-in tests passed.

## Ingestion UI coverage gap

The standalone ingestion UI has dependency scanning but no functional test harness or CI build gate.

`apps/ui/ingestion-ui/package.json` defines development, build, lint, and preview scripts but no test script, and the package contains no checked-in test files. GitHub Actions includes it in the NPM audit only.

UI changes therefore require explicit local build and lint validation plus manual browser checks. The audit job proves dependency policy, not rendering, interaction, responsive behavior, or API compatibility.

## Deterministic test website

`apps/test-site` is a static Astro site whose controlled pages, links, assets, sitemap, robots response, and metadata make scrape and crawl assertions repeatable.

The site includes blog navigation, static PDF and JSON assets, Unicode content, and a product page with stable schema.org JSON-LD. [[apps/test-site/src/consts.ts#SITE_TITLE]] anchors its public fixture identity.

Fixture values are contracts with server tests and should change only with their assertions.

The server CI builds and serves the site at `127.0.0.1:4321`, exports it as `TEST_SUITE_WEBSITE`, and then runs API snippet tests across fetch or Playwright, proxy settings, SearXNG, AI, and queue backend variants.

### Fixture invariants

Test-site routes must remain deterministic and internally crawlable.

- `/product` keeps stable title, price, currency, availability, and product identity for product-format assertions.
- `/example.pdf`, `/example-long.pdf`, and `/example.json` remain local parser and JSON targets.
- Blog, about, and index links provide bounded discovery structure.
- `robots.txt` points to the generated sitemap for robots and sitemap behavior.
- The configured site URL defaults to the local preview and can be overridden for deployment.

The test site contains no production content and should not acquire external state, authentication, or nondeterministic rendering.

## Server integration matrix

`.github/workflows/test-server.yml` is the main self-hosted integration harness.

It provisions Redis and RabbitMQ, builds native Rust and Go helpers, optionally starts Playwright, configures SearXNG and proxy credentials, selects PostgreSQL or FoundationDB-backed queue routing, serves the test site, and runs `apps/api` snippet tests.

Conditional test helpers gate cases on available AI, browser, product, proxy, and deployment capabilities. A skipped test in one matrix cell is not evidence that the feature is unsupported; review its capability gate.

The same workflow runs a separate NuQ FoundationDB core job against a real single-node FDB container. That job exercises the narrow FDB queue implementation independently from the full snippet matrix.

Diagnostics parse JUnit into the job log and step summary, then upload API, worker, SearXNG, and Playwright logs as an ordinary zip artifact. The workflow specifies no redaction, encryption, or explicit retention for that archive.

Test observability therefore depends on [[lat.md/api/trust-and-operations#Trust, Billing, and Operations#Observability|service logging hygiene]], and downloaded artifacts must be treated as sensitive.

## Legacy test-suite package

`apps/test-suite` currently contains Artillery load configuration, historical scrape and crawl datasets, and an index benchmark notebook.

Its only package script is `test:load`. `load-test.yml` targets a legacy staging `/v0` API, embeds a placeholder key, and currently enables a crawl scenario with staged arrival rates and status polling.

The package README is stale: it describes Playwright and `npm run test`, but neither a Playwright dependency nor a `test` script exists in the current manifest. Treat package metadata and checked-in scenarios as authoritative until the README is reconciled.

### Evaluation data

The JSON datasets record expected answers and expected crawl inclusion or exclusion for public websites.

Because external pages, paywalls, and bot defenses change, these are benchmark inputs rather than deterministic unit fixtures. New reliability assertions should prefer [[ecosystem-integration#Deterministic test website]] when the behavior can be represented locally.

## Integration test selection

Choose the narrowest test layer that exercises the contract being changed.

- Use SDK unit tests for serialization, validation, aliases, pagination, error mapping, and transport behavior.
- Use credentialed SDK E2E tests for published client-to-API interoperability and watcher/job flows.
- Use server snippet tests with `apps/test-site` for self-hosted routes and service composition.
- Use Artillery or benchmark datasets for load and external-site quality, accepting environmental variability.

No one layer establishes full compatibility. API changes that affect wire shapes require both server contract coverage and targeted client validation.

## Release confidence

Path-scoped CI protects package boundaries, but publication workflows and test workflows are not uniformly coupled.

Before releasing a client, verify its native build, offline tests, any credentialed suite its workflow omits, package version source, and public README. Confirm generated Elixir changes originate from the OpenAPI generator and review external CLI or skill consumers when the wire contract changes.
