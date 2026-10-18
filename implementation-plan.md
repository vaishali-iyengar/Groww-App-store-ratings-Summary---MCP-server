# Implementation Plan: Generic Google Workspace MCP Server

Derived from [problem-statement(MCP).md](problem-statement(MCP).md). Section references (§) point to that document.

The plan has 9 phases, plus a Phase 0 for setup. Each phase ends with something you can run and an exit check. Phases 1–5 make up the single-user local MVP. Phases 6–9 add the production features: policy, remote mode, multiple users and observability.

## Phase Summary

| # | Phase | Outcome | Rough size |
|---|---|---|---|
| 0 | Foundations and decisions | Repo, toolchain, decisions written down | 0.5–1 day |
| 1 | MCP skeleton and shared pieces | stdio server any MCP client can discover | 1–2 days |
| 2 | Google OAuth and token store | Local account authorized; tokens refresh automatically | 2 days |
| 3 | `gmail.send_email` | Plain-text and HTML email with To/Cc/Bcc | 2 days |
| 4 | `google_docs.get_metadata` and `google_docs.append` | Tab-aware append at the end of a doc | 2–3 days |
| 5 | Reliability: errors, retries, idempotency | Duplicate-safe sends; full error categories | 2 days |
| 6 | Policy, confirmation, audit | Configurable limits and allowlists; audit records | 2 days |
| 7 | Testing and cross-host validation | Unit, contract and integration suites; 2+ hosts verified | 2–3 days |
| 8 | Remote mode and multiple users | Streamable HTTP, MCP auth, per-user encrypted tokens | 3–5 days |
| 9 | Observability, packaging, docs | Metrics, Docker, README, deployment guide | 1–2 days |

---

## Phase 0: Foundations and Decisions

**Goal:** settle the decisions that are expensive to change later.

- Set up Node 20+, TypeScript (strict), ESLint, Prettier and Vitest. Add `npm run build`, `lint`, `typecheck` and `test` scripts.
- Check the exact MCP SDK v2 package name and API against the official docs (§40) before installing anything. Don't add any Anthropic or OpenAI SDK.
- Create the folder layout from §7, plus `.gitignore` covering `.env` and the local token directory.
- **Decisions to record in `docs/decisions.md`:**
  1. **Tool names.** The spec's dotted names (`gmail.send_email`) are allowed by the MCP spec. However, some hosts' function-calling layers only accept `^[a-zA-Z0-9_-]+$`. **Recommendation:** register `gmail_send_email` and similar names (underscores), or make the separator a config option. Confirm this with real hosts in Phase 7.
  2. **Reply threading under the `gmail.send` scope.** That scope can't read the original message's `Message-ID` header, and Gmail needs that header to set `In-Reply-To`/`References`. **Recommendation:** for the MVP, accept `thread_id` plus an optional caller-supplied `in_reply_to` header value. Adding `gmail.metadata` would require a separate justification.
  3. **Docs edit access.** `documents.get` only shows that the user can *read* a doc. Edit permission is only known when `batchUpdate` returns a 403, unless Drive scopes are added. **Recommendation:** for the MVP, map that 403 to `DOCUMENT_ACCESS_DENIED` and add no Drive scope.

**Exit:** an empty project builds, lints and passes a placeholder test.

---

## Phase 1: MCP Skeleton and Shared Pieces

**Goal:** a provider-neutral server that any MCP client can discover and call.

- `config/config.ts`: a Zod-validated environment schema (§26). Startup fails fast with a clear message and never prints secret values. Add `.env.example`.
- `utils/logging.ts`: a structured JSON logger with a `request_id` on every tool call. It redacts token, secret and body fields. **Logs go to stderr only**, because stdout carries the stdio protocol.
- `errors/`: an `AppError` class with the 13 error codes from §18 and a `retryable` flag. One `toToolResult()` function produces both `structuredContent` and a text fallback, with `isError: true` on failures.
- `server/mcpServer.ts`: creates the server and registers tools from a list, so new tools only add a file (§36).
- Tool wrapper middleware: request ID → input validation → policy hook (no-op for now) → handler → error normalization → log line with duration.
- Each tool gets an input schema, an output schema and annotations: `destructiveHint`, `idempotentHint` and `openWorldHint` set honestly.
- `connection.get_status` returns `google_oauth_configured: false` for now.
- stdio transport in `index.ts`.

**Exit:** MCP Inspector connects, lists the tool, reads its schema and gets a structured response.

---

## Phase 2: Google OAuth and Token Store

**Goal:** one authorized Google account whose tokens refresh without the user re-authorizing.

