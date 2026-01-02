export const QUERIES = {
    SCHEMA: `
        CREATE TABLE IF NOT EXISTS shop_tokens (
            shop VARCHAR(255) PRIMARY KEY,
            access_token VARCHAR(255) NOT NULL,
            updated_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS shop_subscriptions (
            shop VARCHAR(255) PRIMARY KEY,
            plan_type VARCHAR(50) DEFAULT 'FREE',
            subscription_id VARCHAR(255),
            status VARCHAR(50) DEFAULT 'ACTIVE',
            current_period_end TIMESTAMP,
            app_installation_id VARCHAR(255), 
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS shopify_sessions (
            id VARCHAR(255) PRIMARY KEY,
            shop VARCHAR(255) NOT NULL,
            state VARCHAR(255) NOT NULL,
            is_online BOOLEAN NOT NULL,
            scope VARCHAR(255),
            expires TIMESTAMP,
            access_token VARCHAR(255),
            online_access_info TEXT,
            createdAt TIMESTAMP DEFAULT NOW(),
            updatedAt TIMESTAMP DEFAULT NOW()
        );
    `,

    SAVE_TOKEN: `
        INSERT INTO shop_tokens (shop, access_token, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (shop) DO UPDATE SET access_token = EXCLUDED.access_token, updated_at = NOW();
    `,

    GET_TOKEN: `
        SELECT access_token FROM shop_tokens WHERE shop = $1;
    `,

    GET_SUBSCRIPTION: `
        SELECT * FROM shop_subscriptions WHERE shop = $1;
    `,

    UPSERT_SUBSCRIPTION: `
        INSERT INTO shop_subscriptions (shop, plan_type, subscription_id, status, current_period_end, app_installation_id, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (shop) 
        DO UPDATE SET 
            plan_type = EXCLUDED.plan_type,
            subscription_id = EXCLUDED.subscription_id,
            status = EXCLUDED.status,
            current_period_end = EXCLUDED.current_period_end,
            app_installation_id = COALESCE(EXCLUDED.app_installation_id, shop_subscriptions.app_installation_id),
            updated_at = NOW();
    `,

    CLEANUP_SHOP: `
        DELETE FROM shop_tokens WHERE shop = $1;
        DELETE FROM shop_subscriptions WHERE shop = $1;
        DELETE FROM shopify_sessions WHERE shop = $1;
    `,

    // --- Session Queries ---
    STORE_SESSION: `
        INSERT INTO shopify_sessions
          (id, shop, state, is_online, scope, expires, access_token, online_access_info)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET
           shop = EXCLUDED.shop,
           state = EXCLUDED.state,
           is_online = EXCLUDED.is_online,
           scope = EXCLUDED.scope,
           expires = EXCLUDED.expires,
           access_token = EXCLUDED.access_token,
           online_access_info = EXCLUDED.online_access_info;
    `,

    LOAD_SESSION: `
        SELECT id, shop, state, is_online, scope, expires, access_token, online_access_info
        FROM shopify_sessions WHERE id=$1;
    `,

    DELETE_SESSION: `
        DELETE FROM shopify_sessions WHERE id=$1;
    `,

    DELETE_SESSIONS: `
        DELETE FROM shopify_sessions WHERE id = ANY($1::text[]);
    `,

    FIND_SESSIONS_BY_SHOP: `
        SELECT id, shop, state, is_online, scope, expires, access_token, online_access_info
        FROM shopify_sessions WHERE shop=$1;
    `
};