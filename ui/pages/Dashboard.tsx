import React, { useEffect, useState } from 'react';
import {
  Page,
  Layout,
  Card,
  SkeletonBodyText,
  SkeletonDisplayText,
  Banner,
  Badge,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Icon,
  Divider,
  Box,
} from '@shopify/polaris';
import {
  CheckCircleIcon,
  AlertCircleIcon,
  InfoIcon,
  StarFilledIcon,
  SettingsIcon,
  QuestionCircleIcon,
} from '@shopify/polaris-icons';
import { useApi } from '../hooks/useApi';
import { BillingInfo } from '../types/api';

export const Dashboard: React.FC = () => {
  const api = useApi();

  const [shop, setShop] = useState('');
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function init() {
      try {
        const [authData, billingData] = await Promise.all([
          api.checkAuth().catch(() => null),
          api.getBillingInfo().catch(() => null)
        ]);

        if (authData?.shop) {
          setShop(authData.shop);
        }

        if (billingData) {
          setBilling(billingData);
        }

      } catch (e: any) {
        console.error("Dashboard Load Error", e);
        setError(e?.message || 'Failed to load dashboard data');
      } finally {
        setLoading(false);
      }
    }

    init();
  }, [api]);

  if (loading) {
    return (
      <Page title="Dashboard">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <SkeletonDisplayText size="small" />
                <SkeletonBodyText lines={3} />
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  if (error) {
    return (
      <Page title="Dashboard">
        <Layout>
          <Layout.Section>
            <Banner
              title="Unable to load dashboard"
              tone="critical"
              onDismiss={() => setError(null)}
            >
              <p>{error}</p>
            </Banner>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  const currentPlanName = billing?.plans?.[billing.currentPlan]?.name || billing?.currentPlan || 'Free';
  const isActive = billing?.status === 'ACTIVE';

  return (
    <Page
      title={`Welcome back!`}
      subtitle={shop}
    >
      <Layout>
        {/* Hero Banner */}
        <Layout.Section>
          <Banner
            title="🎉 Your app is successfully deployed!"
            tone="success"
          >
            <p>Everything is set up and ready to go. Start exploring the features below.</p>
          </Banner>
        </Layout.Section>

        {/* Current Plan Card */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <InlineStack gap="200" blockAlign="center">
                  <Icon source={StarFilledIcon} tone="base" />
                  <Text as="h2" variant="headingLg" fontWeight="bold">Current Plan</Text>
                </InlineStack>
                <InlineStack gap="300">
                  <Badge tone="info" size="large">{currentPlanName}</Badge>
                  {billing && (
                    <Badge
                      tone={isActive ? 'success' : 'warning'}
                      size="large"
                      icon={isActive ? CheckCircleIcon : AlertCircleIcon}
                    >
                      {billing.status}
                    </Badge>
                  )}
                </InlineStack>
              </InlineStack>

              <Divider />

              <InlineStack align="space-between" blockAlign="center">
                <Text as="p" variant="bodyMd" tone="subdued">
                  {isActive
                    ? `You're on the ${currentPlanName} plan with full access to all features.`
                    : 'Upgrade your plan to unlock premium features.'
                  }
                </Text>
                <Button variant="primary" url="/pricing">
                  View Plans
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Feature Cards */}
        <Layout.Section>
          <InlineStack gap="400" wrap={false}>
            <Box width="33.33%">
              <Card>
                <BlockStack gap="300">
                  <InlineStack gap="200" blockAlign="center">
                    <div style={{
                      backgroundColor: '#E3F2FD',
                      borderRadius: '8px',
                      padding: '8px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}>
                      <Icon source={CheckCircleIcon} tone="success" />
                    </div>
                    <Text as="h3" variant="headingMd" fontWeight="semibold">Secure Authentication</Text>
                  </InlineStack>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Protected by Shopify App Bridge session tokens for enterprise-grade security.
                  </Text>
                </BlockStack>
              </Card>
            </Box>

            <Box width="33.33%">
              <Card>
                <BlockStack gap="300">
                  <InlineStack gap="200" blockAlign="center">
                    <div style={{
                      backgroundColor: '#FFF3E0',
                      borderRadius: '8px',
                      padding: '8px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}>
                      <Icon source={SettingsIcon} tone="base" />
                    </div>
                    <Text as="h3" variant="headingMd" fontWeight="semibold">Getting Started</Text>
                  </InlineStack>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Configure your app settings and customize features to match your workflow.
                  </Text>
                </BlockStack>
              </Card>
            </Box>

            <Box width="33.33%">
              <Card>
                <BlockStack gap="300">
                  <InlineStack gap="200" blockAlign="center">
                    <div style={{
                      backgroundColor: '#F3E5F5',
                      borderRadius: '8px',
                      padding: '8px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center'
                    }}>
                      <Icon source={QuestionCircleIcon} tone="info" />
                    </div>
                    <Text as="h3" variant="headingMd" fontWeight="semibold">Need Help?</Text>
                  </InlineStack>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Access our comprehensive documentation and support resources anytime.
                  </Text>
                </BlockStack>
              </Card>
            </Box>
          </InlineStack>
        </Layout.Section>

        {/* Quick Actions */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingLg" fontWeight="bold">Quick Actions</Text>
              <Divider />
              <InlineStack gap="300">
                <Button variant="primary" size="large">
                  Configure Settings
                </Button>
                <Button size="large">
                  View Documentation
                </Button>
                <Button size="large" tone="success">
                  Upgrade Plan
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* Info Banner */}
        <Layout.Section>
          <Banner tone="info" icon={InfoIcon}>
            <p>
              <strong>Pro Tip:</strong> Customize this dashboard to show your app's key metrics and features.
              This is a base template ready for your customization.
            </p>
          </Banner>
        </Layout.Section>
      </Layout>
    </Page>
  );
};
