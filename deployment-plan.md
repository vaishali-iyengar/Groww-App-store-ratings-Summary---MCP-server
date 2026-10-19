# Deployment plan: google-workspace-mcp on Vercel

Goal: a public `https://<project>.vercel.app/mcp` endpoint (Streamable HTTP + bearer tokens) that Claude, Cursor, ChatGPT, VS Code or any MCP client can connect to. It runs as a Vercel Node.js Function, with state kept in Upstash Redis.

```text
MCP client ──HTTPS──► Vercel Function  api/index.js → dist/vercel.js
 (Bearer token)         │  createRequestHandler(deps)  ← src/http/httpServer.ts
                        │    /mcp  /oauth2/callback  /healthz  /metrics
                        ├──► Gmail API / Google Docs API
                        └──► Upstash Redis (KvStore)
                               tokens · idempotency · confirmations · OAuth state · audit
```

---

## 0. Why code changes were needed

Vercel runs the server as short-lived function instances. Memory and the filesystem (only `/tmp` is writable) are **not shared between instances and not kept**. Before these changes, HTTP mode kept the following in process memory or `DATA_DIR`:

| State | Before | Failure on Vercel if left as-is | Now (with Redis) |
|---|---|---|---|
| Google OAuth tokens | `DATA_DIR/tokens.enc.json` | Users randomly appear "not authorized" | `KvTokenStore`, still AES-256-GCM encrypted |
| Idempotency / auto-dedupe records | `DATA_DIR/idempotency.json` | Duplicate-send protection silently stops working | `KvIdempotencyStore` (atomic `SET NX` claim) |
| Confirmation tokens | `Map` in `ConfirmationService` | Confirming call lands on another instance → `confirmation_token is invalid` | `KvPendingStore` (single use via `GETDEL`) |
| OAuth `state` / PKCE verifier | `Map` in `OAuthFlow` | Google redirect lands on another instance → "authorization link is invalid" | `KvPendingStore` |
| Audit log | `DATA_DIR/audit.log` | Lost | `KvAuditSink` (capped list `gwmcp:audit`) |
| Documents created by the server | `DATA_DIR/created-docs.json` | `restrictToCreatedDocuments` blocks appends to a Doc the server just created | `KvCreatedDocsRegistry` (`gwmcp:created-doc:<user-hash>:<doc-id>`) |
| Rate-limit windows | `Map` in `RateLimiter` | Per-instance only | Unchanged (tolerable; see §7) |

`/mcp` already used the SDK's fetch-style `createMcpHandler`, which builds a fresh server per request. That part was always stateless.

---

## 1. Prerequisites

