import { useState, useCallback } from "react";
// REMOVED: import { AppProvider } from "@shopify/shopify-app-react";
import { Page, Layout, Card, TextField, Button, Banner, BlockStack, Text, DataTable, Badge, ProgressBar } from "@shopify/polaris";
import { Provider as AppBridgeProvider } from "@shopify/app-bridge-react";
import "@shopify/polaris/build/esm/styles.css";

// App Bridge config
const appBridgeConfig = {
    apiKey: import.meta.env.VITE_SHOPIFY_API_KEY,
    host: new URLSearchParams(window.location.search).get("host"),
    forceRedirect: true,
};

export function App() {
    return (
        <AppBridgeProvider config={appBridgeConfig}>
            <MainContent />
        </AppBridgeProvider>
    );
}

function MainContent() {
    // State
    const [tag, setTag] = useState("");
    const [mode, setMode] = useState("IDLE"); // IDLE, DRY_RUNNING, REVIEW, CONFIRMING, EXECUTING, DONE

    // Dry Run Res
    const [drySummary, setDrySummary] = useState(null);

    // Confirmation
    const [confirmTag, setConfirmTag] = useState("");
    const [confirmText, setConfirmText] = useState("");

    // Execution
    const [progress, setProgress] = useState({ productsProcessed: 0, mediaDeleted: 0, errors: 0 });
    const [logs, setLogs] = useState([]); // List of processed items

    // Helpers
    const authenticatedFetch = async (url, options = {}) => {
        // Standard fetch for now
        return fetch(url, options);
    };

    const handleDryRun = async () => {
        setMode("DRY_RUNNING");
        setLogs([]);
        try {
            const res = await fetch("/api/dry-run", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tag })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);

            setDrySummary(data.summary);
            setLogs(data.items || []);
            setMode("REVIEW");
        } catch (e) {
            console.error(e);
            setMode("IDLE");
            // Could show toast error here
        }
    };

    const handleExecuteStart = async () => {
        setMode("EXECUTING");
        setProgress({ productsProcessed: 0, mediaDeleted: 0, errors: 0 });
        setLogs([]); // Clear dry run logs to show execution logs
        executeBatch(null);
    };

    const executeBatch = async (cursor) => {
        try {
            const res = await fetch("/api/execute", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    tag,
                    confirmText,
                    confirmTag,
                    cursor,
                    batchSize: 20
                })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);

            // Update State
            setProgress(prev => ({
                productsProcessed: prev.productsProcessed + (data.summaryDelta?.productsProcessed || 0),
                mediaDeleted: prev.mediaDeleted + (data.summaryDelta?.mediaDeleted || 0),
                errors: prev.errors + (data.summaryDelta?.errors || 0)
            }));

            if (data.items && data.items.length > 0) {
                setLogs(prev => [...prev, ...data.items]);
            }

            // Loop or Finish
            if (!data.done && data.nextCursor) {
                executeBatch(data.nextCursor);
            } else {
                setMode("DONE");
            }

        } catch (e) {
            console.error("Batch Failed", e);
            // Don't stop completely on network error? Or retry?
            // For now, stop to be safe and show error.
            setLogs(prev => [...prev, { title: "BATCH ERROR", status: "ERROR", errors: [e.message] }]);
            setMode("DONE");
        }
    };

    const isConfirmValid = confirmText === "CONFIRM" && confirmTag === tag;

    return (
        <Page title="Tagged Product Image Cleaner">
            <BlockStack gap="500">

                {/* INPUT SECTION */}
                <Card>
                    <BlockStack gap="400">
                        <Text variant="headingMd" as="h2">Target Selection</Text>
                        <TextField
                            label="Product Tag"
                            value={tag}
                            onChange={setTag}
                            autoComplete="off"
                            helpText="Enter the exact tag to search for."
                            disabled={mode !== "IDLE" && mode !== "REVIEW"}
                        />
                        <Button
                            onClick={handleDryRun}
                            loading={mode === "DRY_RUNNING"}
                            disabled={!tag || (mode !== "IDLE" && mode !== "REVIEW")}
                        >
                            Dry Run
                        </Button>
                    </BlockStack>
                </Card>

                {/* DRY RUN SUMMARY */}
                {mode === "REVIEW" && drySummary && (
                    <Banner title="Dry Run Results" tone="info">
                        <p>Products found: <strong>{drySummary.productsFound}</strong></p>
                        <p>Media found (approx): <strong>{drySummary.mediaFound}</strong></p>
                        {drySummary.capped && <p><em>Note: Scan capped at safety limit. Actual count may be higher.</em></p>}
                    </Banner>
                )}

                {/* CONFIRMATION */}
                {mode === "REVIEW" && (
                    <Card>
                        <BlockStack gap="400">
                            <Text variant="headingMd" as="h2" tone="critical">Danger Zone</Text>
                            <Banner tone="critical">
                                <p>This action will permanently delete images for all products with tag <strong>{tag}</strong>.</p>
                                <p>This cannot be undone.</p>
                            </Banner>
                            <TextField
                                label="Retype Tag"
                                value={confirmTag}
                                onChange={setConfirmTag}
                                autoComplete="off"
                            />
                            <TextField
                                label="Type CONFIRM"
                                value={confirmText}
                                onChange={setConfirmText}
                                autoComplete="off"
                                placeholder="CONFIRM"
                            />
                            <Button
                                tone="critical"
                                variant="primary"
                                onClick={handleExecuteStart}
                                disabled={!isConfirmValid}
                            >
                                Execute Deletion
                            </Button>
                        </BlockStack>
                    </Card>
                )}

                {/* EXECUTION PROGRESS */}
                {(mode === "EXECUTING" || mode === "DONE") && (
                    <Card>
                        <BlockStack gap="400">
                            <Text variant="headingMd" as="h2">{mode === "DONE" ? "Execution Complete" : "Executing..."}</Text>
                            <ProgressBar progress={mode === "DONE" ? 100 : undefined} />
                            <BlockStack gap="200">
                                <Text>Products Processed: {progress.productsProcessed}</Text>
                                <Text>Media Deleted: {progress.mediaDeleted}</Text>
                                <Text tone={progress.errors > 0 ? "critical" : "subdued"}>Errors: {progress.errors}</Text>
                            </BlockStack>
                        </BlockStack>
                    </Card>
                )}

                {/* LOGS TABLE */}
                {logs.length > 0 && (
                    <Card title="Details">
                        <DataTable
                            columnContentTypes={['text', 'text', 'numeric', 'text']}
                            headings={['Product', 'Handle', 'Media', 'Status']}
                            rows={logs.map(l => [
                                l.title || "Unknown",
                                l.handle || "N/A",
                                l.mediaDeleted?.toString() || l.mediaFound?.toString() || "0",
                                <StatusBadge status={l.status} />
                            ])}
                        />
                    </Card>
                )}

            </BlockStack>
        </Page>
    );
}

function StatusBadge({ status }) {
    if (status === "DELETED") return <Badge tone="success">Deleted</Badge>;
    if (status === "DRY") return <Badge tone="info">Found</Badge>;
    if (status === "ERROR" || status === "PARTIAL_ERROR") return <Badge tone="critical">Error</Badge>;
    return <Badge>{status}</Badge>;
}
