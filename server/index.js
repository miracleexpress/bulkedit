import 'dotenv/config';
import express from "express";
import { dirname, join } from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import serveStatic from "serve-static";
import shopify, { prisma } from "./shopify.js";
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
  async (req, res, next) => {
    const session = res.locals.shopify?.session;
    console.log("✅ Auth callback OK", {
      shop: session?.shop,
      isOnline: session?.isOnline,
      id: session?.id,
    });

    // Verify persistence immediately
    try {
      if (session) {
        const loadedById = await shopify.config.sessionStorage.loadSession(session.id);
        console.log("🔎 loadSession(by id) =>", loadedById ? "FOUND" : "NULL");

        const offlineId = shopify.api.session.getOfflineId(session.shop);
        const loadedOffline = await shopify.config.sessionStorage.loadSession(offlineId);
        console.log(`🔎 loadSession(${offlineId}) =>`, loadedOffline ? "FOUND" : "NULL");
      }
    } catch (e) {
      console.error("❌ loadSession check failed:", e);
    }
    next();
  },
  shopify.redirectToShopifyOrAppRoot()
);
app.post(
  shopify.config.webhooks.path,
  shopify.processWebhooks({ webhookHandlers: {} })
);

app.use("/api", express.json());

// Custom Offline Session Middleware to avoid JWT reauth loops
app.use("/api", async (req, res, next) => {
  try {
    let shop = req.query.shop;

    // Fallback: Try to get shop from Referer if not in query
    if (!shop) {
      const referer = req.get("referer");
      if (referer) {
        try {
          const url = new URL(referer);
          shop = url.searchParams.get("shop");
        } catch (e) {
          // ignore invalid referer
        }
      }
    }

    if (!shop) {
      console.log("❌ Custom Middleware: Missing shop parameter");
      return res.status(400).json({ error: "Missing shop parameter" });
    }

    const offlineId = shopify.api.session.getOfflineId(shop);
    const session = await shopify.config.sessionStorage.loadSession(offlineId);

    if (!session) {
      console.log(`❌ Custom Middleware: No offline session found for ${shop}`);
      return res.status(401).json({ error: "No offline session found. Please reauthorize." });
    }

    // Determine correctness by creating a Graphql client from this session to see if it works? 
    // No, just pass it to the handler.
    res.locals.shopify = { session };
    return next();
  } catch (e) {
    console.error("❌ Custom Middleware Error:", e);
    return res.status(500).json({ error: "Auth middleware failed" });
  }
});

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

// --- BULK UPLOAD HELPERS ---

const QUERY_PRODUCTS_BY_TAG = `
  query getProductsByTag($query: String!, $cursor: String) {
    products(first: 50, after: $cursor, query: $query) {
      edges {
        node {
          id
          title
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const MUTATION_STAGED_UPLOADS_CREATE = `
  mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters {
          name
          value
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const MUTATION_FILE_CREATE = `
  mutation fileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        fileStatus
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const MUTATION_PRODUCT_CREATE_MEDIA = `
  mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media {
        id
        status
        mediaErrors {
          code
          details
        }
      }
      mediaUserErrors {
        field
        message
      }
    }
  }