- A Vercel account (Hobby is fine for personal use; it's non-commercial only) and the CLI: `npm i -g vercel && vercel login`.
- Google Cloud setup from the README, with a **Web application** OAuth client (a Desktop client can't use an https redirect URI).
- Node 20+ locally.

---

## 2. Code changes (done)

stdio and Docker keep their file and in-memory stores. HTTP mode switches to Redis automatically when Upstash credentials are in the environment.

| File | Change |
|---|---|
| [src/storage/kv.ts](src/storage/kv.ts) | New. `KvStore` interface (get / set with TTL, NX, KEEPTTL / getDel / del / capped list push), `MemoryKvStore` (default and test fake), `UpstashKvStore` (`@upstash/redis`, REST), `createKvFromEnv()`. That function reads `KV_REST_API_URL`/`KV_REST_API_TOKEN` (Vercel Marketplace names) or `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`. All keys start with `gwmcp:`. |
| [src/storage/pendingStore.ts](src/storage/pendingStore.ts) | New. `PendingStore<T>` with `put(key, value, ttlMs)` and an atomic, single-use `take(key)`. |
| [src/policy/confirmation.ts](src/policy/confirmation.ts) | `ConfirmationService` takes an optional `PendingStore` (third constructor argument). The in-memory `Map` and `prune()` are gone. The expiry, user, operation and argument-hash checks are unchanged. |
| [src/auth/oauth.ts](src/auth/oauth.ts) | Same change for `OAuthFlow` (fifth constructor argument). |
| [src/auth/tokenStore.ts](src/auth/tokenStore.ts) | Encryption moved into shared `encryptEntry` / `decryptEntry` helpers, still bound to the user ID. New `KvTokenStore`: one scrypt salt per database, created with `SET NX`. |
| [src/utils/idempotency.ts](src/utils/idempotency.ts) | New `KvIdempotencyStore`. `begin()` claims the key with `SET NX PX`. `failed` records are deleted so they can be claimed again. An `in_flight` claim older than 5 minutes (`IN_FLIGHT_LEASE_MS`, from a crashed or timed-out instance) is reported as `outcome_unknown`, mirroring the file store's crash handling. Gmail sends are still never retried. |
| [src/audit/audit.ts](src/audit/audit.ts) | New `KvAuditSink`: newest 10,000 records in `gwmcp:audit`. A failed write is logged but never fails the operation. |
| [src/container.ts](src/container.ts) | `createDeps(config, mode, logger, kv?)` defaults `kv` to `createKvFromEnv()` in HTTP mode and wires every store above. `createTokenStore(config, kv?)` uses `KvTokenStore` when a store is given. |
| [src/http/httpServer.ts](src/http/httpServer.ts) | New `createRequestHandler(deps)`, the `(req, res)` router. `createHttpServer` wraps it, so `src/index.ts` and Docker are unchanged. |
| [src/vercel.ts](src/vercel.ts) | New. `createVercelHandler(env?, kv?)`. Defaults: `MCP_HTTP_HOST=0.0.0.0` (turns off the localhost-only Host check that would reject the vercel.app domain), `DATA_DIR=/tmp/...`, `POLICY_FILE` = the bundled `policy.json`, and `MCP_PUBLIC_BASE_URL=https://$VERCEL_PROJECT_PRODUCTION_URL`. Explicit variables override all of these. **Fails at cold start** if Redis, `MCP_HTTP_TOKEN_HASHES` or (with Google configured) `OAUTH_STATE_SECRET` is missing. |
| [src/cli/auth.ts](src/cli/auth.ts) | With Upstash variables set, `npm run auth -- --user <id>` writes tokens straight into the shared store. |
| [api/index.js](api/index.js) | The function: `export default createVercelHandler()` from `dist/`. It reads no `.env` file. |
| [vercel.json](vercel.json) | `npm run build`, rewrite of every path to `/api`, `maxDuration: 60`, `includeFiles: policy.json`, `outputDirectory: public`. |
| [public/robots.txt](public/robots.txt) | Static output directory Vercel requires when a build command is set; tells crawlers to stay away. |
| [policy.json](policy.json) | Deployment policy: confirmation required for send and append, `token_only`, max 5 recipients. **Fill in `allowedRecipientDomains` and `allowedDocumentIds` before deploying.** Empty lists mean no restriction. |
| [.vercelignore](.vercelignore) | Keeps `.env*`, `.data/`, token files, `node_modules/`, `dist/` and `tests/` out of uploads. |
| `package.json` | Added the `@upstash/redis` dependency. |

**Tests** (182 passing, 27 new; `npm run check` is green):
- [tests/unit/kv.test.ts](tests/unit/kv.test.ts): `MemoryKvStore` semantics, the Upstash command mapping, `KvPendingStore` (single-use across instances, expiry, namespaces), `KvTokenStore` (shared between instances, ciphertext only, user binding, wrong key), and `KvAuditSink`.
- [tests/unit/idempotency.test.ts](tests/unit/idempotency.test.ts): every `runIdempotent` scenario now also runs against `KvIdempotencyStore`. Added tests cover sharing between instances and the expired-lease case.
- [tests/contract/sharedState.test.ts](tests/contract/sharedState.test.ts): two MCP server instances over one store.
  - A confirmation token issued by A works on B, exactly once.
  - An identical send on B is suppressed, and an idempotency key replays on B.
  - OAuth state started on A completes on B once, and fails with a different `OAUTH_STATE_SECRET`.
  - The Vercel handler refuses to start when misconfigured, accepts the deployment domain in the Host header, and issues authorization links for the production domain with their state stored in Redis.

Also smoke-tested: `api/index.js` loaded with Vercel-style variables answered `/healthz` (200), `/mcp` without a token (401) and an MCP `initialize` (200). Without Redis variables it refused to start and named them.

**Not yet tested:**
- A real Vercel build and a real Upstash database (step 6 covers both).
- Elicitation-based confirmation on serverless. That's why `policy.json` starts with `token_only` (§3).

---

## 3. Confirmation mode

`policy.json` ships with `"mode": "token_only"`. That flow depends only on the shared confirmation store and works with every client. Elicitation through the 2025-era `elicitation/create` shim sends a server-to-client request mid-call, which hasn't been verified on serverless. After deploying, you can switch to `"auto"` and test with your actual MCP host. Keep `auto` if the host's confirm prompt appears and the action completes.

---

## 4. Create the project and Redis

```bash
cd /Users/radha/Documents/MCP
vercel link                      # creates/links the project; keep "Other" as the framework
```

1. Vercel dashboard → project → **Storage** → **Upstash Redis** (Marketplace) → create (free tier) → **Connect to project** for Production (and Preview if you use it). This injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
2. Note the production domain, e.g. `https://google-workspace-mcp.vercel.app`. It's derived automatically from `VERCEL_PROJECT_PRODUCTION_URL`. With a custom domain, set `MCP_PUBLIC_BASE_URL` to it.

---

## 5. Environment variables (Project → Settings → Environment Variables, Production)

Generate secrets locally:

```bash
openssl rand -base64 32                                  # TOKEN_STORE_ENCRYPTION_KEY
openssl rand -base64 32                                  # OAUTH_STATE_SECRET
npm run build && npm run hash-token -- <your-user-id>    # prints the bearer token + "<user>:<hash>"
```

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Web application client |
| `TOKEN_STORE_ENCRYPTION_KEY` | 32+ random chars. Changing it later means every user re-authorizes. |
| `OAUTH_STATE_SECRET` | 32+ random chars. **Required**: the function won't start without it. |
| `MCP_HTTP_TOKEN_HASHES` | `<user>:<sha256>` entries, comma-separated. **Hashes only**; keep the raw tokens in a password manager. |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Injected by the Upstash integration (step 4) |
| `LOG_LEVEL`, `LOG_RECIPIENTS`, `TIMESTAMP_TIMEZONE`, `TOOL_NAME_STYLE` | Optional: `info`, `hash`, `UTC`, `underscore` |
| `WEEKLY_NOTE_RECIPIENT` | Optional: default recipient suggested by the `weekly_note` prompt, e.g. `vaishu1996@gmail.com`. Who may actually receive mail is decided by `policy.json` (`allowedRecipients`). |
| `SUMMARY_DOC_ID` | Optional: an existing Doc the `weekly_note` prompt appends to. Leave unset when the agent creates Docs with `google_docs_create`. |

Defaults from `src/vercel.ts` cover these, so **don't add them**: `MCP_HTTP_HOST`, `MCP_PUBLIC_BASE_URL` (unless you use a custom domain), `DATA_DIR`, `POLICY_FILE`. In particular, don't copy `MCP_HTTP_HOST=127.0.0.1` or local paths from your `.env`.

Mark secrets as **Sensitive**. For local testing against the same Redis, run `vercel env pull .env.local`, then `vercel dev`. Or run `ENV_FILE=.env.local npm run start:http`, which also uses Redis because the Upstash variables are present.

---

## 6. Google OAuth client, deploy and verify

Google Cloud Console → Credentials → your **Web application** client → Authorized redirect URIs:

```text
https://<project>.vercel.app/oauth2/callback
```

Keep `http://127.0.0.1:53682/oauth2callback` if you still run `npm run auth` locally. While the consent screen is in *Testing*, add each user's Google account under **Test users**.

Deploy:

```bash
vercel deploy --prod
```

Or push to a private GitHub repo and import it in Vercel. Before the first commit, run `git status --ignored` to confirm `.env`, `.data/`, `dist/` and `node_modules/` are ignored. **Use the production domain**: preview URLs sit behind Vercel Deployment Protection, so MCP clients would get a login page.

| Check | Expected |
|---|---|
| Function logs on first request | No `Invalid configuration` error |
| `curl https://<host>/healthz` | `{"status":"ok"}`, which also proves the rewrite keeps the path |
| `curl -X POST https://<host>/mcp` | `401` with `WWW-Authenticate: Bearer` |
| `npx @modelcontextprotocol/inspector` → Streamable HTTP → `https://<host>/mcp`, header `Authorization: Bearer <token>` | 5 tools (`gmail_send_email`, `google_docs_create`, `google_docs_append`, `google_docs_get_metadata`, `connection_get_status`) and 1 prompt (`weekly_note`) listed |
| `connection_get_status` | `authorization_required: true` + an `authorization_url` whose `redirect_uri` is `https://<host>/oauth2/callback` |
| Open that URL, consent | "Google account connected"; `connection_get_status` now shows your email |
| `google_docs_create` with a title and content | `success: true` with a `document_id` (no confirmation: `googleDocs.requireConfirmation` is `false`) |
| `google_docs_append` to that `document_id` | `success: true`; the text is at the end of the Doc |
| `google_docs_append` to a Doc the server didn't create | `POLICY_BLOCKED` (`restrictToCreatedDocuments`) |
| `gmail_send_email` to `vaishu1996@gmail.com` | `CONFIRMATION_REQUIRED` → repeat with `confirmation_token` → `success: true` |
| Same `confirmation_token` again | `confirmation_token is invalid, expired, or already used` |
| `gmail_send_email` to an allowed address, then the identical call again | sent once; second call → `DUPLICATE_REQUEST` |
| Send to any address other than `vaishu1996@gmail.com`, or a body over 5,000 bytes | `POLICY_BLOCKED` |
| Redeploy, then `connection_get_status` | still authorized (token is in Redis) |

Client configuration (see [examples/mcp-config.http.json](examples/mcp-config.http.json)):

```json
{
  "mcpServers": {
    "google-workspace": {
      "type": "http",
      "url": "https://<project>.vercel.app/mcp",
      "headers": { "Authorization": "Bearer <token from npm run hash-token>" }
    }
  }
}
```

---

## 7. Operations and limitations

- **Logs**: JSON lines from stderr appear under the project's **Logs** tab. Recipients are hashed and bodies redacted.
- **Audit**: `LRANGE gwmcp:audit 0 100` in the Upstash console. The list is capped at 10,000 entries; export it periodically if you need more.
- **Rate limiting** is still per instance, so the effective limit is higher than `MCP_HTTP_RATE_LIMIT_PER_MINUTE` under load. To fix it, make `RateLimiter.allow()` async over `INCR gwmcp:rl:<user>:<minute>` + `EXPIRE 60`.
- **Metrics**: `/metrics` is per instance. Counters reset and are split across instances, so treat them as rough.
- **Users**: edit `MCP_HTTP_TOKEN_HASHES` and redeploy. To disconnect a user, delete `gwmcp:token:<user>` in Upstash and revoke the app at myaccount.google.com.
- **Auth model**: static per-user bearer tokens, not MCP OAuth 2.1 (see [docs/decisions.md](docs/decisions.md#6-remote-authentication)). Hosted connectors that require OAuth discovery won't connect until that's added.
- **Google Testing mode**: refresh tokens expire after **7 days**. Publish the consent screen (Google verification is required for `gmail.send` with external users), or re-authorize weekly.
- **Upstash free tier** has command and storage limits. Each tool call costs a handful of commands, which is ample for personal use.
- **Docker / `npm run start:http`** now also use Redis whenever the Upstash variables are set. Without them, they behave exactly as before.