- `TokenStore` interface (§14) with a first implementation, `EncryptedFileTokenStore`. It uses AES-256-GCM with `TOKEN_STORE_ENCRYPTION_KEY` and saves to `~/.config/google-workspace-mcp/` with `0600` file permissions.
- `auth/oauth.ts`: a **separate CLI command** (`npm run auth`). It runs the authorization-code flow with PKCE, a localhost redirect, `access_type=offline` and `prompt=consent`, then stores the tokens. Tool calls never open a browser.
- `integrations/google/oauthClient.ts`: builds an `OAuth2Client` per user and saves refreshed tokens back through the store. If the refresh fails with `invalid_grant`, it returns `AUTHENTICATION_REQUIRED` with instructions to re-run the auth command.
- Identity resolution: `resolveUserContext(request) → userId`. For the MVP this returns the single configured account. It sits behind an interface so Phase 8 can replace it (§15).
- Scopes are fixed to `gmail.send` and `documents`. Startup rejects broader scopes unless they are explicitly allowed.
- `connection.get_status` reports whether OAuth is configured, whether each service is available, and the authorized email. The email is taken from the `id_token`, so this needs the `openid email` scopes; otherwise the field stays empty. Record that choice.

**Exit:** after `npm run auth`, `connection.get_status` shows the account. Deleting the access token but keeping the refresh token still works.

---

## Phase 3: `gmail.send_email`

**Goal:** correct, validated email sending.

- `schemas/gmailSchemas.ts`:
  - `to` has 1–N addresses; `to + cc + bcc` combined must stay at or under `MAX_EMAIL_RECIPIENTS`.
  - Addresses are checked for valid syntax and de-duplicated. Addresses with CR/LF are rejected, which blocks header injection.
  - `subject` is a non-null string with no newlines. `body` must not be empty and must fit within `MAX_EMAIL_BODY_BYTES`.
  - `content_type` is limited to `text/plain` and `text/html`.
  - `thread_id`, `in_reply_to` and `idempotency_key` are optional.
- `integrations/google/gmailClient.ts`: builds RFC 5322 MIME messages.
  - Subject is RFC 2047 encoded-word UTF-8. Body is UTF-8 with base64 transfer encoding.
  - HTML emails are sent as `multipart/alternative` with an auto-generated text part.
  - Bcc is placed in the raw message (Gmail removes it before delivery). The message is base64url-encoded and sent with `users.messages.send`.
- The response matches §8.1. `recipients` lists To/Cc only; Bcc is reported as a count so it isn't echoed back.
- **No automatic retry for sends yet** (that comes in Phase 5).
- Write a description aimed at an agent that states the side effect plainly (§25).

**Exit:** plain-text, HTML, UTF-8 subject and Cc/Bcc emails all arrive correctly. Invalid inputs are rejected before any API call.

---

## Phase 4: Google Docs Tools

**Goal:** tab-aware append that cannot overwrite existing content.

- `google_docs.get_metadata`: calls `documents.get` with `includeTabsContent=true` and returns the title, `revisionId` and a flattened list of tabs (tabs can be nested as child tabs). It never returns body content.
- `utils/validation.ts`: a document ID format check, plus an optional helper that pulls the ID out of a full Docs URL.
- `resolveAppendLocation(document, tabId?)` (§20), kept as a pure function so it can be unit-tested:
  - If no tab is given, it uses the first tab, or the legacy `body` for documents without tabs.
  - If a `tab_id` doesn't exist, it returns `INVALID_DOCUMENT` instead of guessing a location.
  - It returns `{ endOfSegmentLocation: { tabId } }`.
- `buildAppendText({heading, separator, custom_separator, timestamp, content})`: combines the parts in the order heading, separator, content (§21).
  - The separator goes *before* the appended block so new text doesn't run into the existing last paragraph.
  - A timestamp is ISO 8601, with a configurable time zone.
  - `custom_separator` is required only when `separator` is `custom`.
- One `batchUpdate` with `insertText` at `endOfSegmentLocation`. A 403 maps to `DOCUMENT_ACCESS_DENIED` and a 404 to `DOCUMENT_NOT_FOUND`.
- `characters_appended` is counted in UTF-16 code units, matching how Google indexes text.
- The heading is plain text in the MVP. Applying a `HEADING_2` style is left for later, because it needs explicit index calculation.

**Exit:** appends work on a doc without tabs, on a doc with several tabs (correct tab chosen), and on content with emoji and non-Latin characters. Existing text is never changed.

---

## Phase 5: Reliability

**Goal:** safe retries and errors that agents can act on.

- `errors/googleErrors.ts`: one mapping table from HTTP status and Google error reason to an error code. For example, 401 maps to `AUTHENTICATION_REQUIRED`, 403 to `AUTHORIZATION_DENIED` or `DOCUMENT_ACCESS_DENIED`, 429 or `rateLimitExceeded` to `RATE_LIMITED`, 5xx to `GOOGLE_API_ERROR` (retryable), and socket errors to `NETWORK_ERROR`.
- `withRetry()`: bounded exponential backoff with full jitter that respects `Retry-After`. It applies to metadata reads and Docs appends.
- `utils/idempotency.ts`: an `IdempotencyStore` interface, starting with in-memory/file storage and a TTL.
  - Each entry is keyed by `key + operation + userId` and also stores a hash of the request.
  - States are `in_flight`, `succeeded` and `failed`.
  - A repeated key with the same hash returns the stored result. A repeated key with a different hash returns `DUPLICATE_REQUEST`. A key still `in_flight` also returns `DUPLICATE_REQUEST`.
  - **Gmail:** retry only when an idempotency key is present *and* the failure happened before the request reached Google, such as a connection refusal. If the outcome is unknown, for example a timeout after the request was sent, return a non-retryable error that says the email may have been sent.
  - **Docs:** use the same mechanism. If no key is given, derive an automatic key from a content hash within a short time window.

