use anyhow::{Context, Result};
use firecrawl_browser_execution_adapter::config::AdapterConfig;
use firecrawl_browser_execution_adapter::jobs::AdapterService;

#[tokio::main]
async fn main() -> Result<()> {
    firecrawl_browser_execution_adapter::broker_client::validate_installed_contract()
        .context("installed broker contract rejected")?;
    let config = AdapterConfig::from_environment().context("adapter configuration rejected")?;
    AdapterService::new(config)
        .context("adapter startup rejected")?
        .serve()
        .await
        .context("adapter service failed")
}