`;

// 1. Fetch ALL products by tag
app.post("/api/fetch-products", async (req, res) => {
  const { tag } = req.body;
  if (!tag) return res.status(400).json({ error: "Tag is required" });

  const session = res.locals.shopify.session;
  const client = new shopify.api.clients.Graphql({ session });

  try {
    let allProducts = [];
    let hasNextPage = true;
    let cursor = null;

    while (hasNextPage) {
      const response = await client.query({
        data: {
          query: QUERY_PRODUCTS_BY_TAG,
          variables: { query: `tag:${tag}`, cursor },
        },
      });

      const data = response.body.data.products;
      allProducts = allProducts.concat(data.edges.map(e => e.node));

      hasNextPage = data.pageInfo.hasNextPage;
      cursor = data.pageInfo.endCursor;

      // Safety limits
      if (allProducts.length > 2000) break; // Hard limit prevention
      await sleep(100);
    }

    res.json({ products: allProducts });
  } catch (e) {
    console.error("Fetch products error:", e);
    res.status(500).json({ error: e.message });
  }
});

// 2. Sign Upload (Staged Uploads Create)
app.post("/api/upload/sign", async (req, res) => {
  const { filename, mimeType, resource } = req.body;
  const session = res.locals.shopify.session;
  const client = new shopify.api.clients.Graphql({ session });

  try {
    const response = await client.query({
      data: {
        query: MUTATION_STAGED_UPLOADS_CREATE,
        variables: {
          input: [{
            filename,
            mimeType,
            resource: resource || "IMAGE",
            httpMethod: "PUT"
          }]
        }
      }
    });

    if (response.body.errors) {
      throw new Error(JSON.stringify(response.body.errors));
    }

    const result = response.body.data.stagedUploadsCreate;
    if (result.userErrors && result.userErrors.length > 0) {
      return res.status(400).json({ error: result.userErrors[0].message });
    }

    res.json(result.stagedTargets[0]);
  } catch (e) {
    console.error("Sign upload error:", e);
    res.status(500).json({ error: e.message });
  }
});

// 3. File Create (Register in Shopify Files)
app.post("/api/upload/file-create", async (req, res) => {
  const { originalSource, filename, contentType } = req.body;
  const session = res.locals.shopify.session;
  const client = new shopify.api.clients.Graphql({ session });

  try {
    const response = await client.query({
      data: {
        query: MUTATION_FILE_CREATE,
        variables: {
          files: [{
            originalSource,
            filename,
            contentType
          }]
        }
      }
    });

    if (response.body.errors) {
      throw new Error(JSON.stringify(response.body.errors));
    }

    const result = response.body.data.fileCreate;
    if (result.userErrors && result.userErrors.length > 0) {
      return res.status(400).json({ error: result.userErrors[0].message });
    }

    res.json(result.files[0]);
  } catch (e) {
    console.error("File create error:", e);
    res.status(500).json({ error: e.message });
  }
});

// 4. Product Create Media
app.post("/api/upload/media-create", async (req, res) => {
  const { productId, originalSource, mediaContentType } = req.body;
  const session = res.locals.shopify.session;
  const client = new shopify.api.clients.Graphql({ session });

  try {
    const response = await client.query({
      data: {
        query: MUTATION_PRODUCT_CREATE_MEDIA,
        variables: {
          productId,
          media: [{
            originalSource,
            mediaContentType: mediaContentType || "IMAGE"
          }]
        }
      }
    });

    if (response.body.errors) {
      throw new Error(JSON.stringify(response.body.errors));
    }

    const result = response.body.data.productCreateMedia;
    if (result.mediaUserErrors && result.mediaUserErrors.length > 0) {
      return res.status(400).json({ error: result.mediaUserErrors[0].message });
    }

    res.json(result.media[0]);
  } catch (e) {
    console.error("Media create error:", e);
    res.status(500).json({ error: e.message });
  }
});

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

// Internal Endpoint for Token Export
app.get("/api/internal/offline-token", async (req, res) => {
  const secretEnv = process.env.INTERNAL_TOKEN_EXPORT_SECRET;

  // 1. Critical Security Check
  if (!secretEnv) {
    console.error("❌ CRTICAL: INTERNAL_TOKEN_EXPORT_SECRET is not set in environment.");
    return res.status(500).json({ error: "Server misconfiguration" });
  }

  const headerSecret = req.headers['x-secret'];
  if (headerSecret !== secretEnv) {
    console.warn("⚠️ Unauthorized access attempt to internal token endpoint.");
    return res.status(401).json({ error: "Unauthorized" });
  }

  // 2. Logic to fetch offline token
  try {
    const { shop } = req.query;

    // Prevent caching of sensitive data
    res.setHeader('Cache-Control', 'no-store');

    let session;
    if (shop) {
      // If shop is provided, try to find specific offline session
      // Constructing ID like "offline_shopname" is standard but let's query safer
      // Session ID format for offline: "offline_" + shop
      const offlineId = `offline_${shop}`;
      session = await prisma.session.findUnique({
        where: { id: offlineId }
      });
    } else {
      // Find ANY offline session if no shop specified (internal tool usage)
      session = await prisma.session.findFirst({
        where: {
          id: {
            startsWith: 'offline_'
          }
        }
      });
    }

    if (!session) {
      return res.status(404).json({ error: "No offline session found" });
    }

    // 3. Return secure JSON
    console.log(`✅ Token exported for shop: ${session.shop}`);
    return res.json({
      shop: session.shop,
      accessToken: session.accessToken
    });

  } catch (error) {
    console.error("❌ Internal token export error:", error);
    return res.status(500).json({ error: "Internal Error" });
  }
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
  console.log("DB host:", (process.env.DATABASE_URL || "").split("@")[1]?.split("/")[0]);
});