**Exit:** unit tests cover every error mapping. Sending the same idempotency key twice sends one email.

---

## Phase 6: Policy, Confirmation, Audit

**Goal:** deployment-level controls that don't depend on the host (§16, §34, §35).

- `policy/` engine, loaded from a JSON file or environment variables. It controls:
  - whether each tool is enabled at all
  - recipient-count limits and allowed or blocked recipient domains
  - `allowedDocumentIds`
  - size limits
  - `requireConfirmation`
- A blocked call returns `POLICY_BLOCKED` with a clear reason.
- **Confirmation without depending on the host:**
  - Use MCP **elicitation** when the client supports it, offering accept or decline.
  - Otherwise fall back to a two-step flow: the first call returns `confirmation_required` with a short-lived, single-use `confirmation_token` bound to a hash of the request, and the agent calls again with that token.
  - Both paths are standard MCP and work with any client.
- Authorization comes only from tool arguments and policy. No code path reads Google content and then acts on it (§16.4). Add a test that documents this.
- `audit/`: an `AuditSink` interface writing an append-only JSONL file. It records every side effect, including policy blocks, and stores targets and hashes but not content.

**Exit:** with `requireConfirmation` on, sends are held until confirmed, in Inspector and in at least one host.

---

## Phase 7: Testing and Cross-Host Validation

**Goal:** prove the server works for any agent.

- **Unit tests** (§29.1): validation, MIME construction (including snapshot tests of raw output), error mapping, separator/heading/timestamp text, `resolveAppendLocation`, idempotency, token store encryption round-trip, config.
- **Contract tests** (§29.3): use the SDK's generic **client** over in-memory and stdio transports to connect, list tools, check schemas, call each tool against mocked Google adapters, and check both success and error shapes.
- **Integration tests** (§29.2): skipped by default and enabled with `RUN_INTEGRATION=1`. They use a dedicated test Google account and test doc, and cover all 10 scenarios, including revoked-token and unauthorized-doc cases.
- **Manual cross-host check:** run the §38 Definition of Done with at least two different hosts, such as MCP Inspector plus Cursor, VS Code or Claude Desktop. Record any tool-name or schema quirks.

**Exit:** CI passes lint, typecheck, unit and contract tests. The §38 checklist passes on two hosts.

---

## Phase 8: Remote Mode and Multiple Users

**Goal:** a deployment safe to expose to the internet (§23, §33).

- Streamable HTTP transport behind a `--transport=http` flag, with the same tool registry as stdio.
- **MCP authorization:** follow the MCP auth spec (OAuth 2.1, protected-resource metadata).
  - The server signs users in with Google and issues its own MCP access tokens.
  - Each MCP token maps to an internal `userId`, and that ID maps to that user's Google tokens.
  - Google tokens are never passed through to clients.
- Replace `resolveUserContext` with an implementation driven by the token. Add tests showing user A can never reach user B's credentials.
- Production `TokenStore`: a database with KMS-encrypted fields, or a cloud secret manager. Production `IdempotencyStore`: Redis or the same database, so multiple instances stay consistent.
- Hardening: TLS, Origin checks, rate limiting per user, request size limits, CORS lockdown.

**Exit:** two Google accounts work at the same time through one remote deployment, each fully isolated.

---

## Phase 9: Observability, Packaging, Docs

- Prometheus metrics (§28): calls, errors by code, Google API latency per service, retries and idempotency hits. Expose them on `/metrics` in HTTP mode.
- `docker/Dockerfile` (multi-stage, non-root user). Example host configs go in `examples/` for several clients, so none of them is treated as the default.
- `README.md` covering everything listed in §39, plus a Google Cloud and consent screen setup guide and a note on the scope-verification process for apps published beyond test users.
- Go through the §30 acceptance checklist item by item.

---

## Order of Work and Parallelism

- 0 → 1 → 2 must happen in order.
- **3 and 4 can be built in parallel.** Both depend only on Phase 2.
- 5 and 6 can overlap. Unit tests for Phase 7 should be written alongside each phase, not saved for the end.
- 8 and 9 come after the MVP (phases 1–7) is accepted.

## Main Risks

1. **Tool-name compatibility across hosts.** Decide in Phase 0 and verify in Phase 7.
2. **Reply threading under the narrow scope.** The MVP limitation must be documented.
3. **Duplicate sends after an ambiguous timeout.** Idempotency reduces the risk but can't remove it, so the README must say so.
4. **Google OAuth app verification.** Sensitive scopes need Google's review before external users can authorize. Start that process early if the server is meant for users outside your organization.
