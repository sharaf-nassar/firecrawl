# Ecosystem and Client Testing

Client validation remains package-owned, while required repository CI covers only the deterministic Test Site build among ecosystem packages.

SDKs, credentialed integration suites, and legacy load assets are intentional exclusions from the active-runtime gate.

## SDK test organization

Each SDK keeps tests beside its package and uses its language-native framework.

JavaScript and Python explicitly separate v2 unit tests from credentialed end-to-end suites, including crawl, batch, scrape, parse, search, map, extract, usage, and watcher behavior. Java separates environment-gated live tests from ordinary JUnit coverage.

Rust combines mocked unit tests in library modules with `tests/v2_e2e.rs`. PHP provides validation, static analysis, unit tests, and optional API-key-gated E2E groups.

.NET, Go, Ruby, and Elixir currently emphasize package-local unit and model/transport tests. Package-local success does not imply live endpoint parity.

### Repository CI exclusion

SDKs are outside required repository CI because the active gate is not a complete polyglot compatibility or release matrix.

No SDK workflow receives repository secrets, connects through Tailscale, contacts a live API, publishes a package, or creates a release. Maintainers select native offline and credentialed suites for each changed client.

### Package-specific gaps

Python contains extensive synchronous, asynchronous, watcher, request-shaping, and E2E tests, but none are part of required repository CI.

Go and Elixir also keep meaningful package tests outside the required gate.

The Go suite covers wire serialization, multipart parse transport, input validation, and monitor models. The Elixir ExUnit suite covers authentication sources, option validation, enum handling, file parsing, error mapping, and generated request shapes.

Changes to these clients need explicit package-native validation. A green active-runtime gate is not evidence that SDK tests passed.

## Ingestion UI coverage gap

The standalone ingestion UI has no functional test harness or required CI build gate.

`apps/ui/ingestion-ui/package.json` defines development, build, lint, and preview scripts but no test script, and the package contains no checked-in test files.

UI changes therefore require explicit local build and lint validation plus manual browser checks. Required CI does not prove rendering, interaction, responsive behavior, dependency policy, or API compatibility.

## Deterministic test website

`apps/test-site` is a static Astro site whose controlled pages, links, assets, sitemap, robots response, and metadata make scrape and crawl assertions repeatable.

The site includes blog navigation, static PDF and JSON assets, Unicode content, and a product page with stable schema.org JSON-LD. [[apps/test-site/src/consts.ts#SITE_TITLE]] anchors its public fixture identity.

Fixture values are contracts with server tests and should change only with their assertions.

Repository CI installs and builds the site to protect its static fixture contract. It does not serve the site against API snippet matrices, external engines, queues, or credentialed providers.

### Fixture invariants

Test-site routes must remain deterministic and internally crawlable.

- `/product` keeps stable title, price, currency, availability, and product identity for product-format assertions.
- `/example.pdf`, `/example-long.pdf`, and `/example.json` remain local parser and JSON targets.
- Blog, about, and index links provide bounded discovery structure.
- `robots.txt` points to the generated sitemap for robots and sitemap behavior.
- The configured site URL defaults to the local preview and can be overridden for deployment.

The test site contains no production content and should not acquire external state, authentication, or nondeterministic rendering.

## Server integration boundary

Repository CI does not assemble the historical self-hosted server integration matrix.

API snippet harnesses can provision Redis, RabbitMQ, Playwright, SearXNG, PostgreSQL or FoundationDB queue routing, native helpers, and Test Site. Those service-backed commands remain available for targeted local validation.

Conditional test helpers gate cases on available AI, browser, product, proxy, and deployment capabilities. A skipped test in one matrix cell is not evidence that the feature is unsupported; review its capability gate.

Because these harnesses can require privileged services, credentials, or sensitive logs, they are outside the secret-free required gate. Their observability still depends on [[lat.md/api/trust-and-operations#Trust, Billing, and Operations#Observability|service logging hygiene]].

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

## External release confidence

Repository automation does not publish clients or establish release readiness for SDK packages.

Before an external or manual client release, verify its native build, offline tests, relevant credentialed suite, package version source, and public README. Confirm generated Elixir changes originate from the OpenAPI generator and review external consumers when the wire contract changes.
