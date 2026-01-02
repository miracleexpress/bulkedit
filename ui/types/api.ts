export interface AuthStatus {
    ok: boolean;
    authenticated: boolean;
    shop?: string;
    hasAccessToken?: boolean;
}

export interface BillingInfo {
    currentPlan: string;
    status: string;
    shop?: string;
    installationId?: string;
    plans?: Record<string, any>;
    usage?: any;
}

export interface AuthConfig {
    shop: string | null;
    hasShopConfigured: boolean;
    apiKey: string;
}

export interface ApiError {
    status: number;
    message: string;
    code?: string;
}