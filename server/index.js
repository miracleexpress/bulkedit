import 'dotenv/config';
import express from "express";
import { dirname, join } from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import serveStatic from "serve-static";
import shopify from "./shopify.js";
import { GraphqlClient } from '@shopify/shopify-api';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT || "8081", 10);
const MAX_PRODUCTS_PER_RUN = parseInt(process.env.MAX_PRODUCTS_PER_RUN || "500", 10);
const MAX_MEDIA_DELETES_PER_RUN = parseInt(process.env.MAX_MEDIA_DELETES_PER_RUN || "5000", 10);

const app = express();

// Shopify Auth
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

// All API routes must be authenticated
app.use("/api/*", shopify.validateAuthenticatedSession());
app.use(express.json());

// Helper for sleeping
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const QUERY_PRODUCTS = `
  query getProducts($query: String!, $cursor: String) {
    products(first: 50, after: $cursor, query: $query) {
      edges {
        node {
          id
          title
          handle
          media(first: 50) {
            edges {
              node {
                id
                mediaContentType
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
`;

const MUTATION_DELETE_MEDIA = `
  mutation deleteMedia($productId: ID!, $mediaIds: [ID!]!) {
    productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
      deletedMediaIds
      deletedProductImageIds
      userErrors {
        field
        message
      }
    }
  }
`;

// Helper to handle Media Pagination if > 50
// NOTE: For simplicity in this specific "bulk" script, we fetch first 50. 
// If a product has > 50 images, we might miss some in strict implementation, 
// but prompt allows pagination on media. Let's add simple media pagination loop if needed.
async function getAllMediaForProduct(client, product) {
  let allMedia = [...product.media.edges];
  let hasNext = product.media.pageInfo.hasNextPage;
  let cursor = product.media.pageInfo.endCursor;

  while (hasNext) {
    const query = `
      query getProductMedia($id: ID!, $cursor: String) {
        product(id: $id) {
          media(first: 50, after: $cursor) {
            edges { node { id mediaContentType } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    `;
    const response = await client.query({
      data: { query, variables: { id: product.id, cursor } },
    });
    const data = response.body.data.product.media;
    allMedia = allMedia.concat(data.edges);
    hasNext = data.pageInfo.hasNextPage;
    cursor = data.pageInfo.endCursor;
    // Safety sleep
    await sleep(200);
  }
  return allMedia;
}

