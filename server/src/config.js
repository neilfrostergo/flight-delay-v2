'use strict';

require('dotenv').config();

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optionalEnv(name, defaultValue) {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : defaultValue;
}

function validateEncryptionKey(key) {
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      'ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes). ' +
      'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return key;
}

const encryptionKey = validateEncryptionKey(requireEnv('ENCRYPTION_KEY'));

const config = {
  nodeEnv: optionalEnv('NODE_ENV', 'development'),
  port: parseInt(optionalEnv('PORT', '3000'), 10),
  isProduction: optionalEnv('NODE_ENV', 'development') === 'production',
  // isLocalDev: true only in local development — use http + port in URLs.
  // UAT and production both use https + no port.
  isLocalDev: optionalEnv('NODE_ENV', 'development') === 'development',

  db: {
    url: requireEnv('DATABASE_URL'),
  },

  jwt: {
    secret: requireEnv('JWT_SECRET'),
    expiresIn: '8h',
  },

  encryption: {
    key: Buffer.from(encryptionKey, 'hex'),
  },

  cors: {
    adminOrigin: optionalEnv('ADMIN_CORS_ORIGIN', 'http://localhost:3000'),
  },

  // Multi-tenancy
  // BASE_DOMAIN is used to extract the subdomain slug from the Host header.
  // e.g. Host: ergo.platform.co.uk with BASE_DOMAIN=platform.co.uk → slug=ergo
  // In development, HOST resolution falls back to X-Tenant-Slug header.
  baseDomain: optionalEnv('BASE_DOMAIN', 'localhost'),
  devTenantSlug: optionalEnv('DEV_TENANT_SLUG', 'demo'),

  // Dev email override — if set, ALL outbound emails go here instead of the real recipient
  devEmailOverride: optionalEnv('DEV_EMAIL_OVERRIDE', ''),

  smtp: {
    host: optionalEnv('SMTP_HOST', 'sandbox.smtp.mailtrap.io'),
    port: parseInt(optionalEnv('SMTP_PORT', '2525'), 10),
    user: optionalEnv('SMTP_USER', ''),
    pass: optionalEnv('SMTP_PASS', ''),
  },

  // Azure Communication Services — when set, emails are sent via ACS instead of SMTP.
  // Leave blank in local development to keep using SMTP/Mailtrap.
  acs: {
    connectionString: optionalEnv('ACS_CONNECTION_STRING', ''),
  },

  // Azure Blob Storage — document uploads (UAT + production)
  // Uses managed identity — no connection string needed.
  // Leave blank in local development to fall back to local disk storage.
  blobStorage: {
    account:   optionalEnv('BLOB_STORAGE_ACCOUNT', ''),
    container: optionalEnv('BLOB_STORAGE_CONTAINER', 'claim-documents'),
  },

  // Azure OpenAI — document verification via managed identity (UAT + production)
  // Leave blank in local development to skip AI verification.
  azureOpenAI: {
    endpoint:    optionalEnv('AZURE_OPENAI_ENDPOINT', ''),
    deployment:  optionalEnv('AZURE_OPENAI_DEPLOYMENT', 'gpt-4o-mini-prd'),
    clientId:    optionalEnv('AZURE_CLIENT_ID', ''),
  },

  // Azure Event Hub — production only (ignored in development)
  eventHub: {
    connectionString:        optionalEnv('EVENT_HUB_CONNECTION_STRING', ''),
    name:                    optionalEnv('EVENT_HUB_NAME', 'oag-flight-alerts'),
    storageConnectionString: optionalEnv('EVENT_HUB_STORAGE_CONNECTION_STRING', ''),
    storageContainerName:    optionalEnv('EVENT_HUB_STORAGE_CONTAINER', 'event-hub-checkpoints'),
  },
};

module.exports = config;
