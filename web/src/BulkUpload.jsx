import React, { useState, useCallback, useRef } from 'react';
import {
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
    ProgressBar,
    Checkbox,
    Icon
} from '@shopify/polaris';


// --- HELPER: Tokenizer & Matcher ---
function tokenize(text) {
    if (!text) return [];
    // Lowercase
    const lower = text.toLowerCase();
    // Split by any non-unicode-letter/number
    // Since JS regex for unicode properties is supported in modern browsers
    const tokens = lower.split(/[^\p{L}\p{N}]+/gu).filter(t => t.length > 0);
    return tokens;
}

function isSubset(productTitle, folderName) {
    const productTokens = tokenize(productTitle);
    const folderTokens = tokenize(folderName);

    // Rule: Product tokens MUST be a subset of Folder tokens
    return productTokens.every(pt => folderTokens.includes(pt));
}

export function BulkUpload({ authFetch }) {
    const [tag, setTag] = useState('');
    const [loading, setLoading] = useState(false);
    const [step, setStep] = useState('input'); // input -> matching -> confirming -> uploading -> done
    const [matchResults, setMatchResults] = useState(null);
    const [uploadProgress, setUploadProgress] = useState({ current: 0, total: 0, log: [] });
    const [globalError, setGlobalError] = useState('');

    // Refs for directory handles needed during upload
    const matchedHandlesRef = useRef(new Map()); // productId -> { folderHandle, images: [] }

    // 1. Fetch Products & Scan Directory
    const handleScan = async () => {
        if (!tag) return;
        setLoading(true);
        setGlobalError('');
        matchedHandlesRef.current.clear();

        try {
            // A. Pick Directory
            if (!window.showDirectoryPicker) {
                throw new Error("Your browser does not support the File System Access API (window.showDirectoryPicker). Please use Chrome, Edge, or Opera on Desktop.");
            }

            let dirHandle;
            try {
                dirHandle = await window.showDirectoryPicker();
            } catch (e) {
                if (e.name === 'AbortError') {
                    setLoading(false);
                    return; // User cancelled
                }
                console.error("Directory Picker failed:", e);
                // Specialized error message for iframe restriction
                if (e.name === 'SecurityError' || e.message.includes('SecurityError')) {
                    throw new Error("Shopify Security Restriction: Cannot access file system from within the embedded admin iframe. Please try opening this app in a new tab/window.");
                }
                throw e;
            }

            // B. Fetch Products
            const productsRes = await authFetch('/api/fetch-products', { tag });
            if (productsRes.error) throw new Error(productsRes.error);
            const products = productsRes.products;

            if (products.length === 0) {
                throw new Error('No products found with this tag.');
            }

            // C. Scan Folders (1 level deep)
            const folderCandidates = [];
            // async iterator for directory
            for await (const entry of dirHandle.values()) {
                if (entry.kind === 'directory') {
                    folderCandidates.push({ name: entry.name, handle: entry });
                }
            }

            // D. Perform Matching
            const results = {
                matched: [],
                unmatched: [],
                collisions: []
            };

            for (const product of products) {
                const matches = folderCandidates.filter(f => isSubset(product.title, f.name));

                if (matches.length === 0) {
                    results.unmatched.push({ product });
                } else if (matches.length > 1) {
                    results.collisions.push({ product, candidates: matches.map(m => m.name) });
                } else {
                    // Exactly 1 match
                    const folder = matches[0];

                    // E. Deep check: Look for "Etulle Shopify" and images
                    // We need to look inside the folder handle
                    let etulleHandle = null;
                    let imageFiles = [];

                    try {
                        etulleHandle = await folder.handle.getDirectoryHandle('Etulle Shopify');
                    } catch (e) {
                        // Folder missing subfolder -> treat as unmatched logic? 
                        // Requirement says: "Etulle Shopify yoksa -> o ürün klasörü yok sayılacak" -> So it becomes unmatched effectively for this folder match attempt?
                        // Actually if it matched by name but lacks folder, it's a failed match.
                        // Since we only had 1 candidate, it falls back to Unmatched.
                    }

                    if (etulleHandle) {
                        // Collect images
                        for await (const fileEntry of etulleHandle.values()) {
                            if (fileEntry.kind === 'file') {
                                const lowerName = fileEntry.name.toLowerCase();
                                if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg') || lowerName.endsWith('.png') || lowerName.endsWith('.webp')) {
                                    const file = await fileEntry.getFile();
                                    imageFiles.push(file);
                                }
                            }
                        }

                        // Sort images numerically
                        const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
                        imageFiles.sort((a, b) => collator.compare(a.name, b.name));
                    }

                    if (etulleHandle && imageFiles.length > 0) {
                        const item = {
                            product,
                            folderName: folder.name,
                            imageCount: imageFiles.length,
                            checked: true,
                            id: product.id
                        };
                        results.matched.push(item);
                        // Store handles for upload phase
                        matchedHandlesRef.current.set(product.id, imageFiles);
                    } else {
                        // Found matched folder name but no valid content
                        results.unmatched.push({ product, reason: "Missing 'Etulle Shopify' or images" });
                    }
                }
            }

            setMatchResults(results);
            setStep('confirming');

        } catch (e) {
            console.error(e);
            setGlobalError(e.message);
        } finally {
            setLoading(false);
        }
    };

    const toggleCheck = (productId) => {
        setMatchResults(prev => ({
            ...prev,
            matched: prev.matched.map(m => m.id === productId ? { ...m, checked: !m.checked } : m)
        }));
    };

    // 2. Upload Pipeline
    const handleUpload = async () => {
        const toProcess = matchResults.matched.filter(m => m.checked);
        if (toProcess.length === 0) return;

        setStep('uploading');
        setLoading(true);

        // Flatten tasks: Product -> Images
        let totalImages = 0;
        toProcess.forEach(m => totalImages += m.imageCount);

        setUploadProgress({ current: 0, total: totalImages, log: [] });

        const addLog = (msg, tone = 'info') => {
            setUploadProgress(prev => ({
                ...prev,
                log: [...prev.log, { msg, tone }]
            }));
        };

        let processedCount = 0;

        for (const item of toProcess) {
            const images = matchedHandlesRef.current.get(item.id);
            addLog(`Processing product: ${item.product.title}`, 'base');

            for (let i = 0; i < images.length; i++) {
                const file = images[i];
                try {
                    // 1. Staged Upload
                    const signRes = await authFetch('/api/upload/sign', {
                        filename: file.name,
                        mimeType: file.type,
                        resource: "IMAGE"
                    });

                    if (signRes.error) throw new Error(signRes.error);

                    const { url, parameters, resourceUrl } = signRes;

                    // 2. PUT File
                    const formData = new FormData();
                    parameters.forEach(p => formData.append(p.name, p.value));
                    formData.append('file', file);

                    // Warning: Shopify Staged Uploads usually requires pure PUT with body=file if no params,
                    // OR POST with FormData if params exist (like AWS S3). 
                    // GQL stagedUploadsCreate usually returns Google Cloud Storage signed URL which needs PUT.
                    // However, let's check parameters.
                    // If parameters exist, it's likely S3-style POST. If parameters empty, it's PUT.
                    // Google Cloud Storage signed URLs usually are PUT.

                    let uploadRes;
                    if (parameters && parameters.length > 0) {
                        // POST form data (S3 style) - Rarely used for Shopify Images nowadays but possible
                        uploadRes = await fetch(url, {
                            method: 'POST',
                            body: formData
                        });
                    } else {
                        // PUT raw file (GCS style) - Most common for Shopify
                        uploadRes = await fetch(url, {
                            method: 'PUT',
                            headers: {
                                'Content-Type': file.type
                            },
                            body: file
                        });
                    }

                    if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.statusText}`);

                    // 3. File Create
                    const fileCreateRes = await authFetch('/api/upload/file-create', {
                        originalSource: resourceUrl,
                        filename: file.name,
                        contentType: file.type
                    });

                    if (fileCreateRes.error) throw new Error(fileCreateRes.error);

                    // 4. Product Create Media
                    // Note: We use the resourceUrl (public) as source, 
                    // OR we could use the file ID. Prompt says: "productCreateMedia" 
                    // Requirement: "Upload Pipeline... fileCreate -> productCreateMedia"
                    // We will use the Staged Upload URL (resourceUrl) as the source for the product media
                    // because that's the standard way to add media from valid URL. 
                    // The fileCreate step registers it as a generic File, but linking to product 
                    // usually is cleaner via URL.
                    const mediaRes = await authFetch('/api/upload/media-create', {
                        productId: item.product.id,
                        originalSource: resourceUrl,
                        mediaContentType: "IMAGE"
                    });

                    if (mediaRes.error) throw new Error(mediaRes.error);

                    processedCount++;
                    setUploadProgress(prev => ({ ...prev, current: processedCount }));

                } catch (e) {
                    console.error(e);
                    addLog(`Failed: ${file.name} - ${e.message}`, 'critical');
                }
            }
        }

        setLoading(false);
        addLog('Batch processing complete.', 'success');
    };

    // --- RENDERERS ---

    // Detect Embedded Mode
    const isEmbedded = window.self !== window.top;

    if (step === 'input') {
        return (
            <Card>
                <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">Bulk Upload Configuration</Text>

                    {isEmbedded && (
                        <Banner tone="warning" title="Browser Security Restriction">
                            <p>
                                Filesystem access is <strong>not allowed</strong> inside the Shopify Admin iframe.
                                You must open this app in a new tab to select folders.
                            </p>
                            <Box paddingBlockStart="200">
                                <Button onClick={() => window.open(window.location.href, '_blank')}>
                                    Open App in New Tab
                                </Button>
                            </Box>
                        </Banner>
                    )}

                    <TextField
                        label="Product Tag to Filter"
                        value={tag}
                        onChange={setTag}
                        autoComplete="off"
                        helpText="Products with this tag will be fetched for matching."
                        disabled={isEmbedded}
                    />
                    <Banner tone="info">
                        <p>Select the root folder containing your product subfolders. The app will verify folders match the product titles.</p>
                    </Banner>

                    <Button
                        variant="primary"
                        onClick={handleScan}
                        loading={loading}
                        disabled={!tag || isEmbedded}
                    >
                        Select Root Folder & Start Scan
                    </Button>

                    {globalError && <Banner tone="critical"><p>{globalError}</p></Banner>}
                </BlockStack>
            </Card>
        );
    }

    if (step === 'confirming') {
        const matchedRows = matchResults.matched.map(m => [
            <Checkbox checked={m.checked} onChange={() => toggleCheck(m.id)} />,
            m.folderName,
            m.product.title,
            m.imageCount,
            <Badge tone="success">Matched</Badge>
        ]);

        const unmatchedRows = matchResults.unmatched.map(u => [
            <Checkbox disabled />,
            '-',
            u.product.title,
            '-',
            <Badge tone="subdued">Unmatched</Badge>
        ]);

        const collisionRows = matchResults.collisions.flatMap(c =>
            c.candidates.map((cand, idx) => [
                <Checkbox disabled />,
                cand,
                idx === 0 ? c.product.title : '...',
                '-',
                <Badge tone="critical">Collision</Badge>
            ])
        );

        return (
            <BlockStack gap="400">
                <Banner title="Scan Complete">
                    <p><strong>{matchResults.matched.length}</strong> products matched and ready for upload.</p>
                    <p>{matchResults.unmatched.length} unmatched. {matchResults.collisions.length} collisions.</p>
                </Banner>

                <Card>
                    <DataTable
                        columnContentTypes={['text', 'text', 'text', 'numeric', 'text']}
                        headings={['Select', 'Folder Name', 'Shopify Product', 'Photos', 'Status']}
                        rows={[...matchedRows, ...collisionRows, ...unmatchedRows]}
                    />
                </Card>

                <InlineGrid columns={2} gap="400">
                    <Button onClick={() => setStep('input')}>Cancel</Button>
                    <Button variant="primary" onClick={handleUpload} loading={loading}>
                        Start Upload ({matchResults.matched.filter(m => m.checked).length} Products)
                    </Button>
                </InlineGrid>
            </BlockStack>
        );
    }

    if (step === 'uploading') {
        return (
            <Card>
                <BlockStack gap="400">
                    <Text as="h2" variant="headingMd">Uploading Images...</Text>
                    <ProgressBar progress={(uploadProgress.current / uploadProgress.total) * 100} />
                    <Text>{uploadProgress.current} / {uploadProgress.total} images processed</Text>

                    <Box background="bg-surface-secondary" padding="400" borderRadius="200" style={{ maxHeight: '300px', overflowY: 'auto' }}>
                        <BlockStack gap="200">
                            {uploadProgress.log.map((l, i) => (
                                <Text key={i} tone={l.tone} variant="bodySm">{l.msg}</Text>
                            ))}
                        </BlockStack>
                    </Box>

                    {!loading && <Button onClick={() => setStep('input')}>Done</Button>}
                </BlockStack>
            </Card>
        );
    }
}
