import React, { useState, useCallback } from 'react';
import {
    AppProvider,
    Page,
    Layout,
    Card,
    TextField,
    Button,
    BlockStack,
    Text,
    Badge,
    Banner,
    DataTable,
    InlineGrid,
    Box,
    Divider,
    ProgressBar
} from '@shopify/polaris';
import enTranslations from '@shopify/polaris/locales/en.json';

function App() {
    const [tag, setTag] = useState('');
    const [confirmText, setConfirmText] = useState('');
    const [confirmTag, setConfirmTag] = useState('');

    const [loading, setLoading] = useState(false);
    const [progressText, setProgressText] = useState('');
    const [results, setResults] = useState(null);
    const [globalError, setGlobalError] = useState('');

    // Helper for Authenticated Fetch
    const authFetch = async (url, body) => {
        try {
            // App Bridge v4 global shopify object
            const token = await window.shopify.idToken();
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });

            if (response.headers.get("X-Shopify-Api-Request-Failure-Reauthorize") === "1") {
                const authUrl = response.headers.get("X-Shopify-Api-Request-Failure-Reauthorize-Url");
                if (authUrl) {
                    // Redirect to the re-authorization URL
                    window.location.href = authUrl;
                    return;
                }
            }

            if (!response.ok) {
                const err = await response.json();
                throw new Error(err.error || 'Request failed');
            }
            return await response.json();
        } catch (e) {
            throw e;
        }
    };

    const handleDryRun = useCallback(async () => {
        setLoading(true);
        setGlobalError('');
        setProgressText('Running Dry Run... This may take a while.');
        setResults(null);
        try {
            const data = await authFetch('/api/dry-run', { tag });
            setResults(data);
        } catch (error) {
            setGlobalError(error.message);
        } finally {
            setLoading(false);
            setProgressText('');
        }
    }, [tag]);

    const handleExecute = useCallback(async () => {
        setLoading(true);
        setGlobalError('');
        setProgressText('Processing Deletion... Please wait.');
        setResults(null);
        try {
            const data = await authFetch('/api/execute', { tag, confirmText, confirmTag });
            setResults(data);
        } catch (error) {
            setGlobalError(error.message);
        } finally {
            setLoading(false);
            setProgressText('');
        }
    }, [tag, confirmText, confirmTag]);

    const canExecute = results && confirmText === 'CONFIRM' && confirmTag === tag && !loading;

    return (
        <AppProvider i18n={enTranslations}>
            <Page title="Tagged Product Media Cleaner">
                <Layout>

                    {globalError && (
                        <Layout.Section>
                            <Banner tone="critical" title="Error">
                                <p>{globalError}</p>
                            </Banner>
                        </Layout.Section>
                    )}

                    <Layout.Section>
                        <Card>
                            <BlockStack gap="400">
                                <Text as="h2" variant="headingMd">Configuration</Text>
                                <TextField
                                    label="Product Tag"
                                    value={tag}
                                    onChange={setTag}
                                    autoComplete="off"
                                    helpText="Enter the exact tag to search for."
                                    disabled={loading}
                                />

                                <InlineGrid columns={2} gap="400">
                                    <Button
                                        variant="primary"
                                        onClick={handleDryRun}
                                        loading={loading && !confirmText} // Only show spinner if not executing
                                        disabled={!tag || loading}
                                    >
                                        Dry Run
                                    </Button>
                                </InlineGrid>

                                {results && (
                                    <>
                                        <Divider />
                                        <Text as="h2" variant="headingMd" tone="critical">Danger Zone: Execution</Text>
                                        <Banner tone="warning" title="Warning: Irreversible Action">
                                            <p>Entering 'CONFIRM' and the tag will permanently delete media images for ALL products found with this tag.</p>
                                            <p>Dry Run found <strong>{results.summary.productsFound}</strong> products and <strong>{results.summary.mediaFound}</strong> media items.</p>
                                        </Banner>

                                        <TextField
                                            label="Confirm Tag"
                                            value={confirmTag}
                                            onChange={setConfirmTag}
                                            autoComplete="off"
                                            placeholder={tag}
                                            helpText="Retype the tag used above."
                                            disabled={loading}
                                        />

                                        <TextField
                                            label="Confirmation Code"
                                            value={confirmText}
                                            onChange={setConfirmText}
                                            autoComplete="off"
                                            placeholder="CONFIRM"
                                            helpText="Type 'CONFIRM' to enable the button."
                                            disabled={loading}
                                        />

                                        <Button
                                            variant="primary"
                                            tone="critical"
                                            onClick={handleExecute}
                                            loading={loading}
                                            disabled={!canExecute}
                                        >
                                            EXECUTE DELETE
                                        </Button>
                                    </>
                                )}

                                {loading && <ProgressBar progress={80} tone="highlight" />}
                                {progressText && <Text tone="subdued">{progressText}</Text>}
                            </BlockStack>
                        </Card>
                    </Layout.Section>

                    {results && (
                        <Layout.Section>
                            <SummaryCards summary={results.summary} />
                            <Box paddingBlockStart="400">
                                <ResultsTable items={results.items} />
                            </Box>
                        </Layout.Section>
                    )}

                </Layout>
            </Page>
        </AppProvider>
    );
}

function SummaryCards({ summary }) {
    return (
        <InlineGrid columns={['oneThird', 'oneThird', 'oneThird']} gap="400">
            <Card>
                <Text variant="headingSm">Products Found</Text>
                <Text variant="headingLg">{summary.productsFound}</Text>
            </Card>
            <Card>
                <Text variant="headingSm">Products Processed</Text>
                <Text variant="headingLg">{summary.productsProcessed}</Text>
            </Card>
            <Card>
                <Text variant="headingSm">Media Found</Text>
                <Text variant="headingLg">{summary.mediaFound}</Text>
            </Card>
            <Card>
                <Text variant="headingSm" tone={summary.mediaDeleted > 0 ? "critical" : "base"}>Media Deleted</Text>
                <Text variant="headingLg">{summary.mediaDeleted}</Text>
            </Card>
            <Card>
                <Text variant="headingSm" tone={summary.errors > 0 ? "critical" : "base"}>Errors</Text>
                <Text variant="headingLg">{summary.errors}</Text>
            </Card>
        </InlineGrid>
    );
}

function ResultsTable({ items }) {
    const rows = items.map(item => [
        item.title,
        item.handle,
        item.mediaFound,
        item.mediaDeleted,
        <Badge tone={item.status === 'DELETED' ? 'critical' : item.status === 'ERROR' ? 'warning' : 'info'}>{item.status}</Badge>,
        item.errors.length > 0 ? item.errors.join(', ') : '-'
    ]);

    return (
        <Card>
            <DataTable
                columnContentTypes={['text', 'text', 'numeric', 'numeric', 'text', 'text']}
                headings={['Title', 'Handle', 'Media Found', 'Deleted', 'Status', 'Errors']}
                rows={rows}
            />
        </Card>
    );
}

export default App;
