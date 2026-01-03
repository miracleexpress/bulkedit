import os
import sys
import json
import argparse
import requests
import re
from tqdm import tqdm
from pathlib import Path

# --- CONFIG ---
SHOPIFY_API_VERSION = "2024-10" # Update as needed

def normalize_token(text):
    """
    Strict Tokenization:
    - Lowercase
    - Keep only Unicode alphanumeric characters
    - Replace everything else with space
    - Split by whitespace
    """
    if not text:
        return []
    
    # 1. Lowercase
    text = text.lower()
    
    # 2. Iterate chars, keep alnum, else space
    # Python's isalnum() is Unicode-aware (checks Unicode properties)
    clean_chars = []
    for char in text:
        if char.isalnum():
            clean_chars.append(char)
        else:
            clean_chars.append(" ")
    
    cleaned_text = "".join(clean_chars)
    
    # 3. Split
    return cleaned_text.split()

def get_offline_token(base_url, secret, shop=None):
    """Fetch offline access token from internal endpoint."""
    url = f"{base_url}/api/internal/offline-token"
    headers = {"X-SECRET": secret}
    params = {}
    if shop:
        params["shop"] = shop
    
    print(f"🔑 Fetching token from {url}...")
    try:
        resp = requests.get(url, headers=headers, params=params, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            print(f"✅ Token acquired for shop: {data['shop']}")
            return data["accessToken"], data["shop"]
        elif resp.status_code == 401:
            print("❌ Unauthorized: Invalid Secret")
            sys.exit(1)
        elif resp.status_code == 404:
            print("❌ No offline session found")
            sys.exit(1)
        else:
            print(f"❌ Error fetching token: {resp.status_code} {resp.text}")
            sys.exit(1)
    except Exception as e:
        print(f"❌ Connection error: {e}")
        sys.exit(1)

def graphql_query(shop, access_token, query, variables=None):
    """Execute Shopify Admin GraphQL Query."""
    url = f"https://{shop}/admin/api/{SHOPIFY_API_VERSION}/graphql.json"
    headers = {
        "X-Shopify-Access-Token": access_token,
        "Content-Type": "application/json"
    }
    resp = requests.post(url, json={"query": query, "variables": variables}, headers=headers)
    resp.raise_for_status()
    result = resp.json()
    if "errors" in result:
        raise Exception(f"GraphQL Error: {json.dumps(result['errors'])}")
    if "data" not in result:
        raise Exception("No data in GraphQL response")
    return result["data"]

def fetch_products_by_tag(shop, access_token, tag):
    """Fetch all products with the given tag."""
    print(f"📦 Fetching products with tag: '{tag}'...")
    query = """
    query getProducts($query: String!, $cursor: String) {
      products(first: 250, after: $cursor, query: $query) {
        edges {
          node {
            id
            title
            handle
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
    """
    
    all_products = []
    cursor = None
    has_next = True
    
    with tqdm(desc="Fetching Products", unit="page") as pbar:
        while has_next:
            data = graphql_query(shop, access_token, query, {"query": f"tag:{tag}", "cursor": cursor})
            products_data = data["products"]
            
            for edge in products_data["edges"]:
                all_products.append(edge["node"])
            
            has_next = products_data["pageInfo"]["hasNextPage"]
            cursor = products_data["pageInfo"]["endCursor"]
            pbar.update(1)
            
    print(f"✅ Found {len(all_products)} products.")
    return all_products

def scan_folders(root_folder):
    """Scan root folder for product folders containing 'Etulle Shopify'."""
    print(f"📂 Scanning folders in: {root_folder}")
    valid_folders = []
    
    if not os.path.exists(root_folder):
        print("❌ Root folder does not exist!")
        sys.exit(1)

    # List only directories
    candidates = [d for d in os.listdir(root_folder) if os.path.isdir(os.path.join(root_folder, d))]
    
    for folder_name in candidates:
        full_path = os.path.join(root_folder, folder_name)
        # Check for "Etulle Shopify" subfolder (case-insensitive)
        sub_path = None
        for sub in os.listdir(full_path):
            if sub.lower() == "etulle shopify":
                 sub_path = os.path.join(full_path, sub)
                 break
        
        if sub_path and os.path.isdir(sub_path):
            # Found valid product folder
            # List images
            images = []
            for f in os.listdir(sub_path):
                if f.lower().endswith(('.jpg', '.jpeg', '.png', '.webp')):
                    images.append(os.path.join(sub_path, f))
            
            # Numeric Sort: _1, _2, _10...
            # We assume filenames have numbers. If not, simple sort.
            # Using regex to find last number for robust numeric sort if defined, strictly use name
            # User requirement: "numeric sort (_1, _2, _10)"
            # Let's use a natural sort key
            images.sort(key=lambda s: [int(t) if t.isdigit() else t.lower() for t in re.split('(\d+)', s)])
            
            if len(images) > 0:
                valid_folders.append({
                    "name": folder_name,
                    "path": sub_path,
                    "images": images,
                    "tokens": set(normalize_token(folder_name)) # Set for faster subset check
                })
    
    print(f"✅ Found {len(valid_folders)} folders with content.")
    return valid_folders

def match_products_to_folders(products, folders):
    """
    Match products to folders using Token Subset logic.
    Product matched if: Set(Product Tokens) <= Set(Folder Tokens)
    """
    print("🧩 Matching products to folders...")
    
    matched = []
    unmatched = []
    collisions = []
    
    # Pre-process product tokens
    product_map = []
    for p in products:
        p_tokens = set(normalize_token(p["title"]))
        product_map.append({
            "product": p,
            "tokens": p_tokens
        })
        
    for item in tqdm(product_map, desc="Matching"):
        p = item["product"]
        p_tokens = item["tokens"]
        
        if not p_tokens:
            unmatched.append({"product": p["title"], "reason": "No matched tokens"})
            continue
            
        candidate_folders = []
        for f in folders:
            # Check subset
            if p_tokens.issubset(f["tokens"]):
                candidate_folders.append(f)
        
        if len(candidate_folders) == 1:
            matched.append({
                "product": p,
                "folder": candidate_folders[0]
            })
        elif len(candidate_folders) > 1:
            collisions.append({
                "product": p["title"],
                "folders": [f["name"] for f in candidate_folders]
            })
        else:
            unmatched.append({"product": p["title"]})
            
    return matched, unmatched, collisions

def upload_image(shop, access_token, product_id, file_path):
    """
    Upload a single image to Shopify:
    1. structuredUploadsCreate (get url)
    2. PUT (upload bytes)
    3. productCreateMedia (link to product)
    """
    filename = os.path.basename(file_path)
    filesize = str(os.path.getsize(file_path))
    mime_type = "image/jpeg"
    if filename.lower().endswith(".png"): mime_type = "image/png"
    elif filename.lower().endswith(".webp"): mime_type = "image/webp"

    # 1. Staged Upload Create
    staged_query = """
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
        userErrors { field message }
      }
    }
    """
    staged_vars = {
        "input": [{
            "filename": filename,
            "mimeType": mime_type,
            "resource": "IMAGE",
            "fileSize": filesize,
            "httpMethod": "POST" 
        }]
    }
    
    # Note: Modern Shopify logic for resource IMAGE often allows POST with multipart.
    # We will try the standard POST flow which is safer for larger files and widely supported.
    
    res = graphql_query(shop, access_token, staged_query, staged_vars)
    if res["stagedUploadsCreate"]["userErrors"]:
        raise Exception(f"Staged Upload Error: {res['stagedUploadsCreate']['userErrors']}")
        
    target = res["stagedUploadsCreate"]["stagedTargets"][0]
    upload_url = target["url"]
    parameters = target["parameters"]
    resource_url = target["resourceUrl"]
    
    # 2. Upload File (Multipart POST)
    # Prepare form data
    form_data = {p["name"]: p["value"] for p in parameters}
    
    # 'file' must be the last field in the form
    with open(file_path, 'rb') as f:
        files = {'file': (filename, f, mime_type)}
        upload_resp = requests.post(upload_url, data=form_data, files=files, timeout=60)
        upload_resp.raise_for_status()

    # 3. File Create (Register the file)
    # Important: For 'IMAGE' resource, sometimes we can go straight to productCreateMedia with resourceUrl,
    # but strictly creating the file object first ensures it's fully registered in Shopify Files API if needed.
    # However, productCreateMedia accepts 'originalSource'.
    # For robustness as requested: We will try to create the media directly using the resourceUrl.
    # If that fails historically, we'd use fileCreate. But standard "bulk" approaches usually use resourceUrl directly.
    # The prompt requested: "some versions need fileCreate". Let's add it to be safe.
    
    file_create_query = """
    mutation fileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
        }
        userErrors { field message }
      }
    }
    """
    file_create_vars = {
        "files": [{
            "originalSource": resource_url,
            "filename": filename
        }]
    }
    
    fc_res = graphql_query(shop, access_token, file_create_query, file_create_vars)
    if fc_res["fileCreate"]["userErrors"]:
        raise Exception(f"File Create Error: {fc_res['fileCreate']['userErrors']}")
    
    # Wait for file to be ready? usually fileCreate is async.
    # But productCreateMedia can take the source directly too. 
    # Actually, if we use fileCreate, we get a file ID (gid://shopify/File/...).
    # productCreateMedia accepts `media: { originalSource: ... }`.
    # It does NOT accept fileId directly in all versions (usually mediaContentType: IMAGE + originalSource).
    # So using `resource_url` (the staged upload result) as `originalSource` is the standard path.
    # The `fileCreate` might be redundant for *product media* specifically (unlike "Files" section),
    # but let's stick to using the `resource_url` which effectively points to the uploaded content.
    
    final_source = resource_url

    # 4. Product Create Media
    media_query = """
    mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $productId, media: $media) {
        media {
          id
          status
          mediaErrors { code details }
        }
        mediaUserErrors { field message }
      }
    }
    """
    
    media_vars = {
        "productId": product_id,
        "media": [{
            "originalSource": final_source,
            "mediaContentType": "IMAGE"
        }]
    }
    
    m_res = graphql_query(shop, access_token, media_query, media_vars)
    if m_res["productCreateMedia"]["mediaUserErrors"]:
        raise Exception(f"Media Attach Error: {m_res['productCreateMedia']['mediaUserErrors']}")

    return True

# --- MAIN ---

def main():
    parser = argparse.ArgumentParser(description="Bulk Upload Images to Shopify")
    parser.add_argument("--app_base_url", required=True, help="App base URL (e.g. https://yourapp.onrender.com)")
    parser.add_argument("--secret", required=True, help="Internal Secret")
    parser.add_argument("--shop", help="Simple shop domain (optional)")
    parser.add_argument("--tag", required=True, help="Product Tag to search")
    parser.add_argument("--root_folder", required=True, help="Local root folder path")
    parser.add_argument("--dry_run", type=str, default="false", help="true/false")
    
    args = parser.parse_args()
    is_dry_run = args.dry_run.lower() == "true"
    
    print("🚀 Starting Bulk Uploader Script")
    if is_dry_run:
        print("⚠️  DRY RUN MODE: No changes will be made.")
        
    # 1. Get Token
    access_token, shop_domain = get_offline_token(args.app_base_url, args.secret, args.shop)
    
    # 2. Fetch Products
    products = fetch_products_by_tag(shop_domain, access_token, args.tag)
    if not products:
        print("No products found.")
        return

    # 3. Scan Folders
    folders = scan_folders(args.root_folder)
    if not folders:
        print("No valid image folders found.")
        return

    # 4. Match
    matched, unmatched, collisions = match_products_to_folders(products, folders)
    
    # 5. Report & Stats
    print("\n📊 MATCHING SUMMARY:")
    print(f"   Matched: {len(matched)}")
    print(f"   Unmatched: {len(unmatched)}")
    print(f"   Collisions: {len(collisions)}")
    
    # Write JSON reports
    with open("matched.json", "w", encoding="utf-8") as f:
        json.dump(matched, f, indent=2, default=str)
    with open("unmatched.json", "w", encoding="utf-8") as f:
        json.dump(unmatched, f, indent=2)
    with open("collisions.json", "w", encoding="utf-8") as f:
        json.dump(collisions, f, indent=2)
        
    print("📝 saved matched.json, unmatched.json, collisions.json")
    
    if len(collisions) > 0:
        print("⚠️  WARNING: Collisions detected. See collisions.json. These will be SKIPPED.")
        
    if is_dry_run:
        print("\n🛑 Dry run complete. Exiting.")
        return

    # 6. Upload
    print("\n🚀 Starting Uploads for MATCHED items...")
    
    upload_log = []
    
    for item in tqdm(matched, desc="Processing Products"):
        product = item["product"]
        folder = item["folder"]
        images = folder["images"]
        
        product_log = {
            "title": product["title"],
            "folder": folder["name"],
            "results": []
        }
        
        print(f"\nProcessing: {product['title']} ({len(images)} images)")
        
        for img_path in images:
            filename = os.path.basename(img_path)
            try:
                upload_image(shop_domain, access_token, product["id"], img_path)
                print(f"   ✅ Uploaded: {filename}")
                product_log["results"].append({"file": filename, "status": "success"})
            except Exception as e:
                print(f"   ❌ Failed: {filename} - {e}")
                product_log["results"].append({"file": filename, "status": "failed", "error": str(e)})
                
        upload_log.append(product_log)
        
    # Save Upload Log
    with open("upload_log.json", "w", encoding="utf-8") as f:
        json.dump(upload_log, f, indent=2)
    
    print("\n✅ Bulk Upload Process Completed!")

if __name__ == "__main__":
    main()
