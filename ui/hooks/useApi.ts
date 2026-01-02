import { useMemo } from 'react';
import { useAppBridge } from '@shopify/app-bridge-react';
import { authenticatedFetch } from '../utils/authenticatedFetch';
import { AuthStatus, AuthConfig, BillingInfo } from '../types/api';

export function useApi() {
    const app = useAppBridge();

    const api = useMemo(() => {

        async function jsonRequest<T>(url: string, options: RequestInit = {}): Promise<T> {
            try {
                const res = await authenticatedFetch(app, url, options);

                if (!res.ok) {
                    const text = await res.text().catch(() => '');
                    throw { status: res.status, message: text };
                }

                return await res.json().catch(() => ({}));
            } catch (error: any) {
                console.error(`[API] Error calling ${url}:`, error);
                throw error;
            }
        }

        return {
            /**
             * Check if the current session is authenticated and valid
             */
            checkAuth: () => jsonRequest<AuthStatus>('/api/auth/status'),

            /**
             * Verify the session token simply by pinging a test endpoint
             */
            verifyToken: async (): Promise<boolean> => {
                try {
                    await jsonRequest('/api/test-token');
                    return true;
                } catch {
                    return false;
                }
            },

            /**
             * Get public auth configuration
             */
            getAuthConfig: () => jsonRequest<AuthConfig>('/auth/config'),

            /**
             * Get billing status and plan info.
             * @param sync If true, forces a sync with Shopify API before returning
             */
            getBillingInfo: (sync = false) =>
                jsonRequest<BillingInfo>(`/api/billing/info${sync ? '?sync=1' : ''}`)
        };

    }, [app]);

    return api;
}
