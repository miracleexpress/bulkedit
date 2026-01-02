// @ts-check
const { join } = require("path");
const { readFileSync } = require("fs");
const express = require("express");
const serveStatic = require("serve-static");
const { shopifyApi, LATEST_API_VERSION } = require("@shopify/shopify-api");
const { shopifyApp } = require("@shopify/shopify-app-express");
const { PostgreSQLSessionStorage } = require("@shopify/shopify-app-session-storage-postgresql");
const { restResources } = require("@shopify/shopify-api/rest/admin/2023-04");

const PORT = parseInt(process.env.PORT || "8081", 10);
const STATIC_PATH = process.env.NODE_ENV === "production"
    ? join(__dirname, "../dist/client")
    : join(__dirname, "../web");

// Guardrails
const MAX_PRODUCTS_PER_RUN = parseInt(process.env.MAX_PRODUCTS_PER_RUN || "500", 10);
const MAX_MEDIA_DELETES_PER_RUN = parseInt(process.env.MAX_MEDIA_DELETES_PER_RUN || "5000", 10);

// Initialize Shopify App
const shopify = shopifyApp({
    api: {
        apiKey: process.env.SHOPIFY_API_KEY,
        apiSecretKey: process.env.SHOPIFY_API_SECRET,
        scopes: (process.env.SCOPES || "read_products,write_products").split(","),
        hostName: process.env.HOST ? process.env.HOST.replace(/https?:\/\//, "") : "localhost",
        apiVersion: LATEST_API_VERSION,
        restResources,
    },
    auth: {
        path: "/api/auth",
        callbackPath: "/api/auth/callback",
    },
    webhooks: {
        path: "/api/webhooks",
    },
    sessionStorage: new PostgreSQLSessionStorage(new URL(process.env.DATABASE_URL || "")),
});

const app = express();

// Set up Shopify authentication and webhook handling
app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(
    shopify.config.auth.callbackPath,
    shopify.auth.callback(),
    shopify.redirectToShopifyOrAppRoot()
);
app.post(
    shopify.config.webhooks.path,
    shopify.processWebhooks({ webhookHandlers: {} })
);

// All endpoints after this point will require an active session
app.use("/api/*", shopify.validateAuthenticatedSession());
app.use(express.json());

// --- HELPER FUNCTIONS ---

const buildProductQuery = (tag) => `tag:${tag}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchProducts(session, tag, first = 25, cursor = null) {
    const client = new shopify.api.clients.Graphql({ session });
    const response = await client.query({
        data: `
      query ($first: Int!, $cursor: String, $query: String!) {
        products(first: $first, after: $cursor, query: $query) {
          edges {
            node {
              id
              title
              handle
              media(first: 100) {
                edges {
                  node {
                    id
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    `,
        variables: {
            first,
            cursor,
            query: buildProductQuery(tag),
        },
    });
    return response.body.data.products;
}

// Counts media recursively for a product without deleting
async function countMediaForProduct(session, productId, initialMedia) {
    let count = initialMedia.edges.length;
    let hasNext = initialMedia.pageInfo.hasNextPage;
    let cursor = initialMedia.pageInfo.endCursor;

    // Safety break to prevent infinite loops on massive products during dry run
    const MAX_PAGES = 50;
    let page = 0;

    while (hasNext && page < MAX_PAGES) {
        page++;
        const client = new shopify.api.clients.Graphql({ session });
        const response = await client.query({
            data: `
        query ($productId: ID!, $cursor: String) {
          product(id: $productId) {
            media(first: 100, after: $cursor) {
              edges { node { id } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      `,
            variables: { productId, cursor }
        });

        const media = response.body.data.product.media;
        count += media.edges.length;
        hasNext = media.pageInfo.hasNextPage;
        cursor = media.pageInfo.endCursor;
    }
    return count;
}

// Deletes media for a product
async function deleteMediaForProduct(session, productId, initialMedia) {
    // Collect ALL media IDs first
    let allMediaIds = initialMedia.edges.map(e => e.node.id);
    let hasNext = initialMedia.pageInfo.hasNextPage;
    let cursor = initialMedia.pageInfo.endCursor;
    let deletedCount = 0;
    let errors = [];

    const MAX_PAGES = 50;
    let page = 0;

    // Fetch rest
    while (hasNext && page < MAX_PAGES) {
        page++;
        const client = new shopify.api.clients.Graphql({ session });
        const response = await client.query({
            data: `
          query ($productId: ID!, $cursor: String) {
            product(id: $productId) {
              media(first: 100, after: $cursor) {
                edges { node { id } }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        `,
            variables: { productId, cursor }
        });
        const media = response.body.data.product.media;
        allMediaIds.push(...media.edges.map(e => e.node.id));
        hasNext = media.pageInfo.hasNextPage;
        cursor = media.pageInfo.endCursor;
    }

    // Delete in chunks
    const CHUNK_SIZE = 50;
    for (let i = 0; i < allMediaIds.length; i += CHUNK_SIZE) {
        const chunk = allMediaIds.slice(i, i + CHUNK_SIZE);
        if (chunk.length === 0) continue;

        try {
            const client = new shopify.api.clients.Graphql({ session });
            const deleteResponse = await client.query({
                data: `
            mutation productDeleteMedia($mediaIds: [ID!]!, $productId: ID!) {
              productDeleteMedia(mediaIds: $mediaIds, productId: $productId) {
                deletedMediaIds
                mediaUserErrors {
                  field
                  message
                }
              }
            }
          `,
                variables: {
                    productId: productId,
                    mediaIds: chunk
                }
            });

            const result = deleteResponse.body.data.productDeleteMedia;
            if (result.deletedMediaIds) {
                deletedCount += result.deletedMediaIds.length;
            }
            if (result.mediaUserErrors && result.mediaUserErrors.length > 0) {
                errors.push(...result.mediaUserErrors.map(e => e.message));
            }

            // Throttle
            await sleep(300);

        } catch (err) {
            console.error("Delete error", err);
            errors.push(err.message);
        }
    }

    return { deletedCount, errors };
}

// --- API ROUTES ---

// POST /api/dry-run
app.post("/api/dry-run", async (req, res) => {
    try {
        const { tag } = req.body;
        if (!tag) return res.status(400).json({ error: "Tag required" });

        const session = res.locals.shopify.session;
        let hasNext = true;
        let cursor = null;
        let productsFound = 0;
        let mediaFound = 0;
        let items = [];

        // In Dry Run, we fetch ALL to give a complete summary, 
        // BUT we limit total traversal to avoid timeout on huge catalogs.
        // User requested "Dry run: ... kaç ürün bulunduğunu raporla".
        // We will cap at MAX_PRODUCTS_PER_RUN * 2 to result in a reasonable preview.
        const SAFETY_CAP = 1000;

        while (hasNext && productsFound < SAFETY_CAP) {
            const productsData = await fetchProducts(session, tag, 50, cursor); // fetch 50 at a time

            for (const edge of productsData.edges) {
                const p = edge.node;
                const mCount = await countMediaForProduct(session, p.id, p.media);

                productsFound++;
                mediaFound += mCount;

                // Only add detailed items if they have media, to keep payload clean
                if (mCount > 0) {
                    items.push({
                        productId: p.id,
                        title: p.title,
                        handle: p.handle,
                        mediaFound: mCount,
                        status: "DRY"
                    });
                }
            }

            hasNext = productsData.pageInfo.hasNextPage;
            cursor = productsData.pageInfo.endCursor;
        }

        res.json({
            summary: { productsFound, mediaFound, capped: productsFound >= SAFETY_CAP },
            items
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// POST /api/execute
app.post("/api/execute", async (req, res) => {
    try {
        const { tag, confirmText, confirmTag, cursor, batchSize = 25 } = req.body;

        // 1. Strict Validation
        if (confirmText !== "CONFIRM") {
            return res.status(400).json({ error: "Invalid confirmation text" });
        }
        if (confirmTag !== tag) {
            return res.status(400).json({ error: "Confirmation tag does not match" });
        }

        const session = res.locals.shopify.session;
        const effectiveBatchSize = Math.min(batchSize, 50); // Hard cap batch size

        // 2. Fetch Batch
        const productsData = await fetchProducts(session, tag, effectiveBatchSize, cursor || null);

        let batchProcessedProducts = 0;
        let summaryDelta = {
            productsProcessed: 0,
            mediaFound: 0,
            mediaDeleted: 0,
            errors: 0
        };
        let items = [];
        let stoppedReason = null;

        // 3. Process Batch
        for (const edge of productsData.edges) {
            const p = edge.node;

            // Initial Count (fast check from fetch)
            const initialMediaCount = p.media.edges.length; // Approximate, might have more pages

            // Execute Delete
            // note: countMediaForProduct is not needed here, deleteMediaForProduct handles fetching all.
            const { deletedCount, errors } = await deleteMediaForProduct(session, p.id, p.media);

            batchProcessedProducts++;
            summaryDelta.productsProcessed++;
            summaryDelta.mediaDeleted += deletedCount;
            // For stats, 'mediaFound' is at least what we deleted. 
            // We don't do a separate pre-count to save time.
            summaryDelta.mediaFound += deletedCount;

            if (errors.length > 0) {
                summaryDelta.errors += errors.length;
            }

            items.push({
                productId: p.id,
                title: p.title,
                handle: p.handle,
                mediaFound: deletedCount, // Effective found
                mediaDeleted: deletedCount,
                status: errors.length > 0 ? "PARTIAL_ERROR" : "DELETED",
                errors: errors
            });

            // 4. Check Global Guardrails (Optional: Requires tracking global state, 
            // but here we are stateless per request. We rely on the Frontend to stop calling
            // if total exceeds. Backend enforces safety per-batch mostly.)
            // However, if a single batch hits the MAX_MEDIA_DELETES_PER_RUN (unlikely for 25 products unless they have 200 images each), 
            // we could stop early.
            if (summaryDelta.mediaDeleted >= MAX_MEDIA_DELETES_PER_RUN) {
                stoppedReason = "MAX_MEDIA_DELETES_PER_RUN exceeded in this batch";
                break;
            }
        }

        // 5. Determine Next State
        const hasNext = productsData.pageInfo.hasNextPage;
        const nextCursor = (hasNext && !stoppedReason) ? productsData.pageInfo.endCursor : null;
        const done = !nextCursor || !!stoppedReason;

        res.json({
            nextCursor,
            done,
            batchProcessedProducts,
            summaryDelta,
            items,
            stoppedReason
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
});

// Serve frontend in production
app.use(serveStatic(STATIC_PATH, { index: false }));

app.use("/*", shopify.ensureInstalledOnShop(), async (_req, res, _next) => {
    return res
        .status(200)
        .set("Content-Type", "text/html")
        .send(readFileSync(join(STATIC_PATH, "index.html")));
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});