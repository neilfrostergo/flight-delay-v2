# Azure Infrastructure — Flight Delay v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision the complete Azure production infrastructure for delayedpaid.co.uk — a private, secure, scalable hosting environment for the flight-delay-v2 Node.js app.

**Architecture:** The app runs in Azure Container Apps (serverless containers) inside a private Virtual Network. All traffic enters through Azure Front Door (the security guard at the internet's edge) via a private connection — the app itself has no public IP address. Secrets are stored in Azure Key Vault and accessed without any passwords via Managed Identity.

**Tech Stack:** Azure Container Apps · Azure Database for PostgreSQL Flexible Server · Azure Front Door Premium · Azure Virtual Network · Azure Key Vault · Azure Container Registry · Azure Communication Services · NAT Gateway · GitHub Actions (OIDC)

---

## 🗺️ Naming Conventions

Everything in this plan uses these names. They are consistent throughout — don't change them mid-way or you'll get confused.

| What | Name | Notes |
|---|---|---|
| Resource Group | `fdv2-prod-rg` | The "folder" containing everything |
| Location | `uksouth` | UK South Azure datacentre |
| Virtual Network | `fdv2-vnet` | The private network |
| Container Apps subnet | `fdv2-aca-subnet` | 10.100.0.0/21 |
| Database subnet | `fdv2-data-subnet` | 10.100.8.0/24 |
| Private Endpoints subnet | `fdv2-pe-subnet` | 10.100.9.0/24 |
| PostgreSQL server | `fdv2-postgres` | Must be globally unique |
| Database name | `flightdelay` | |
| Key Vault | `fdv2-keyvault` | Must be globally unique — add `-<yourname>` if taken |
| Container Registry | `fdv2acr` | No hyphens, lowercase only |
| Container Apps Environment | `fdv2-aca-env` | |
| Container App | `fdv2-app` | |
| Managed Identity | `fdv2-identity` | The "badge" that lets the app access Key Vault without a password |
| Front Door | `fdv2-frontdoor` | |
| WAF Policy | `fdv2WafPolicy` | |
| Log Analytics | `fdv2-logs` | |
| ACS (email) | `fdv2-comms` | |
| NAT Gateway | `fdv2-nat` | |
| NAT Public IP | `fdv2-nat-pip` | |

---

## ⚠️ Subnet Size Note

The architecture spec listed Container Apps as 10.100.1.0/24. Azure actually requires a *minimum* /21 (2,048 addresses) for a private Container Apps environment with internal load balancer. This plan uses **10.100.0.0/21** instead — the app works identically, there's just more room to scale.

---

## Task 0: Install Azure CLI and Sign In

**What this is:** The Azure CLI ("az") is a command-line tool — you type commands in your Terminal (Mac) or PowerShell (Windows) and it talks to Azure for you. Think of it like a remote control for your Azure account. Every command in this plan starts with `az`.

**Files:**
- None (this is setup only)

- [ ] **Step 1: Install the Azure CLI**

  **Mac (Terminal):**
  ```bash
  brew install azure-cli
  ```
  If you don't have Homebrew: open Terminal and run `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"` first.

  **Windows (PowerShell as Administrator):**
  ```powershell
  winget install Microsoft.AzureCLI
  ```

  **Verify it installed:**
  ```bash
  az --version
  ```
  Expected: You see something like `azure-cli 2.x.x` — version number doesn't matter, just that it printed.

- [ ] **Step 2: Sign in to Azure**

  ```bash
  az login
  ```
  This opens a browser window. Log in with the Microsoft account attached to your Azure subscription. Come back to the terminal when it says "You have logged in."

- [ ] **Step 3: Check you're in the right subscription**

  ```bash
  az account show --output table
  ```
  Expected output (your details will differ):
  ```
  Name                    CloudName    SubscriptionId                        TenantId     ...  IsDefault
  ----------------------  -----------  ------------------------------------  -----------  ...  -----------
  My Azure Subscription   AzureCloud   xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx  ...          ...  True
  ```
  If you have multiple subscriptions and the wrong one shows as default, set the correct one:
  ```bash
  az account set --subscription "YOUR SUBSCRIPTION NAME OR ID"
  ```

- [ ] **Step 4: Store your subscription ID — you'll need it later**

  ```bash
  az account show --query id --output tsv
  ```
  Copy the output (looks like `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) and paste it somewhere. You'll need it in Task 10.

---

## Task 1: Create the Resource Group

**What this is:** A Resource Group is like a folder on your computer. Every Azure resource you create (database, server, network) goes into this folder. If you ever want to delete everything and start fresh, you just delete the folder and everything inside disappears. It also makes it easy to see what you're spending money on.

**Files:**
- None

- [ ] **Step 1: Create the resource group**

  ```bash
  az group create \
    --name fdv2-prod-rg \
    --location uksouth
  ```

  **What `--location uksouth` means:** This tells Azure which physical datacentre building to put your stuff in. `uksouth` is in London, which is the best choice for a UK-based product.

  Expected output:
  ```json
  {
    "id": "/subscriptions/.../resourceGroups/fdv2-prod-rg",
    "location": "uksouth",
    "name": "fdv2-prod-rg",
    "properties": { "provisioningState": "Succeeded" }
  }
  ```
  The important bit is `"provisioningState": "Succeeded"`.

- [ ] **Step 2: Verify it exists**

  ```bash
  az group show --name fdv2-prod-rg --output table
  ```
  Expected: A row showing `fdv2-prod-rg` in `uksouth`.

  **Portal alternative:** Go to [portal.azure.com](https://portal.azure.com) → search "Resource groups" in the top search bar → click the result → you should see `fdv2-prod-rg` in the list.

---

## Task 2: Create the Virtual Network and Subnets

**What this is:** A Virtual Network (VNet) is like building a private office building. Your servers will live inside this building. Nobody from the internet can walk in directly — they can only come in through the front desk (Azure Front Door, which we set up in Task 8). The subnets are like different floors of the building: the app lives on floor 1, the database on floor 2, and the secure key storage on floor 3.

**Files:**
- None

- [ ] **Step 1: Create the Virtual Network**

  ```bash
  az network vnet create \
    --name fdv2-vnet \
    --resource-group fdv2-prod-rg \
    --location uksouth \
    --address-prefixes 10.100.0.0/16
  ```

  **What `10.100.0.0/16` means:** This is the address space — like saying "our building will have addresses from 10.100.0.0 to 10.100.255.255". That's 65,536 possible addresses, plenty of room to grow.

  Expected: JSON output with `"provisioningState": "Succeeded"`.

- [ ] **Step 2: Create the Container Apps subnet**

  This is the floor where your Node.js app will run. It needs a /21 (2,048 addresses) because Azure's Container Apps service reserves a large block internally for its own routing.

  ```bash
  az network vnet subnet create \
    --name fdv2-aca-subnet \
    --resource-group fdv2-prod-rg \
    --vnet-name fdv2-vnet \
    --address-prefixes 10.100.0.0/21 \
    --delegations Microsoft.App/environments
  ```

  **What `--delegations Microsoft.App/environments` means:** You're telling Azure "this floor is reserved for Container Apps only." No other service can accidentally move in.

  Expected: JSON output with `"provisioningState": "Succeeded"`.

- [ ] **Step 3: Create the database subnet**

  This is the floor where PostgreSQL lives. It also needs a delegation.

  ```bash
  az network vnet subnet create \
    --name fdv2-data-subnet \
    --resource-group fdv2-prod-rg \
    --vnet-name fdv2-vnet \
    --address-prefixes 10.100.8.0/24 \
    --delegations Microsoft.DBforPostgreSQL/flexibleServers
  ```

- [ ] **Step 4: Create the Private Endpoints subnet**

  This is where secure, private connections to Key Vault and Event Hub will be anchored. No delegation needed here.

  ```bash
  az network vnet subnet create \
    --name fdv2-pe-subnet \
    --resource-group fdv2-prod-rg \
    --vnet-name fdv2-vnet \
    --address-prefixes 10.100.9.0/24
  ```

- [ ] **Step 5: Verify all three subnets exist**

  ```bash
  az network vnet subnet list \
    --resource-group fdv2-prod-rg \
    --vnet-name fdv2-vnet \
    --output table
  ```
  Expected: Three rows — `fdv2-aca-subnet`, `fdv2-data-subnet`, `fdv2-pe-subnet`.

---

## Task 3: Create the PostgreSQL Database Server

**What this is:** This is your database — the same PostgreSQL 16 you're running locally with Docker, but now it's a fully managed service in Azure. "Managed" means Azure handles backups, security patches, and automatic failover if a server dies. You just connect to it and use it like a normal database.

**Zone-redundant HA** means Azure runs two copies — one active, one on standby in a different building. If the active one breaks, it switches to the standby in about 60 seconds. Your app barely notices.

**Files:**
- None (this provisions infrastructure, app config updated in Task 7)

- [ ] **Step 1: Create the PostgreSQL server**

  This takes 5–10 minutes. The `--` flag for `admin-password` — use a strong password (16+ chars, mix of upper/lower/numbers/symbols). **Save this password somewhere safe** — you will need it to connect.

  ```bash
  az postgres flexible-server create \
    --name fdv2-postgres \
    --resource-group fdv2-prod-rg \
    --location uksouth \
    --admin-user fdv2admin \
    --admin-password "REPLACE_WITH_STRONG_PASSWORD" \
    --sku-name Standard_D2s_v3 \
    --tier GeneralPurpose \
    --storage-size 128 \
    --version 16 \
    --high-availability ZoneRedundant \
    --vnet fdv2-vnet \
    --subnet fdv2-data-subnet \
    --private-dns-zone fdv2-postgres.private.postgres.database.azure.com \
    --yes
  ```

  **What each flag means:**
  - `--sku-name Standard_D2s_v3` — The server size. D2s = 2 CPU cores, 8GB RAM. Good for production, can scale up later.
  - `--tier GeneralPurpose` — The performance category. Burstable is cheaper but slower. GeneralPurpose is consistent.
  - `--storage-size 128` — 128 GB disk. Expands automatically if needed.
  - `--high-availability ZoneRedundant` — Two copies in different buildings. If one breaks, the other takes over.
  - `--vnet` / `--subnet` — Puts the database inside your private network (no internet access).
  - `--private-dns-zone` — Creates a private "phone book" so your app can find the database by name inside the VNet.

  Expected: `"provisioningState": "Succeeded"` (takes several minutes).

- [ ] **Step 2: Create the application database**

  ```bash
  az postgres flexible-server db create \
    --resource-group fdv2-prod-rg \
    --server-name fdv2-postgres \
    --database-name flightdelay
  ```

  Expected: `"provisioningState": "Succeeded"`.

- [ ] **Step 3: Note the connection string**

  ```bash
  az postgres flexible-server show \
    --name fdv2-postgres \
    --resource-group fdv2-prod-rg \
    --query fullyQualifiedDomainName \
    --output tsv
  ```
  Output will be something like `fdv2-postgres.postgres.database.azure.com`. Your `DATABASE_URL` will be:
  ```
  postgresql://fdv2admin:YOUR_PASSWORD@fdv2-postgres.postgres.database.azure.com:5432/flightdelay?sslmode=require
  ```
  Save this — you'll put it in Key Vault in the next task.

---

## Task 4: Create Azure Key Vault

**What this is:** Key Vault is a super-secure safe for your secrets — passwords, API keys, encryption keys. Instead of putting `JWT_SECRET=abc123` directly in your server's environment variables (where anyone who can see the server settings can read it), you put it in Key Vault and the app has permission to read it. Nobody else can. It's like a safety deposit box that only your app's "badge" (the Managed Identity) can open.

**Files:**
- None

- [ ] **Step 1: Create the Key Vault**

  Key Vault names must be globally unique across all of Azure. If `fdv2-keyvault` is taken, add your initials: `fdv2-keyvault-nf`.

  ```bash
  az keyvault create \
    --name fdv2-keyvault \
    --resource-group fdv2-prod-rg \
    --location uksouth \
    --sku standard \
    --enable-rbac-authorization true
  ```

  **What `--enable-rbac-authorization true` means:** RBAC = "who is allowed to do what". This means we control Key Vault access using Azure's standard permissions system (rather than an older, separate system). More secure and easier to manage.

  Expected: JSON with `"provisioningState": "Succeeded"`.

- [ ] **Step 2: Create a Managed Identity for the app**

  A Managed Identity is like a photo ID badge for your app. It proves to Key Vault "this request is really coming from your app, not from a random person on the internet." No password needed.

  ```bash
  az identity create \
    --name fdv2-identity \
    --resource-group fdv2-prod-rg \
    --location uksouth
  ```

  Save the `clientId` from the output — you'll need it in Task 7.

  ```bash
  az identity show \
    --name fdv2-identity \
    --resource-group fdv2-prod-rg \
    --query "{clientId:clientId, principalId:principalId}" \
    --output table
  ```
  Note down both `clientId` and `principalId`.

- [ ] **Step 3: Give the Managed Identity permission to read secrets**

  This is like adding the app's badge to the "allowed list" at the Key Vault.

  ```bash
  # Get the Key Vault's resource ID
  KV_ID=$(az keyvault show --name fdv2-keyvault --resource-group fdv2-prod-rg --query id --output tsv)

  # Get the identity's principal ID
  IDENTITY_PRINCIPAL=$(az identity show --name fdv2-identity --resource-group fdv2-prod-rg --query principalId --output tsv)

  # Grant it "Key Vault Secrets User" role (read-only)
  az role assignment create \
    --assignee $IDENTITY_PRINCIPAL \
    --role "Key Vault Secrets User" \
    --scope $KV_ID
  ```

  Expected: JSON with `"roleDefinitionName": "Key Vault Secrets User"`.

- [ ] **Step 4: Add placeholder secrets**

  These are the secrets the app needs. Fill in real values — the database URL from Task 3, and generate the crypto keys using the commands shown.

  ```bash
  # Generate JWT_SECRET (run this, copy the output)
  node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

  # Generate ENCRYPTION_KEY (run this, copy the output)
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

  Now add each secret to Key Vault:

  ```bash
  az keyvault secret set --vault-name fdv2-keyvault --name "DATABASE-URL" \
    --value "postgresql://fdv2admin:YOUR_PASSWORD@fdv2-postgres.postgres.database.azure.com:5432/flightdelay?sslmode=require"

  az keyvault secret set --vault-name fdv2-keyvault --name "JWT-SECRET" \
    --value "PASTE_64_CHAR_HEX_HERE"

  az keyvault secret set --vault-name fdv2-keyvault --name "ENCRYPTION-KEY" \
    --value "PASTE_32_CHAR_HEX_HERE"

  az keyvault secret set --vault-name fdv2-keyvault --name "SMTP-HOST" \
    --value "placeholder-update-in-task-11"

  az keyvault secret set --vault-name fdv2-keyvault --name "SMTP-PORT" \
    --value "587"

  az keyvault secret set --vault-name fdv2-keyvault --name "SMTP-USER" \
    --value "placeholder-update-in-task-11"

  az keyvault secret set --vault-name fdv2-keyvault --name "SMTP-PASS" \
    --value "placeholder-update-in-task-11"

  az keyvault secret set --vault-name fdv2-keyvault --name "ADMIN-SEED-PASSWORD" \
    --value "REPLACE_WITH_STRONG_ADMIN_PASSWORD"
  ```

  The admin seed password is what you'll use to log into the superadmin account the first time. Pick something strong and save it somewhere safe.

  **Note:** Hyphens are used in Key Vault names (not underscores). When the app reads them via the Azure SDK or environment variable references, they map back to the underscore versions.

- [ ] **Step 5: Create a private endpoint for Key Vault**

  This step makes Key Vault accessible only from inside your VNet — not from the internet.

  ```bash
  KV_ID=$(az keyvault show --name fdv2-keyvault --resource-group fdv2-prod-rg --query id --output tsv)

  az network private-endpoint create \
    --name fdv2-kv-pe \
    --resource-group fdv2-prod-rg \
    --vnet-name fdv2-vnet \
    --subnet fdv2-pe-subnet \
    --private-connection-resource-id $KV_ID \
    --group-id vault \
    --connection-name fdv2-kv-connection
  ```

- [ ] **Step 6: Create a private DNS zone for Key Vault**

  Without this, your app inside the VNet can't "find" the Key Vault by name. This is the internal phone book.

  ```bash
  az network private-dns zone create \
    --resource-group fdv2-prod-rg \
    --name "privatelink.vaultcore.azure.net"

  az network private-dns link vnet create \
    --resource-group fdv2-prod-rg \
    --zone-name "privatelink.vaultcore.azure.net" \
    --name fdv2-kv-dns-link \
    --virtual-network fdv2-vnet \
    --registration-enabled false

  # Get the private endpoint NIC ID and register the DNS A record
  PE_NIC_ID=$(az network private-endpoint show \
    --name fdv2-kv-pe \
    --resource-group fdv2-prod-rg \
    --query "networkInterfaces[0].id" --output tsv)

  PE_IP=$(az network nic show --ids $PE_NIC_ID \
    --query "ipConfigurations[0].privateIPAddress" --output tsv)

  az network private-dns record-set a add-record \
    --resource-group fdv2-prod-rg \
    --zone-name "privatelink.vaultcore.azure.net" \
    --record-set-name fdv2-keyvault \
    --ipv4-address $PE_IP
  ```

  Expected: `"provisioningState": "Succeeded"` for each command.

---

## Task 5: Create Azure Container Registry

**What this is:** Container Registry (ACR) is a private storage room for your Docker images. When GitHub Actions builds your app into a Docker image, it needs somewhere private to store it. ACR is that place — only your Azure account can push or pull images from it. Think of Docker Hub but with a lock on it.

**Files:**
- None

- [ ] **Step 1: Create the registry**

  ACR names must be globally unique and contain only lowercase letters and numbers (no hyphens).

  ```bash
  az acr create \
    --name fdv2acr \
    --resource-group fdv2-prod-rg \
    --location uksouth \
    --sku Basic
  ```

  **What Basic SKU means:** There are three tiers — Basic (cheap, ~£4/month), Standard, and Premium. Basic is fine for a single app. You can upgrade later with one command if needed.

  Expected: JSON with `"provisioningState": "Succeeded"` and `"loginServer": "fdv2acr.azurecr.io"`.

- [ ] **Step 2: Build and push the first Docker image**

  This builds your app's Docker image and pushes it to ACR. Run this from the root of the `flight-delay-v2` repository.

  ```bash
  # Log in to the registry
  az acr login --name fdv2acr

  # Build and push using ACR's built-in build service (no Docker needed locally)
  az acr build \
    --registry fdv2acr \
    --image fdv2-app:latest \
    --file Dockerfile \
    .
  ```

  This sends your code to Azure, builds it there, and stores the image. Takes 2–5 minutes.

  Expected final line: `Run ID: ca1 was successful after ...`

- [ ] **Step 3: Verify the image is stored**

  ```bash
  az acr repository show-tags \
    --name fdv2acr \
    --repository fdv2-app \
    --output table
  ```
  Expected: `latest` in the results.

---

## Task 6: Create the Container Apps Environment

**What this is:** Container Apps Environment is the "office building" that your containers run inside. It handles all the boring infrastructure stuff — networking, load balancing, scaling up when there are more requests, and scaling down when it's quiet (even to zero at night, saving money). You just tell it "run this Docker image" and it figures out the rest.

**Files:**
- None

- [ ] **Step 1: Install the Container Apps CLI extension**

  ```bash
  az extension add --name containerapp --upgrade
  az provider register --namespace Microsoft.App
  az provider register --namespace Microsoft.OperationalInsights
  ```

  The second and third lines register the Container Apps service with your subscription. Azure sometimes needs this before you can use a new service.

  Wait ~30 seconds after running, then continue.

- [ ] **Step 2: Create a Log Analytics workspace**

  Log Analytics is where all your app's logs go. Think of it as a searchable filing cabinet for everything your app prints to the console.

  ```bash
  az monitor log-analytics workspace create \
    --resource-group fdv2-prod-rg \
    --workspace-name fdv2-logs \
    --location uksouth
  ```

  Get its ID and key — needed for the next step:

  ```bash
  LOG_WS_ID=$(az monitor log-analytics workspace show \
    --resource-group fdv2-prod-rg \
    --workspace-name fdv2-logs \
    --query customerId --output tsv)

  LOG_WS_KEY=$(az monitor log-analytics workspace get-shared-keys \
    --resource-group fdv2-prod-rg \
    --workspace-name fdv2-logs \
    --query primarySharedKey --output tsv)
  ```

- [ ] **Step 3: Get the Container Apps subnet resource ID**

  ```bash
  ACA_SUBNET_ID=$(az network vnet subnet show \
    --resource-group fdv2-prod-rg \
    --vnet-name fdv2-vnet \
    --name fdv2-aca-subnet \
    --query id --output tsv)
  ```

- [ ] **Step 4: Create the Container Apps Environment**

  This takes 5–10 minutes. `--internal-only true` means the environment has no public IP — only reachable from inside the VNet or via Front Door's private connection.

  ```bash
  az containerapp env create \
    --name fdv2-aca-env \
    --resource-group fdv2-prod-rg \
    --location uksouth \
    --logs-workspace-id $LOG_WS_ID \
    --logs-workspace-key $LOG_WS_KEY \
    --infrastructure-subnet-resource-id $ACA_SUBNET_ID \
    --internal-only true
  ```

  Expected: `"provisioningState": "Succeeded"`.

- [ ] **Step 5: Note the environment's internal domain**

  ```bash
  az containerapp env show \
    --name fdv2-aca-env \
    --resource-group fdv2-prod-rg \
    --query properties.defaultDomain \
    --output tsv
  ```
  Output looks like `fdv2-aca-env.internal.uksouth.azurecontainerapps.io`. Save this — you'll use it when configuring Front Door in Task 8.

---

## Task 7: Deploy the App to Container Apps

> **⚠️ If you closed your terminal since Task 4–6:** Shell variables don't survive terminal restarts. Re-run these at the top of your terminal session before continuing:
> ```bash
> IDENTITY_ID=$(az identity show --name fdv2-identity --resource-group fdv2-prod-rg --query id --output tsv)
> IDENTITY_CLIENT_ID=$(az identity show --name fdv2-identity --resource-group fdv2-prod-rg --query clientId --output tsv)
> ACR_ID=$(az acr show --name fdv2acr --resource-group fdv2-prod-rg --query id --output tsv)
> ```

**What this is:** Now we actually run your app. We create a "Container App" — a running instance of your Docker image. We connect it to Key Vault (using the Managed Identity from Task 4) so it can read all its secrets without storing any passwords.

**Files:**
- `server/.env.example` — reference only, to check env var names

- [ ] **Step 1: Give Container Apps permission to pull images from ACR**

  ```bash
  ACR_ID=$(az acr show --name fdv2acr --resource-group fdv2-prod-rg --query id --output tsv)
  IDENTITY_PRINCIPAL=$(az identity show --name fdv2-identity --resource-group fdv2-prod-rg --query principalId --output tsv)

  az role assignment create \
    --assignee $IDENTITY_PRINCIPAL \
    --role "AcrPull" \
    --scope $ACR_ID
  ```

- [ ] **Step 2: Get identity resource ID**

  ```bash
  IDENTITY_ID=$(az identity show \
    --name fdv2-identity \
    --resource-group fdv2-prod-rg \
    --query id --output tsv)

  IDENTITY_CLIENT_ID=$(az identity show \
    --name fdv2-identity \
    --resource-group fdv2-prod-rg \
    --query clientId --output tsv)
  ```

- [ ] **Step 3: Create the Container App**

  This deploys your app. Environment variables starting with `secretref:` pull their values from Key Vault at startup — the app never sees the raw secret value in its configuration, only in memory at runtime.

  Replace `YOUR_SUBSCRIPTION_ID` with the subscription ID you saved in Task 0 Step 4.

  ```bash
  az containerapp create \
    --name fdv2-app \
    --resource-group fdv2-prod-rg \
    --environment fdv2-aca-env \
    --image fdv2acr.azurecr.io/fdv2-app:latest \
    --registry-server fdv2acr.azurecr.io \
    --registry-identity $IDENTITY_ID \
    --user-assigned $IDENTITY_ID \
    --ingress internal \
    --target-port 3000 \
    --min-replicas 1 \
    --max-replicas 5 \
    --cpu 0.5 \
    --memory 1Gi \
    --env-vars \
      "NODE_ENV=production" \
      "PORT=3000" \
      "BASE_DOMAIN=delayedpaid.co.uk" \
      "AZURE_CLIENT_ID=$IDENTITY_CLIENT_ID" \
      "DATABASE_URL=secretref:database-url" \
      "JWT_SECRET=secretref:jwt-secret" \
      "ENCRYPTION_KEY=secretref:encryption-key" \
      "SMTP_HOST=secretref:smtp-host" \
      "SMTP_PORT=secretref:smtp-port" \
      "SMTP_USER=secretref:smtp-user" \
      "SMTP_PASS=secretref:smtp-pass" \
    --secrets \
      "database-url=keyvaultref:https://fdv2-keyvault.vault.azure.net/secrets/DATABASE-URL,identityref:$IDENTITY_ID" \
      "jwt-secret=keyvaultref:https://fdv2-keyvault.vault.azure.net/secrets/JWT-SECRET,identityref:$IDENTITY_ID" \
      "encryption-key=keyvaultref:https://fdv2-keyvault.vault.azure.net/secrets/ENCRYPTION-KEY,identityref:$IDENTITY_ID" \
      "smtp-host=keyvaultref:https://fdv2-keyvault.vault.azure.net/secrets/SMTP-HOST,identityref:$IDENTITY_ID" \
      "smtp-port=keyvaultref:https://fdv2-keyvault.vault.azure.net/secrets/SMTP-PORT,identityref:$IDENTITY_ID" \
      "smtp-user=keyvaultref:https://fdv2-keyvault.vault.azure.net/secrets/SMTP-USER,identityref:$IDENTITY_ID" \
      "smtp-pass=keyvaultref:https://fdv2-keyvault.vault.azure.net/secrets/SMTP-PASS,identityref:$IDENTITY_ID"
  ```

  **What `--ingress internal` means:** The app only accepts traffic from inside the VNet. Nobody on the internet can hit it directly — they have to go through Front Door (set up in Task 8).

  Expected: `"provisioningState": "Succeeded"`.

- [ ] **Step 4: Add the health endpoint to the app**

  Front Door needs a `/api/health` endpoint to check whether your app is alive. Add it to `server/src/index.js` — find the line where routes are mounted and add this just before it:

  ```js
  // Add this before any other route
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  ```

  Then rebuild and push the image to ACR:
  ```bash
  az acr build \
    --registry fdv2acr \
    --image fdv2-app:latest \
    --file Dockerfile \
    .
  ```

- [ ] **Step 5: Run the database migrations** *(renumbered — Step 4 is now the health endpoint)*

  The database tables need to be created. The app has a migration script (`npm run migrate`) that does this. We run it as a one-off job.

  ```bash
  az containerapp job create \
    --name fdv2-migrate \
    --resource-group fdv2-prod-rg \
    --environment fdv2-aca-env \
    --trigger-type Manual \
    --replica-timeout 300 \
    --image fdv2acr.azurecr.io/fdv2-app:latest \
    --registry-server fdv2acr.azurecr.io \
    --registry-identity $IDENTITY_ID \
    --user-assigned $IDENTITY_ID \
    --cpu 0.25 \
    --memory 0.5Gi \
    --command "npm" "run" "migrate" \
    --env-vars \
      "NODE_ENV=production" \
      "AZURE_CLIENT_ID=$IDENTITY_CLIENT_ID" \
      "DATABASE_URL=secretref:database-url" \
    --secrets \
      "database-url=keyvaultref:https://fdv2-keyvault.vault.azure.net/secrets/DATABASE-URL,identityref:$IDENTITY_ID"

  # Run the migration job
  az containerapp job start \
    --name fdv2-migrate \
    --resource-group fdv2-prod-rg
  ```

  Wait ~30 seconds, then check it succeeded:

  ```bash
  az containerapp job execution list \
    --name fdv2-migrate \
    --resource-group fdv2-prod-rg \
    --output table
  ```
  Expected: `Succeeded` status.

- [ ] **Step 6: Seed the superadmin user**

  This creates the initial superadmin login. It uses `ADMIN_SEED_PASSWORD` from Key Vault.

  ```bash
  IDENTITY_ID=$(az identity show --name fdv2-identity --resource-group fdv2-prod-rg --query id --output tsv)
  IDENTITY_CLIENT_ID=$(az identity show --name fdv2-identity --resource-group fdv2-prod-rg --query clientId --output tsv)

  az containerapp job create \
    --name fdv2-seed-admin \
    --resource-group fdv2-prod-rg \
    --environment fdv2-aca-env \
    --trigger-type Manual \
    --replica-timeout 120 \
    --image fdv2acr.azurecr.io/fdv2-app:latest \
    --registry-server fdv2acr.azurecr.io \
    --registry-identity $IDENTITY_ID \
    --user-assigned $IDENTITY_ID \
    --cpu 0.25 \
    --memory 0.5Gi \
    --command "npm" "run" "seed:admin" \
    --env-vars \
      "NODE_ENV=production" \
      "AZURE_CLIENT_ID=$IDENTITY_CLIENT_ID" \
      "DATABASE_URL=secretref:database-url" \
      "ADMIN_SEED_PASSWORD=secretref:admin-seed-password" \
    --secrets \
      "database-url=keyvaultref:https://fdv2-keyvault.vault.azure.net/secrets/DATABASE-URL,identityref:$IDENTITY_ID" \
      "admin-seed-password=keyvaultref:https://fdv2-keyvault.vault.azure.net/secrets/ADMIN-SEED-PASSWORD,identityref:$IDENTITY_ID"

  az containerapp job start \
    --name fdv2-seed-admin \
    --resource-group fdv2-prod-rg
  ```

  Wait ~30 seconds then verify:
  ```bash
  az containerapp job execution list \
    --name fdv2-seed-admin \
    --resource-group fdv2-prod-rg \
    --output table
  ```
  Expected: `Succeeded`. You can now log in to `/admin` with `superadmin` and the password you set in Key Vault.

- [ ] **Step 8: Verify the app is running**

  ```bash
  az containerapp show \
    --name fdv2-app \
    --resource-group fdv2-prod-rg \
    --query "properties.latestRevisionFqdn" \
    --output tsv
  ```
  This gives you the internal FQDN. The app isn't publicly reachable yet (that's what Front Door is for), but you can see the container is running:

  ```bash
  az containerapp show \
    --name fdv2-app \
    --resource-group fdv2-prod-rg \
    --query "properties.runningStatus" \
    --output tsv
  ```
  Expected: `Running`.

---

## Task 8: Azure Front Door Premium + WAF Policy

**What this is:** Front Door is the security guard and receptionist at the front of your building. Everyone on the internet talks to Front Door first. Front Door checks them against the WAF (Web Application Firewall) — a rulebook of known hacker tricks. If they pass, Front Door forwards their request to your app via a private tunnel. Your app never directly faces the internet.

This is the most complex task. Take your time.

**Files:**
- None

- [ ] **Step 1: Create the Front Door profile**

  ```bash
  az afd profile create \
    --profile-name fdv2-frontdoor \
    --resource-group fdv2-prod-rg \
    --sku Premium_AzureFrontDoor
  ```

  **Why Premium (not Standard)?** Only Premium supports Private Link origins — the private tunnel to your Container App. Standard doesn't have this feature.

  Expected: `"provisioningState": "Succeeded"`.

- [ ] **Step 2: Create the WAF policy**

  The WAF (Web Application Firewall) is a rulebook. It blocks requests that look like common hacker attacks — SQL injection (trying to break into the database), cross-site scripting (trying to run malicious code in users' browsers), and more.

  ```bash
  az network front-door waf-policy create \
    --name fdv2WafPolicy \
    --resource-group fdv2-prod-rg \
    --sku Premium_AzureFrontDoor \
    --mode Prevention
  ```

  **What `--mode Prevention` means:** Prevention mode actually *blocks* bad requests. The alternative, Detection, just logs them. We want to block them.

  Add the OWASP ruleset (industry-standard hacker-defence rules):

  ```bash
  az network front-door waf-policy managed-rules add \
    --policy-name fdv2WafPolicy \
    --resource-group fdv2-prod-rg \
    --type Microsoft_DefaultRuleSet \
    --version 2.1 \
    --action Block
  ```

  Add bot protection:

  ```bash
  az network front-door waf-policy managed-rules add \
    --policy-name fdv2WafPolicy \
    --resource-group fdv2-prod-rg \
    --type Microsoft_BotManagerRuleSet \
    --version 1.0 \
    --action Block
  ```

- [ ] **Step 3: Create an endpoint (your public-facing URL)**

  ```bash
  az afd endpoint create \
    --profile-name fdv2-frontdoor \
    --resource-group fdv2-prod-rg \
    --endpoint-name fdv2-endpoint \
    --enabled-state Enabled
  ```

  Note the hostname from the output — it'll be something like `fdv2-endpoint-xxxxxxxx.z01.azurefd.net`. This is what the world connects to for now. You'll replace it with `delayedpaid.co.uk` in Task 9.

- [ ] **Step 4: Create an origin group**

  An "origin group" is Front Door's concept for "the place to send traffic". You can have multiple origins for redundancy, but we have one (the Container App).

  ```bash
  az afd origin-group create \
    --profile-name fdv2-frontdoor \
    --resource-group fdv2-prod-rg \
    --origin-group-name fdv2-origin-group \
    --probe-request-type GET \
    --probe-protocol Https \
    --probe-interval-in-seconds 30 \
    --probe-path /api/health \
    --sample-size 4 \
    --successful-samples-required 3
  ```

  **What is the health probe?** Every 30 seconds, Front Door sends a request to `/api/health`. If the app responds OK, Front Door keeps sending traffic. If not, Front Door stops and waits. This means if your app crashes, Front Door knows about it quickly.

  **Note:** You may need to add a simple `/api/health` endpoint to the app that returns `200 OK`. Add this to `server/src/index.js`:
  ```js
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  ```
  Then rebuild and push (or this can be done as part of Task 10's CI setup).

- [ ] **Step 5: Add the Container App as a Private Link origin**

  Get the Container Apps environment resource ID:
  ```bash
  ACA_ENV_ID=$(az containerapp env show \
    --name fdv2-aca-env \
    --resource-group fdv2-prod-rg \
    --query id --output tsv)
  ```

  Get the Container App's internal hostname:
  ```bash
  APP_FQDN=$(az containerapp show \
    --name fdv2-app \
    --resource-group fdv2-prod-rg \
    --query properties.configuration.ingress.fqdn \
    --output tsv)
  ```

  Create the origin:
  ```bash
  az afd origin create \
    --profile-name fdv2-frontdoor \
    --resource-group fdv2-prod-rg \
    --origin-group-name fdv2-origin-group \
    --origin-name fdv2-app-origin \
    --host-name $APP_FQDN \
    --origin-host-header $APP_FQDN \
    --http-port 80 \
    --https-port 443 \
    --priority 1 \
    --weight 1000 \
    --enable-private-link true \
    --private-link-resource $ACA_ENV_ID \
    --private-link-location uksouth \
    --private-link-sub-resource-type managedEnvironments
  ```

- [ ] **Step 6: Approve the Private Link connection**

  After creating the origin, Azure creates a "private link request" on the Container Apps side. You need to approve it.

  ```bash
  # List pending connections
  az network private-endpoint-connection list \
    --id $ACA_ENV_ID \
    --output table
  ```

  Find the connection with `Pending` status and approve it:
  ```bash
  CONNECTION_ID=$(az network private-endpoint-connection list \
    --id $ACA_ENV_ID \
    --query "[?properties.privateLinkServiceConnectionState.status=='Pending'].id" \
    --output tsv)

  az network private-endpoint-connection approve \
    --id $CONNECTION_ID \
    --description "Approving Front Door private link"
  ```

- [ ] **Step 7: Get the WAF policy ID and create a security policy**

  ```bash
  WAF_ID=$(az network front-door waf-policy show \
    --name fdv2WafPolicy \
    --resource-group fdv2-prod-rg \
    --query id --output tsv)

  ENDPOINT_ID=$(az afd endpoint show \
    --profile-name fdv2-frontdoor \
    --resource-group fdv2-prod-rg \
    --endpoint-name fdv2-endpoint \
    --query id --output tsv)

  az afd security-policy create \
    --profile-name fdv2-frontdoor \
    --resource-group fdv2-prod-rg \
    --security-policy-name fdv2-security-policy \
    --domains $ENDPOINT_ID \
    --waf-policy $WAF_ID
  ```

- [ ] **Step 8: Create a route (connect the endpoint to the origin)**

  ```bash
  az afd route create \
    --profile-name fdv2-frontdoor \
    --resource-group fdv2-prod-rg \
    --endpoint-name fdv2-endpoint \
    --route-name fdv2-route \
    --origin-group fdv2-origin-group \
    --supported-protocols Https Http \
    --https-redirect Enabled \
    --forwarding-protocol HttpsOnly \
    --patterns-to-match "/*"
  ```

  **What `--https-redirect Enabled` means:** If someone visits `http://delayedpaid.co.uk` (without the S), Front Door automatically redirects them to `https://delayedpaid.co.uk`. Everyone gets HTTPS.

- [ ] **Step 9: Test the Front Door endpoint**

  Get the Front Door endpoint hostname:
  ```bash
  az afd endpoint show \
    --profile-name fdv2-frontdoor \
    --resource-group fdv2-prod-rg \
    --endpoint-name fdv2-endpoint \
    --query hostName --output tsv
  ```

  Open that URL in your browser (e.g. `https://fdv2-endpoint-xxxxxxxx.z01.azurefd.net`). You should see your app. If you see a 502/503, wait 5 minutes — Private Link connections can take a few minutes to activate.

---

## Task 9: Azure DNS + Custom Domain (delayedpaid.co.uk)

**What this is:** DNS is like the internet's phone book. When someone types `delayedpaid.co.uk` in their browser, DNS tells their computer "that name belongs to this IP address". We create an Azure DNS zone to manage all our DNS records, then tell Front Door about our custom domain so it can issue an SSL certificate for it.

**Files:**
- None

- [ ] **Step 1: Create an Azure DNS zone**

  ```bash
  az network dns zone create \
    --resource-group fdv2-prod-rg \
    --name delayedpaid.co.uk
  ```

  Expected: JSON with `"provisioningState": "Succeeded"`.

- [ ] **Step 2: Note the Azure name servers**

  ```bash
  az network dns zone show \
    --resource-group fdv2-prod-rg \
    --name delayedpaid.co.uk \
    --query nameServers \
    --output table
  ```

  You'll see 4 name servers like:
  ```
  ns1-xx.azure-dns.com
  ns2-xx.azure-dns.net
  ns3-xx.azure-dns.org
  ns4-xx.azure-dns.info
  ```

  **You must now update your domain registrar** (wherever you bought `delayedpaid.co.uk` — e.g. GoDaddy, Namecheap, 123-Reg) to use these 4 name servers instead of their default ones. This tells the internet "Azure is now in charge of this domain's DNS." Instructions vary by registrar — look for "Custom nameservers" or "Edit nameservers" in their control panel.

  **DNS changes take up to 48 hours to spread worldwide, though usually under an hour.** Continue with other tasks while this propagates.

- [ ] **Step 3: Add a wildcard CNAME record pointing to Front Door**

  Get your Front Door endpoint hostname:
  ```bash
  AFD_HOSTNAME=$(az afd endpoint show \
    --profile-name fdv2-frontdoor \
    --resource-group fdv2-prod-rg \
    --endpoint-name fdv2-endpoint \
    --query hostName --output tsv)
  ```

  Create a wildcard CNAME (this makes `ergo.delayedpaid.co.uk`, `staysure.delayedpaid.co.uk`, etc. all work automatically):
  ```bash
  az network dns record-set cname set-record \
    --resource-group fdv2-prod-rg \
    --zone-name delayedpaid.co.uk \
    --record-set-name "*" \
    --cname $AFD_HOSTNAME
  ```

  Also add the root domain:
  ```bash
  az network dns record-set cname set-record \
    --resource-group fdv2-prod-rg \
    --zone-name delayedpaid.co.uk \
    --record-set-name "@" \
    --cname $AFD_HOSTNAME
  ```

- [ ] **Step 4: Add the custom domain to Front Door**

  ```bash
  az afd custom-domain create \
    --profile-name fdv2-frontdoor \
    --resource-group fdv2-prod-rg \
    --custom-domain-name delayedpaid-root \
    --host-name delayedpaid.co.uk \
    --certificate-type ManagedCertificate \
    --minimum-tls-version TLS12
  ```

  Add the wildcard too:
  ```bash
  az afd custom-domain create \
    --profile-name fdv2-frontdoor \
    --resource-group fdv2-prod-rg \
    --custom-domain-name delayedpaid-wildcard \
    --host-name "*.delayedpaid.co.uk" \
    --certificate-type ManagedCertificate \
    --minimum-tls-version TLS12
  ```

  **What `--certificate-type ManagedCertificate` means:** Azure automatically gets a free SSL certificate from DigiCert and renews it every year. You never have to think about certificates again.

- [ ] **Step 5: Add TXT record for domain validation**

  Azure needs to prove you own the domain before it issues the certificate. It asks you to add a TXT record to DNS.

  ```bash
  az afd custom-domain show \
    --profile-name fdv2-frontdoor \
    --resource-group fdv2-prod-rg \
    --custom-domain-name delayedpaid-root \
    --query "validationProperties" \
    --output json
  ```

  Look for `validationToken` and `dnsTxtState`. Add the TXT record:
  ```bash
  az network dns record-set txt add-record \
    --resource-group fdv2-prod-rg \
    --zone-name delayedpaid.co.uk \
    --record-set-name "_dnsauth" \
    --value "PASTE_VALIDATION_TOKEN_HERE"
  ```

- [ ] **Step 6: Associate custom domains with the route**

  ```bash
  ROOT_DOMAIN_ID=$(az afd custom-domain show \
    --profile-name fdv2-frontdoor \
    --resource-group fdv2-prod-rg \
    --custom-domain-name delayedpaid-root \
    --query id --output tsv)

  WILDCARD_DOMAIN_ID=$(az afd custom-domain show \
    --profile-name fdv2-frontdoor \
    --resource-group fdv2-prod-rg \
    --custom-domain-name delayedpaid-wildcard \
    --query id --output tsv)

  az afd route update \
    --profile-name fdv2-frontdoor \
    --resource-group fdv2-prod-rg \
    --endpoint-name fdv2-endpoint \
    --route-name fdv2-route \
    --custom-domains $ROOT_DOMAIN_ID $WILDCARD_DOMAIN_ID
  ```

- [ ] **Step 7: Verify the domain is working**

  Wait for the certificate to provision (can take 5–15 minutes after DNS propagates):
  ```bash
  az afd custom-domain show \
    --profile-name fdv2-frontdoor \
    --resource-group fdv2-prod-rg \
    --custom-domain-name delayedpaid-root \
    --query "domainValidationState" \
    --output tsv
  ```
  Expected: `Approved`.

  Then open `https://delayedpaid.co.uk` in your browser. You should see your app with a green padlock (valid SSL certificate).

---

## Task 10: GitHub Actions CI/CD (Automated Deployments)

**What this is:** Right now, deploying a code change means manually running `az acr build` and then telling Container Apps to use the new image. We want this to happen automatically whenever you push code to GitHub. GitHub Actions is a built-in feature of GitHub that watches for pushes and runs a set of steps (build, test, deploy) automatically.

**OIDC (passwordless auth):** Instead of storing an Azure password in GitHub (dangerous — if GitHub is hacked, your Azure account is compromised too), we use "workload identity federation". GitHub proves to Azure "this request is coming from your specific GitHub repository" using a cryptographic token. No password ever stored anywhere.

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Create an App Registration in Azure (the "identity" for GitHub)**

  ```bash
  APP_ID=$(az ad app create \
    --display-name "fdv2-github-actions" \
    --query appId --output tsv)
  echo "App ID: $APP_ID"

  # Create a service principal for this app
  az ad sp create --id $APP_ID
  ```

  Save the `APP_ID` — you'll need it in Step 3 and 6.

- [ ] **Step 2: Add a federated credential (the OIDC link)**

  This step tells Azure "when GitHub Actions runs on the `main` branch of repository `YOUR_GITHUB_USERNAME/flight-delay-v2`, trust it as this identity."

  Replace `YOUR_GITHUB_USERNAME` with your actual GitHub username:

  ```bash
  az ad app federated-credential create \
    --id $APP_ID \
    --parameters '{
      "name": "github-main-branch",
      "issuer": "https://token.actions.githubusercontent.com",
      "subject": "repo:YOUR_GITHUB_USERNAME/flight-delay-v2:ref:refs/heads/main",
      "description": "GitHub Actions main branch",
      "audiences": ["api://AzureADAuth"]
    }'
  ```

- [ ] **Step 3: Grant permissions to the service principal**

  Get your subscription ID (saved from Task 0):
  ```bash
  SUB_ID=$(az account show --query id --output tsv)
  SP_ID=$(az ad sp show --id $APP_ID --query id --output tsv)

  # Push images to Container Registry
  ACR_ID=$(az acr show --name fdv2acr --resource-group fdv2-prod-rg --query id --output tsv)
  az role assignment create --assignee $SP_ID --role AcrPush --scope $ACR_ID

  # Deploy to Container Apps
  ACA_ID=$(az containerapp show --name fdv2-app --resource-group fdv2-prod-rg --query id --output tsv)
  az role assignment create --assignee $SP_ID --role "Azure ContainerApps Contributor" --scope $ACA_ID

  # Read from Container Apps Environment (needed for deployment)
  ACA_ENV_ID=$(az containerapp env show --name fdv2-aca-env --resource-group fdv2-prod-rg --query id --output tsv)
  az role assignment create --assignee $SP_ID --role "Reader" --scope $ACA_ENV_ID
  ```

- [ ] **Step 4: Get the values needed for GitHub Secrets**

  ```bash
  echo "AZURE_CLIENT_ID: $APP_ID"
  echo "AZURE_TENANT_ID: $(az account show --query tenantId --output tsv)"
  echo "AZURE_SUBSCRIPTION_ID: $(az account show --query id --output tsv)"
  ```

  Save all three values — you'll add them to GitHub in Step 6.

- [ ] **Step 5: Create the GitHub Actions workflow file**

  Create the file `.github/workflows/deploy.yml` in your repository:

  ```bash
  mkdir -p .github/workflows
  ```

  Create `.github/workflows/deploy.yml` with this content:

  ```yaml
  name: Build and Deploy

  on:
    push:
      branches: [main]
    workflow_dispatch:   # allows manual trigger from GitHub UI

  permissions:
    id-token: write    # Required for OIDC
    contents: read

  env:
    REGISTRY: fdv2acr.azurecr.io
    IMAGE_NAME: fdv2-app
    RESOURCE_GROUP: fdv2-prod-rg
    CONTAINER_APP: fdv2-app

  jobs:
    build-and-deploy:
      runs-on: ubuntu-latest
      environment: production   # requires manual approval in GitHub

      steps:
        - name: Checkout code
          uses: actions/checkout@v4

        - name: Set up Node.js
          uses: actions/setup-node@v4
          with:
            node-version: '20'
            cache: 'npm'
            cache-dependency-path: server/package-lock.json

        - name: Install dependencies
          run: npm ci
          working-directory: server

        - name: Run tests
          run: npm test
          working-directory: server

        - name: Log in to Azure (OIDC — no password)
          uses: azure/login@v2
          with:
            client-id: ${{ secrets.AZURE_CLIENT_ID }}
            tenant-id: ${{ secrets.AZURE_TENANT_ID }}
            subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

        - name: Log in to Container Registry
          run: az acr login --name fdv2acr

        - name: Build and push Docker image
          run: |
            IMAGE_TAG=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}
            LATEST_TAG=${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:latest
            docker build -t $IMAGE_TAG -t $LATEST_TAG .
            docker push $IMAGE_TAG
            docker push $LATEST_TAG
            echo "IMAGE_TAG=$IMAGE_TAG" >> $GITHUB_ENV

        - name: Deploy to Container Apps
          run: |
            az containerapp update \
              --name ${{ env.CONTAINER_APP }} \
              --resource-group ${{ env.RESOURCE_GROUP }} \
              --image ${{ env.IMAGE_TAG }}

        - name: Verify deployment
          run: |
            STATUS=$(az containerapp show \
              --name ${{ env.CONTAINER_APP }} \
              --resource-group ${{ env.RESOURCE_GROUP }} \
              --query "properties.runningStatus" --output tsv)
            echo "App status: $STATUS"
            if [ "$STATUS" != "Running" ]; then exit 1; fi
  ```

- [ ] **Step 6: Add secrets to GitHub**

  Go to your GitHub repository → Settings → Secrets and variables → Actions → New repository secret.

  Add three secrets (names must match exactly):
  - `AZURE_CLIENT_ID` — the App ID from Step 4
  - `AZURE_TENANT_ID` — the Tenant ID from Step 4
  - `AZURE_SUBSCRIPTION_ID` — the Subscription ID from Step 4

- [ ] **Step 7: Create the production environment with manual approval**

  In GitHub: go to your repository → Settings → Environments → New environment → name it `production`.

  Under "Environment protection rules", tick **Required reviewers** and add yourself. This means every deployment to production needs a human to click "approve" in GitHub before it proceeds. This prevents accidental deploys.

- [ ] **Step 8: Commit and push the workflow**

  ```bash
  git add .github/workflows/deploy.yml
  git commit -m "ci: add GitHub Actions build and deploy workflow"
  git push origin main
  ```

  Go to your GitHub repository → Actions tab. You should see the workflow running. It will pause at "Deploy to Container Apps" and ask for your approval (because of the environment protection rule you set).

---

## Task 11: Azure Communication Services (Email)

**What this is:** Right now, the app sends email via Nodemailer + SMTP. In production, we use Azure Communication Services instead of a third-party SMTP provider. The great part: Nodemailer still sends email exactly the same way — we just change the SMTP host/port/user/pass to point at ACS. Zero code changes.

**Files:**
- None (update Key Vault secrets only)

- [ ] **Step 1: Create the ACS resource**

  ```bash
  az communication create \
    --name fdv2-comms \
    --resource-group fdv2-prod-rg \
    --location global \
    --data-location "UK"
  ```

  **Why `--location global`?** ACS is a global service — the resource itself is globally managed, but data stays in `--data-location "UK"` for GDPR.

  Expected: `"provisioningState": "Succeeded"`.

- [ ] **Step 2: Create an Email Communication Service resource**

  ```bash
  az communication email create \
    --name fdv2-email \
    --resource-group fdv2-prod-rg \
    --location global \
    --data-location "UK"
  ```

- [ ] **Step 3: Add a custom email domain**

  ```bash
  az communication email domain create \
    --domain-name mail.delayedpaid.co.uk \
    --email-service-name fdv2-email \
    --resource-group fdv2-prod-rg \
    --location global \
    --domain-management CustomerManaged
  ```

  Get the DNS records you need to add:
  ```bash
  az communication email domain show \
    --domain-name mail.delayedpaid.co.uk \
    --email-service-name fdv2-email \
    --resource-group fdv2-prod-rg \
    --query "properties.verificationRecords" \
    --output json
  ```

  This returns DNS TXT records (for domain ownership) and DKIM records (for email deliverability — stops emails going to spam). Add all of them to your Azure DNS zone:

  ```bash
  # Example — exact values come from the command above
  az network dns record-set txt add-record \
    --resource-group fdv2-prod-rg \
    --zone-name delayedpaid.co.uk \
    --record-set-name "mail" \
    --value "VERIFICATION_VALUE_FROM_ABOVE"
  ```

- [ ] **Step 4: Link the email domain to the ACS resource**

  ```bash
  DOMAIN_ID=$(az communication email domain show \
    --domain-name mail.delayedpaid.co.uk \
    --email-service-name fdv2-email \
    --resource-group fdv2-prod-rg \
    --query id --output tsv)

  az communication link-notification-hub \
    --name fdv2-comms \
    --resource-group fdv2-prod-rg
  ```

- [ ] **Step 5: Get SMTP credentials**

  ```bash
  # Get the connection string
  az communication list-key \
    --name fdv2-comms \
    --resource-group fdv2-prod-rg \
    --query primaryConnectionString \
    --output tsv
  ```

  ACS SMTP settings:
  - **SMTP_HOST:** `smtp.azurecomm.net`
  - **SMTP_PORT:** `587`
  - **SMTP_USER:** `fdv2-comms.<region>.<your-subscription-id>` (shown in Portal under ACS → SMTP)
  - **SMTP_PASS:** The access key from the connection string above

  Update Key Vault with the real values:
  ```bash
  az keyvault secret set --vault-name fdv2-keyvault --name "SMTP-HOST" --value "smtp.azurecomm.net"
  az keyvault secret set --vault-name fdv2-keyvault --name "SMTP-PORT" --value "587"
  az keyvault secret set --vault-name fdv2-keyvault --name "SMTP-USER" --value "YOUR_ACS_SMTP_USERNAME"
  az keyvault secret set --vault-name fdv2-keyvault --name "SMTP-PASS" --value "YOUR_ACS_ACCESS_KEY"
  ```

  After updating Key Vault, restart the Container App to pick up the new secrets:
  ```bash
  az containerapp revision restart \
    --name fdv2-app \
    --resource-group fdv2-prod-rg \
    --revision $(az containerapp revision list \
      --name fdv2-app \
      --resource-group fdv2-prod-rg \
      --query "[0].name" --output tsv)
  ```

---

## Task 12: NAT Gateway (Static Outbound IP for Twilio/Modulr Whitelisting)

**What this is:** When your app calls Twilio, Modulr, or OAG, the request goes out to the internet. Without a NAT Gateway, Azure picks a random IP address for this outbound traffic — it changes unpredictably. Some services (like Twilio) let you whitelist specific IP addresses for security — "only accept calls from THIS IP." NAT Gateway gives all your outbound traffic one consistent, permanent IP address that you can give to Twilio, Modulr, and OAG to add to their whitelists.

**Files:**
- None

- [ ] **Step 1: Create a static public IP address for the NAT Gateway**

  ```bash
  az network public-ip create \
    --name fdv2-nat-pip \
    --resource-group fdv2-prod-rg \
    --location uksouth \
    --sku Standard \
    --allocation-method Static \
    --version IPv4
  ```

  Get your static IP (this is what you give to Twilio/Modulr/OAG):
  ```bash
  az network public-ip show \
    --name fdv2-nat-pip \
    --resource-group fdv2-prod-rg \
    --query ipAddress \
    --output tsv
  ```
  **Save this IP address.** This is your permanent outbound IP — add it to whitelists at Twilio, Modulr, and OAG.

- [ ] **Step 2: Create the NAT Gateway**

  ```bash
  az network nat gateway create \
    --name fdv2-nat \
    --resource-group fdv2-prod-rg \
    --location uksouth \
    --public-ip-addresses fdv2-nat-pip \
    --idle-timeout 10
  ```

- [ ] **Step 3: Associate the NAT Gateway with the Container Apps subnet**

  This tells Azure "all outbound traffic from the Container Apps subnet should go through the NAT Gateway, using our static IP."

  ```bash
  az network vnet subnet update \
    --name fdv2-aca-subnet \
    --resource-group fdv2-prod-rg \
    --vnet-name fdv2-vnet \
    --nat-gateway fdv2-nat
  ```

- [ ] **Step 4: Verify outbound IP**

  You can verify by making the app call an external "what's my IP" endpoint. After the Container App is restarted, any outbound calls will use the NAT IP.

  The easiest check: go to [portal.azure.com](https://portal.azure.com) → search "Public IP addresses" → click `fdv2-nat-pip` → the "IP address" shown is what external services will see.

---

## Task 13: Event Hub Private Endpoint

**What this is:** You already have an Azure Event Hub that receives OAG flight events. Right now, the app running in the VNet connects to Event Hub over the public internet (even though both are in Azure, it goes out and comes back). This task moves that connection inside the VNet — faster and more secure.

**Files:**
- None (connection string already in Key Vault)

- [ ] **Step 1: Get your existing Event Hub namespace resource ID**

  Replace `YOUR_EVENTHUB_NAMESPACE` with the name of your existing Event Hub namespace:

  ```bash
  EH_ID=$(az eventhubs namespace show \
    --name YOUR_EVENTHUB_NAMESPACE \
    --resource-group YOUR_EXISTING_RESOURCE_GROUP \
    --query id --output tsv)
  echo $EH_ID
  ```

- [ ] **Step 2: Create a private endpoint for Event Hub**

  ```bash
  az network private-endpoint create \
    --name fdv2-eh-pe \
    --resource-group fdv2-prod-rg \
    --vnet-name fdv2-vnet \
    --subnet fdv2-pe-subnet \
    --private-connection-resource-id $EH_ID \
    --group-id namespace \
    --connection-name fdv2-eh-connection
  ```

- [ ] **Step 3: Create private DNS zone for Event Hub**

  ```bash
  az network private-dns zone create \
    --resource-group fdv2-prod-rg \
    --name "privatelink.servicebus.windows.net"

  az network private-dns link vnet create \
    --resource-group fdv2-prod-rg \
    --zone-name "privatelink.servicebus.windows.net" \
    --name fdv2-eh-dns-link \
    --virtual-network fdv2-vnet \
    --registration-enabled false

  PE_NIC_ID=$(az network private-endpoint show \
    --name fdv2-eh-pe \
    --resource-group fdv2-prod-rg \
    --query "networkInterfaces[0].id" --output tsv)

  PE_IP=$(az network nic show --ids $PE_NIC_ID \
    --query "ipConfigurations[0].privateIPAddress" --output tsv)

  az network private-dns record-set a add-record \
    --resource-group fdv2-prod-rg \
    --zone-name "privatelink.servicebus.windows.net" \
    --record-set-name YOUR_EVENTHUB_NAMESPACE \
    --ipv4-address $PE_IP
  ```

- [ ] **Step 4: Block public access to Event Hub**

  Once the private endpoint is working, disable public internet access to Event Hub. This means only your VNet can connect to it.

  ```bash
  az eventhubs namespace network-rule update \
    --namespace-name YOUR_EVENTHUB_NAMESPACE \
    --resource-group YOUR_EXISTING_RESOURCE_GROUP \
    --default-action Deny
  ```

  **Test first!** Verify the app is working with the private endpoint before running this command — once you deny public access, you can't connect from your laptop anymore (only from inside the VNet).

---

## Task 14: Azure Monitor + Alerts

**What this is:** Monitoring means "we know when something goes wrong before a customer tells us." We set up alerts that send you an email if: your app crashes, response times get slow, error rates spike, or the app keeps restarting. Think of it as a smoke detector for your cloud infrastructure.

**Files:**
- None (Log Analytics workspace already created in Task 6)

- [ ] **Step 1: Enable Application Insights**

  Application Insights is the "flight recorder" for your app — it records every HTTP request, traces errors, and shows you performance graphs.

  ```bash
  az monitor app-insights component create \
    --app fdv2-appinsights \
    --resource-group fdv2-prod-rg \
    --location uksouth \
    --workspace $(az monitor log-analytics workspace show \
      --resource-group fdv2-prod-rg \
      --workspace-name fdv2-logs \
      --query id --output tsv)
  ```

  Get the connection string and add it to the app:
  ```bash
  az monitor app-insights component show \
    --app fdv2-appinsights \
    --resource-group fdv2-prod-rg \
    --query connectionString --output tsv
  ```

  Add to Key Vault:
  ```bash
  az keyvault secret set --vault-name fdv2-keyvault \
    --name "APPLICATIONINSIGHTS-CONNECTION-STRING" \
    --value "YOUR_CONNECTION_STRING"
  ```

  Then add the env var to the Container App:
  ```bash
  az containerapp update \
    --name fdv2-app \
    --resource-group fdv2-prod-rg \
    --set-env-vars "APPLICATIONINSIGHTS_CONNECTION_STRING=secretref:appinsights-connection-string" \
    --secrets "appinsights-connection-string=keyvaultref:https://fdv2-keyvault.vault.azure.net/secrets/APPLICATIONINSIGHTS-CONNECTION-STRING,identityref:$IDENTITY_ID"
  ```

- [ ] **Step 2: Create an Action Group (who to notify)**

  An Action Group is a list of "when something bad happens, contact these people."

  Replace `your@email.com` with your real email:

  ```bash
  az monitor action-group create \
    --name fdv2-alerts \
    --resource-group fdv2-prod-rg \
    --short-name fdv2 \
    --action email admin your@email.com
  ```

- [ ] **Step 3: Create an alert for high error rate**

  This fires if more than 10 HTTP 5xx errors occur in any 5-minute window.

  ```bash
  ACTION_GROUP_ID=$(az monitor action-group show \
    --name fdv2-alerts \
    --resource-group fdv2-prod-rg \
    --query id --output tsv)

  ACA_ID=$(az containerapp show \
    --name fdv2-app \
    --resource-group fdv2-prod-rg \
    --query id --output tsv)

  az monitor metrics alert create \
    --name "fdv2-high-error-rate" \
    --resource-group fdv2-prod-rg \
    --scopes $ACA_ID \
    --condition "count Requests5xx > 10" \
    --window-size 5m \
    --evaluation-frequency 1m \
    --action $ACTION_GROUP_ID \
    --description "More than 10 server errors in 5 minutes"
  ```

- [ ] **Step 4: Create an alert for container restarts**

  This fires if the app container crashes and restarts — a sign of a serious bug.

  ```bash
  az monitor metrics alert create \
    --name "fdv2-container-restarts" \
    --resource-group fdv2-prod-rg \
    --scopes $ACA_ID \
    --condition "total RestartCount > 3" \
    --window-size 15m \
    --evaluation-frequency 5m \
    --action $ACTION_GROUP_ID \
    --description "App container restarted more than 3 times in 15 minutes"
  ```

- [ ] **Step 5: Verify logs are flowing**

  Go to [portal.azure.com](https://portal.azure.com) → search "Log Analytics workspaces" → click `fdv2-logs` → click "Logs" in the left menu → paste this query and click Run:

  ```kusto
  ContainerAppConsoleLogs_CL
  | where TimeGenerated > ago(30m)
  | order by TimeGenerated desc
  | take 50
  ```

  You should see your app's console output. If you see logs, monitoring is working.

---

## ✅ Post-Deployment Checklist

Run through these manually after all tasks are complete:

- [ ] `https://delayedpaid.co.uk` loads the landing page with a green padlock
- [ ] `https://demo.delayedpaid.co.uk` shows the customer registration form (wildcard DNS working)
- [ ] `https://demo.delayedpaid.co.uk/admin` shows the admin login
- [ ] Log in to admin with seeded superadmin credentials — dashboard loads
- [ ] Push a trivial code change to `main` on GitHub → Actions workflow starts → manually approve → Container App updates
- [ ] Azure Portal → `fdv2-prod-rg` → you can see all resources created in this plan
- [ ] Azure Portal → Key Vault `fdv2-keyvault` → Secrets — all 7 secrets present with non-placeholder values
- [ ] Azure Portal → Log Analytics `fdv2-logs` → Logs → run the query from Task 14 Step 5 — app logs visible
- [ ] Send a test email via the admin simulator — check it arrives

---

## 🆘 Troubleshooting Quick Reference

| Symptom | Likely cause | Fix |
|---|---|---|
| 502 Bad Gateway on Front Door | Private Link not approved or Container App not running | Check Task 8 Step 6; check `az containerapp show` running status |
| App shows "Cannot connect to database" | PostgreSQL VNet not linked or wrong DATABASE_URL | Check Task 3; verify Key Vault secret value |
| Emails not sending | ACS SMTP not configured | Check Task 11 Step 5; restart Container App after Key Vault update |
| GitHub Actions fails at "Log in to Azure" | OIDC credentials wrong or federated credential subject mismatch | Re-check Task 10 Step 2 — repo name and branch must match exactly |
| Container restarts in a loop | App crashing on startup — bad env var or missing secret | Run `az containerapp logs show --name fdv2-app --resource-group fdv2-prod-rg --follow` to see the crash message |
| DNS not resolving | Nameservers not updated at registrar, or propagation still in progress | Check registrar NS records; use `nslookup delayedpaid.co.uk 8.8.8.8` to test |
