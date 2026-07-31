package firecrawl

// Version is the SDK version. It is used as the source of truth for release
// tags (apps/go-sdk/v{Version}) and as the User-Agent suffix on API requests.
//
// Note: this version tracks the SDK release cycle, not the Firecrawl API
// version. The SDK targets the Firecrawl v2 API.
//
// Bump this when preparing a new release. Tags and releases are created
// manually or by external release tooling using the monorepo-prefixed version.
const Version = "1.7.1"
