import { shopifyApp } from "@shopify/shopify-app-express";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { PrismaClient } from "@prisma/client";
import { LATEST_API_VERSION } from "@shopify/shopify-api";

const prisma = new PrismaClient();
const storage = new PrismaSessionStorage(prisma);

const shopify = shopifyApp({
    api: {
        apiVersion: LATEST_API_VERSION,
        billing: undefined,
        scopes: process.env.SCOPES ? process.env.SCOPES.split(',') : [],
    },
    auth: {
        path: "/api/auth",
        callbackPath: "/api/auth/callback",
    },
    webhooks: {
        path: "/api/webhooks",
    },
    sessionStorage: storage,
});

export default shopify;
export { prisma };
