import { logger } from "./logger";
import crypto from "crypto";
import { getArtifactStore } from "./artifacts";
import type { ArtifactStore } from "./artifacts";

type PdfCacheProvider = "runpod" | "firepdf";

// Cache shape — markdown/html are required; pagesProcessed is optional so
// pre-existing entries (written before the field existed) round-trip cleanly
// and the caller can fall back to its own page-count signal on a stale hit.
type CachedPdfResult = {
  markdown: string;
  html: string;
  pagesProcessed?: number;
};

const PROVIDER_PREFIXES: Record<PdfCacheProvider, string> = {
  runpod: "pdf-cache-v2/",
  firepdf: "pdf-cache-firepdf/",
};

export function createPdfCacheKey(pdfContent: string | Buffer): string {
  return crypto.createHash("sha256").update(pdfContent).digest("hex");
}

export async function savePdfResultToCache(
  pdfContent: string,
  result: CachedPdfResult,
  provider: PdfCacheProvider = "runpod",
  variant?: string,
): Promise<string | null> {
  let store: ArtifactStore | null = null;
  try {
    store = getArtifactStore();
    if (!store) {
      return null;
    }

    const prefix = PROVIDER_PREFIXES[provider];
    const cacheKey = createPdfCacheKey(pdfContent);
    const objectKey = variant ? `${cacheKey}-${variant}` : cacheKey;
    await store.put({
      key: `${prefix}${objectKey}.json`,
      body: JSON.stringify(result),
      contentType: "application/json",
      metadata: {
        source: `${provider}_pdf_conversion`,
        cache_type: "pdf_markdown",
        created_at: new Date().toISOString(),
      },
    });

    logger.info(`Saved PDF result to GCS cache`, {
      cacheKey,
      provider,
    });

    return cacheKey;
  } catch (error) {
    logger.error(`Error saving PDF result to GCS cache`, {
      error,
      provider,
    });
    if (store?.provider === "minio") throw error;
    return null;
  }
}

export async function getPdfResultFromCache(
  pdfContent: string,
  provider: PdfCacheProvider = "runpod",
  variant?: string,
): Promise<CachedPdfResult | null> {
  let store: ArtifactStore | null = null;
  try {
    store = getArtifactStore();
    if (!store) {
      return null;
    }

    const prefix = PROVIDER_PREFIXES[provider];
    const cacheKey = createPdfCacheKey(pdfContent);
    const objectKey = variant ? `${cacheKey}-${variant}` : cacheKey;
    const content = await store.get(`${prefix}${objectKey}.json`);
    if (content === null) return null;
    const result = JSON.parse(content.toString());

    logger.info(`Retrieved PDF result from GCS cache`, {
      cacheKey,
      provider,
    });

    return {
      ...result,
    };
  } catch (error) {
    logger.error(`Error retrieving PDF result from GCS cache`, {
      error,
      provider,
    });
    if (store?.provider === "minio") throw error;
    return null;
  }
}
