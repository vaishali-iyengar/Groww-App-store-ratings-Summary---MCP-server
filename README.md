# google-workspace-mcp

An agent-agnostic **Model Context Protocol (MCP) server** that gives AI agents controlled access to one Google account. It can:

- **send email through Gmail**
- **append text to existing Google Docs**

Any MCP-compatible host can use it: Claude, ChatGPT, Gemini, Cursor, VS Code or a custom agent. The server contains no LLM and no AI-provider SDK, and nothing in it is specific to one host.

> The agent decides *what* to do. This server provides a standard, secure interface for *doing* it against Google APIs.

The full requirements are in [problem-statement(MCP).md](problem-statement(MCP).md). Interpretation choices are recorded in [docs/decisions.md](docs/decisions.md).

## Tools

| Tool (default wire name) | Spec name | Effect |
|---|---|---|
| `gmail_send_email` | `gmail.send_email` | Sends a plain-text or HTML email with To/Cc/Bcc and optional threading. **External side effect.** |
| `google_docs_append` | `google_docs.append` | Appends text to the end of a document or a specific tab, with optional separator, heading and timestamp. Never overwrites. **External write.** |
| `google_docs_create` | `google_docs.create` | Creates a new Google Doc, optionally with initial plain-text content, and returns its ID and link. Off unless policy enables it. **External write.** |
| `google_docs_get_metadata` | `google_docs.get_metadata` | Read-only. Returns title, revision and tabs (no content) so the agent can confirm the target. |
| `connection_get_status` | `connection.get_status` | Read-only. Reports whether Google is authorized, for which account and with which capabilities. Never returns credentials. |

Wire names use underscores by default because some hosts reject dots in tool names. Set `TOOL_NAME_STYLE=dotted` to use the spec's exact names.

Every result is structured (`structuredContent` plus a JSON text fallback):

```json
{ "success": true, "operation": "gmail.send_email", "message_id": "18c1…", "thread_id": "18c1…",
  "label_ids": ["SENT"], "recipients": ["person@example.com"], "bcc_count": 0,
  "content_type": "text/plain", "request_id": "req_…" }
```

```json
{ "success": false, "operation": "google_docs.append", "request_id": "req_…",
  "error": { "code": "DOCUMENT_ACCESS_DENIED", "retryable": false,
             "message": "The authenticated Google account does not have permission to access or edit this document." } }
```

Error codes: `AUTHENTICATION_REQUIRED`, `AUTHORIZATION_DENIED`, `INVALID_INPUT`, `INVALID_RECIPIENT`, `INVALID_DOCUMENT`, `DOCUMENT_NOT_FOUND`, `DOCUMENT_ACCESS_DENIED`, `GOOGLE_API_ERROR`, `RATE_LIMITED`, `NETWORK_ERROR`, `DUPLICATE_REQUEST`, `POLICY_BLOCKED`, `CONFIRMATION_REQUIRED`, `INTERNAL_ERROR`.

Input that fails schema validation, such as a missing required field, an unknown field or an unsupported `content_type`, is rejected by the MCP SDK before the tool runs. Those rejections come back as a standard MCP tool error (`isError: true` with a text explanation) rather than in the structured format above.

## Weekly note

The server provides an MCP prompt, `weekly_note`, which MCP apps show as a ready-made command. It has three optional arguments: `notes` (your raw updates), `week_of` (a Monday, `YYYY-MM-DD`) and `recipient`. The prompt tells the AI app to:

1. write a plain-text, one-page note (at most 3,500 characters) with the sections Highlights, Progress, Challenges / Risks and Next Week
2. save it in a Google Doc (idempotency key `weekly-doc-<Monday>`):
   - if `SUMMARY_DOC_ID` is set, add it to the end of that Doc with `google_docs_append`, under the heading `Weekly Note – Week of <Monday> — <date and time>`
   - otherwise, if `googleDocs.create` is on, create a new Doc titled `Weekly Note – Week of <Monday>` with `google_docs_create`
3. email it with `gmail_send_email` to `WEEKLY_NOTE_RECIPIENT`, with the subject `Weekly Note – Week of <Monday>`, ending with `Google Doc: <link>` (idempotency key `weekly-note-<Monday>`)

