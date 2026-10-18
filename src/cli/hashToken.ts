#!/usr/bin/env node
/**
 * Generates a random bearer token for an HTTP-mode user and prints the
 * MCP_HTTP_TOKEN_HASHES entry. Only the hash goes into server configuration;
 * the token itself is given to that user's MCP client.
 *
 *   npm run hash-token -- alice
 */
import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../http/httpServer.js';

const userId = process.argv[2];
if (!userId || !/^[A-Za-z0-9._@-]{1,128}$/.test(userId)) {
  console.error('Usage: npm run hash-token -- <userId>   (letters, digits, . _ @ -)');
  process.exit(1);
}
const token = `gwmcp_${randomBytes(32).toString('base64url')}`;
console.log(`Bearer token for "${userId}" (give to the user's MCP client; shown once):\n\n  ${token}\n`);
console.log(`Add to MCP_HTTP_TOKEN_HASHES (comma-separated):\n\n  ${userId}:${sha256Hex(token)}\n`);
