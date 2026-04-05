'use strict';

/**
 * Azure Blob Storage service for claim documents.
 * Uses managed identity — no connection string or API key required.
 *
 * Falls back to local disk when BLOB_STORAGE_ACCOUNT is not set (local dev).
 */

const fs     = require('fs');
const path   = require('path');
const config = require('../config');

function isAvailable() {
  return Boolean(config.blobStorage.account);
}

function getBlobServiceClient() {
  const { BlobServiceClient }       = require('@azure/storage-blob');
  const { ManagedIdentityCredential } = require('@azure/identity');
  const credential = new ManagedIdentityCredential({ clientId: config.azureOpenAI.clientId });
  const url        = `https://${config.blobStorage.account}.blob.core.windows.net`;
  return new BlobServiceClient(url, credential);
}

/**
 * Upload a file to blob storage.
 * blobName: the path within the container, e.g. "123/uuid.pdf"
 * Returns the blob URL (without SAS — access is via managed identity only).
 */
async function uploadFile(localPath, blobName, mimeType) {
  if (!isAvailable()) {
    // Local dev — file is already on disk, return a placeholder URL
    return null;
  }

  const client        = getBlobServiceClient();
  const containerClient = client.getContainerClient(config.blobStorage.container);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  const buffer = fs.readFileSync(localPath);
  await blockBlobClient.uploadData(buffer, {
    blobHTTPHeaders: { blobContentType: mimeType },
  });

  // Delete local temp file after successful upload
  fs.unlink(localPath, () => {});

  return blockBlobClient.url;
}

/**
 * Download a blob to a temp file and return the local path.
 * Used by documentParser when reading from blob storage.
 */
async function downloadToTemp(blobName, destPath) {
  const client          = getBlobServiceClient();
  const containerClient = client.getContainerClient(config.blobStorage.container);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  await blockBlobClient.downloadToFile(destPath);
  return destPath;
}

/**
 * Read a blob directly into a Buffer (used by AI verifier for images).
 */
async function downloadToBuffer(blobName) {
  const client          = getBlobServiceClient();
  const containerClient = client.getContainerClient(config.blobStorage.container);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  const response = await blockBlobClient.downloadToBuffer();
  return response;
}

/**
 * Delete a blob. Safe to call even if blob doesn't exist.
 */
async function deleteBlob(blobName) {
  if (!isAvailable()) return;

  try {
    const client          = getBlobServiceClient();
    const containerClient = client.getContainerClient(config.blobStorage.container);
    await containerClient.getBlockBlobClient(blobName).deleteIfExists();
  } catch (err) {
    console.warn('[blobStorage] Delete error:', err.message);
  }
}

/**
 * Derive the blob name from a registration ID and stored filename.
 * Format: {registrationId}/{storedName}
 */
function blobName(registrationId, storedName) {
  return `${registrationId}/${storedName}`;
}

module.exports = { isAvailable, uploadFile, downloadToTemp, downloadToBuffer, deleteBlob, blobName };