The steps follow `policy.json`. With confirmation off (the deployed setting), the prompt tells the AI app to run straight through without asking for approval, so weekly runs can be fully unattended. If you turn `requireConfirmation` back on, the prompt adds a "show the note and ask for approval" step.

These names are suggestions for the prompt only. An agent that calls the tools directly chooses its own subject, body and Doc title.

The AI app writes the note; the server never generates content. The server enforces the rules through [policy.json](policy.json):

- Only `vaishu1996@gmail.com` can receive mail (`allowedRecipients`, `maxRecipients: 1`).
- The email body is capped at 5,000 bytes (`maxBodyBytes`), so a note longer than about one page is rejected.
- No confirmation step for email, Doc creation or appends (`requireConfirmation: false` in both sections), so runs are unattended. The recipient allowlist, size cap and Doc restrictions below are what keep unattended runs safe.
- `googleDocs.create: true` lets the agent create Docs with `google_docs_create`. With `restrictToCreatedDocuments: true`, the server can only read or append to Docs it created itself, plus any listed in `allowedDocumentIds`. Your other documents stay out of reach.
- Alternatively, put an existing Doc's ID in `googleDocs.allowedDocumentIds` and set `SUMMARY_DOC_ID` to it.

The idempotency keys mean that retrying a week's note within `IDEMPOTENCY_TTL_SECONDS` (24 hours by default) returns the original result instead of adding or sending it again.

**Setup:** either let the agent create the Doc with `google_docs_create`, or create it yourself, signed in as the authorized account, and set `SUMMARY_DOC_ID` to its ID or URL. Locally, also set `POLICY_FILE` to the path of `policy.json`; the Vercel deployment loads it automatically. Timestamps use `TIMESTAMP_TIMEZONE`.

## Architecture

```text
 Claude │ ChatGPT │ Gemini │ Cursor │ VS Code │ custom agent
                         │  MCP (stdio or Streamable HTTP)
┌────────────────────────▼─────────────────────────────────────────┐
│ google-workspace-mcp                                             │
│  server/        tool registry, schemas, uniform tool runner      │
│                 (request IDs, identity, structured errors, logs) │
│  policy/        limits, allowlists, confirmation (elicitation    │
│                 or single-use token)                             │
│  utils/         validation, idempotency, retry with backoff      │
│  auth/          TokenStore interface (AES-256-GCM file store),   │
│                 OAuth 2.0 + PKCE flow, user resolution           │
│  integrations/  Gmail adapter + MIME builder, Docs adapter +     │
│                 append-location resolution                       │
│  audit/, observability/   audit log, Prometheus metrics          │
└────────────────────────┬─────────────────────────────────────────┘
                         │ Google OAuth 2.0 (per-user tokens)
              ┌──────────┴──────────┐
         Gmail API            Google Docs API
```

The MCP tools depend only on the narrow `GmailApi`, `DocsApi`, `TokenStore`, `IdempotencyStore` and `AuditSink` interfaces. Storage backends and Google adapters can be swapped without touching tool code. New tools are added to `TOOLS` in [src/server/mcpServer.ts](src/server/mcpServer.ts).

## Tech stack

| Area | Technology |
|---|---|
| Language and runtime | TypeScript (ES modules) on Node.js 20+ |
| MCP | `@modelcontextprotocol/server` and `@modelcontextprotocol/node`, over stdio or Streamable HTTP |
| Google APIs | `@googleapis/gmail`, `@googleapis/docs`, `google-auth-library` (OAuth 2.0 + PKCE) |
| Validation | `zod` schemas for tool inputs and configuration |
| Storage | Encrypted local files (AES-256-GCM) by default; Upstash Redis (`@upstash/redis`) for serverless deployments |
| Observability | Structured JSON logs and a built-in Prometheus-format `/metrics` endpoint (no extra libraries) |
| Deployment | Vercel serverless function ([api/index.js](api/index.js), [vercel.json](vercel.json)) or Docker on `node:22-alpine` |
| Tooling | Vitest, ESLint (`typescript-eslint`), Prettier, `tsc` |

## Google Cloud setup