// Core Logic Handler
async function handleProcess(req, res, dryRun) {
  const { tag, confirmText, confirmTag } = req.body;

  // Validation
  if (!tag) return res.status(400).json({ error: "Tag is required" });
  if (!dryRun) {
    if (confirmText !== "CONFIRM") return res.status(400).json({ error: "Confirmation text must be 'CONFIRM'" });
    if (confirmTag !== tag) return res.status(400).json({ error: "Confirmation tag does not match" });
  }

  const session = res.locals.shopify.session;
  const client = new shopify.api.clients.Graphql({ session });

  const summary = {
    productsFound: 0,
    productsProcessed: 0,
    mediaFound: 0,
    mediaDeleted: 0,
    errors: 0,
  };
  const items = [];

  try {
    let hasNextPage = true;
    let cursor = null;
    let productsProcessedCount = 0;
    let mediaDeletedCount = 0;

    console.log(`Starting ${dryRun ? "DRY RUN" : "EXECUTE"} for tag: ${tag}`);

    // Loop through products
    while (hasNextPage && productsProcessedCount < MAX_PRODUCTS_PER_RUN) {

      if (!dryRun && mediaDeletedCount >= MAX_MEDIA_DELETES_PER_RUN) {
        console.log("Max media delete limit reached.");
        break;
      }

      const response = await client.query({
        data: {
          query: QUERY_PRODUCTS,
          variables: {
            query: `tag:${tag}`,
            cursor: cursor,
          },
        },
      });

      // Handle GraphQL errors
      if (response.body.errors) {
        throw new Error(JSON.stringify(response.body.errors));
      }

      const productData = response.body.data.products;
      const products = productData.edges;

      summary.productsFound += products.length; // Approximate, accumulates as we fetch

      for (const edge of products) {
        if (productsProcessedCount >= MAX_PRODUCTS_PER_RUN) break;
        if (!dryRun && mediaDeletedCount >= MAX_MEDIA_DELETES_PER_RUN) break;

        const product = edge.node;
        const itemResult = {
          productId: product.id,
          title: product.title,
          handle: product.handle,
          mediaFound: 0,
          mediaDeleted: 0,
          status: "PROCESSED",
          errors: [],
        };

        // 1. Get all media
        let medias = [];
        try {
          medias = await getAllMediaForProduct(client, product);
          itemResult.mediaFound = medias.length;
          summary.mediaFound += medias.length;
        } catch (e) {
          itemResult.status = "ERROR";
          itemResult.errors.push("Failed to fetch media: " + e.message);
          summary.errors++;
          items.push(itemResult);
          productsProcessedCount++;
          continue;
        }

        // 2. Delete if Execute
        if (!dryRun && medias.length > 0) {
          const mediaIds = medias.map((m) => m.node.id);
          // Batch delete in chunks of 50 just in case
          const BATCH_SIZE = 50;

          for (let i = 0; i < mediaIds.length; i += BATCH_SIZE) {
            const batch = mediaIds.slice(i, i + BATCH_SIZE);
            try {
              // Wait a bit to avoid rate limits aggressively
              await sleep(300);

              const delResponse = await client.query({
                data: {
                  query: MUTATION_DELETE_MEDIA,
                  variables: {
                    productId: product.id,
                    mediaIds: batch,
                  },
                },
              });

              if (delResponse.body.data.productDeleteMedia.userErrors.length > 0) {
                const errs = delResponse.body.data.productDeleteMedia.userErrors.map(e => e.message);
                itemResult.errors.push(...errs);
                itemResult.status = "ERROR";
              } else {
                // Counts logic
                // deletedMediaIds might include product image ids etc.
                // We count the requested IDs for simplicity
                const deletedCount = batch.length;
                itemResult.mediaDeleted += deletedCount;
                mediaDeletedCount += deletedCount;
                summary.mediaDeleted += deletedCount;
              }

            } catch (err) {
              itemResult.status = "ERROR";
              itemResult.errors.push("Delete mutation failed: " + err.message);
            }
          }
          if (itemResult.status !== "ERROR") {
            itemResult.status = "DELETED";
          } else {
            summary.errors++;
          }
        } else {
          itemResult.status = dryRun ? "DRY_RUN" : "NO_MEDIA";
        }

        items.push(itemResult);
        productsProcessedCount++;
      }

      hasNextPage = productData.pageInfo.hasNextPage;
      cursor = productData.pageInfo.endCursor;

      // Global loop throttle
      await sleep(200);
    }

    summary.productsProcessed = productsProcessedCount;
    res.json({ summary, items });

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
}

app.post("/api/dry-run", async (req, res) => {
  return handleProcess(req, res, true);
});

app.post("/api/execute", async (req, res) => {
  return handleProcess(req, res, false);
});

// Serve frontend assets
app.use(serveStatic(join(__dirname, "../web/dist"), { index: false }));



app.use("/*", shopify.ensureInstalledOnShop(), async (_req, res, _next) => {
  try {
    const template = readFileSync(join(__dirname, "../web/dist/index.html"), "utf-8");
    const html = template.replace("%SHOPIFY_API_KEY%", process.env.SHOPIFY_API_KEY || "");
    return res.status(200).set("Content-Type", "text/html").send(html);
  } catch (e) {
    console.error("Error serving index.html:", e);
    return res.status(500).send("Internal Server Error: Could not serve app.");
  }
});

// Fallback for serving the file in Prod correctly
app.get("*", (req, res) => {
  // verify logic or just serve
  res.sendFile(join(__dirname, "../web/dist/index.html"));
});


app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