1. Create or select a project at <https://console.cloud.google.com>.
2. **APIs & Services → Library**: enable the **Gmail API** and the **Google Docs API**.
3. **APIs & Services → OAuth consent screen**:
   - Choose *External*, or *Internal* for Workspace-only use. Fill in the app name and support email.
   - Add these scopes:

     | Scope | Why |
     |---|---|
     | `https://www.googleapis.com/auth/gmail.send` | Send email only. No mailbox read access. |
     | `https://www.googleapis.com/auth/documents` | Read and edit Google Docs through the Docs API. |
     | `openid`, `email` | Show which account is connected. |

   - While the app is in *Testing*, add your account under **Test users**. `gmail.send` is a sensitive scope: Google verification is required before users outside your organization can authorize a published app.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - For local use only, a **Desktop app** client works with the loopback redirect.
   - For remote mode, create a **Web application** client and add both `http://127.0.0.1:53682/oauth2callback` and `https://<your-host>/oauth2/callback` as authorized redirect URIs.
5. Copy the client ID and secret into `.env`.

The server rejects scopes broader than these unless you set `ALLOW_BROAD_SCOPES=true`.

## Local development (stdio)

Requires Node.js 20 or later.

```bash
npm install
cp .env.example .env          # set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
openssl rand -base64 32       # paste the output as TOKEN_STORE_ENCRYPTION_KEY
npm run build
npm run auth                  # opens a Google consent URL; tokens are stored encrypted
npm run auth -- --status      # shows which account is connected
npm start                     # stdio server (normally your MCP host launches this)
```

`npm run auth -- --revoke` revokes the grant at Google and deletes it locally.

Tokens, idempotency records and the audit log live in `DATA_DIR` (default `~/.config/google-workspace-mcp`). That directory is created with `0700` permissions and its files with `0600`.

### MCP client configuration

The examples below are host configurations. None of them is required by the server.

**Claude Desktop, Cursor and other hosts using the `mcpServers` format** ([examples/mcp-config.stdio.json](examples/mcp-config.stdio.json)):

```json
{
  "mcpServers": {
    "google-workspace": {
      "command": "node",
      "args": ["/absolute/path/to/google-workspace-mcp/dist/index.js"],
      "env": { "ENV_FILE": "/absolute/path/to/google-workspace-mcp/.env" }
    }
  }
}
```

**VS Code** (`.vscode/mcp.json`, see [examples/vscode-mcp.json](examples/vscode-mcp.json)): the same command, under `"servers"` with `"type": "stdio"`.

**MCP Inspector**, a vendor-neutral way to test the server:

```bash
npx @modelcontextprotocol/inspector node dist/index.js
```

## Remote deployment (Streamable HTTP)

```bash
npm run hash-token -- alice        # prints a bearer token for alice plus the hash entry
# .env: MCP_HTTP_TOKEN_HASHES=alice:<hash>,bob:<hash>
#       MCP_PUBLIC_BASE_URL=https://mcp.example.com
#       OAUTH_STATE_SECRET=<32+ random chars>
npm run start:http                 # serves /mcp, /oauth2/callback, /healthz, /metrics
```

- **Authentication.** Each bearer token maps to exactly one user ID, and that ID selects that user's own Google credentials. Holding a valid token for one user never grants access to another user's Google account. Configuration stores only SHA-256 hashes of the tokens.
- **Connecting Google.** When a user hasn't authorized, `connection_get_status` returns an `authorization_url`: a signed, single-use link valid for 10 minutes. The user opens it in a browser and Google redirects back to `/oauth2/callback`. Alternatively, an operator can run `npm run auth -- --user alice` on the server.
- **Clients** connect to `https://<host>/mcp` with an `Authorization: Bearer …` header ([examples/mcp-config.http.json](examples/mcp-config.http.json)).
- **Docker.** Build with `docker build -f docker/Dockerfile -t google-workspace-mcp .` and run with `docker run --env-file .env -e MCP_HTTP_HOST=0.0.0.0 -p 3000:3000 -v gwmcp-data:/data google-workspace-mcp`.
- **Production checklist.**
  - Terminate TLS in front of the server.
  - Set `MCP_HTTP_ALLOWED_ORIGINS` if browsers will connect.
  - Back `DATA_DIR` with a persistent, encrypted volume.
  - For multiple instances, implement `TokenStore` (KMS or secret manager), `IdempotencyStore` (Redis or a database) and `AuditSink` over shared storage.
  - Scrape `/metrics` with a bearer token.
- **Limitation.** Remote auth uses static per-user bearer tokens, not a full MCP OAuth 2.1 authorization server. See [docs/decisions.md](docs/decisions.md#6-remote-authentication).

## Policy

Set `POLICY_FILE` to a JSON file (see [examples/policy.example.json](examples/policy.example.json)):

```json
{
  "gmail": { "send": true, "maxRecipients": 20, "requireConfirmation": true,
             "allowedRecipients": [], "allowedRecipientDomains": ["example.com"], "blockedRecipientDomains": [] },
  "googleDocs": { "append": true, "requireConfirmation": false, "allowedDocumentIds": [] },
  "confirmation": { "mode": "auto", "tokenTtlSeconds": 300 }
}
```

- `allowedRecipients` lists exact addresses (case-insensitive). When it isn't empty, every To/Cc/Bcc recipient must be on it, in addition to the domain rules. Blocked addresses are reported as a count, never echoed back.

How confirmation works depends on `confirmation.mode`:

- **`auto`:**
  - Hosts that support MCP elicitation ask the user directly.
  - Other hosts receive `CONFIRMATION_REQUIRED` with a single-use token bound to the exact arguments. The agent shows the summary to the user and calls again with `confirmation_token`.
- **`elicitation_only`:** refuses side effects on hosts that can't ask the user directly.
- **`token_only`:** always uses the token flow.

## Security

- **Least privilege.** The server requests only `gmail.send` + `documents` (+ `openid email`). It has no mailbox read, Drive or delete capability.
- **Credentials stay server-side.**
  - Tokens are encrypted with AES-256-GCM, using a scrypt-derived key. Each entry is bound to its user ID.
  - Refreshed tokens are written back to the store automatically.
  - Tokens and secrets never appear in tool responses, logs or errors.
- **Side effects are explicit.** Email is sent and documents are modified only through explicit tool calls. Authorization comes from the tool call plus server policy, never from document or email content (§16.4).
- **Input validation.**
  - Strict schemas reject unknown fields.
  - Email address syntax is checked, and header injection is blocked.
  - Recipient counts and body/append sizes are bounded.
  - Document IDs are validated.
- **No duplicates.**
  - `idempotency_key` support, plus automatic suppression of identical repeats.
  - Gmail sends are never retried automatically.
  - Docs retries first check whether the earlier attempt was already applied.
- **Errors.** Errors are categorized and sanitized: no stack traces, request configs or raw provider payloads reach clients.
- **Logs.** Logs are structured JSON on stderr with a `request_id` per call. Bodies, content and credentials are redacted, and recipient addresses are hashed by default.
- **Audit.** Every attempted side effect is written to `DATA_DIR/audit.log`, without email or document content.

## Testing

```bash
npm test                  # unit + MCP contract + transport tests (no Google account needed)
npm run typecheck && npm run lint
npm run check             # typecheck, lint, test, build
npm run test:integration  # live Google tests; see tests/integration/*.ts for the required env
```

- **Unit tests** cover validation, MIME construction, error mapping, append text, tab resolution, idempotency, retry, the token store, config, policy, logging redaction and metrics.
- **Contract tests** use a generic MCP client, with no host-specific behavior. They:
  - discover the tools and check their schemas
  - call every tool
  - check structured success and error responses
  - exercise both confirmation flows, including elicitation
  - verify that document content can't trigger an email
- **Transport tests** start the built server over stdio, and run Streamable HTTP with per-user token isolation.

## Project layout

```text
src/
├── index.ts                 entry point: --transport=stdio|http
├── container.ts             wires production dependencies
├── config/config.ts         validated environment configuration
├── server/                  MCP server, tool runner, schemas, tools/
├── integrations/google/     Gmail and Docs adapters, MIME, append logic, OAuth client
├── auth/                    token store, OAuth flow, user context
├── policy/                  policy engine, confirmation service
├── errors/                  error categories, Google error mapping
├── audit/  observability/   audit sink, metrics
├── http/httpServer.ts       Streamable HTTP, bearer auth, OAuth callback
├── cli/                     `npm run auth`, `npm run hash-token`
└── utils/                   validation, idempotency, retry, logging, file store
tests/  unit/  contract/  integration/
```
