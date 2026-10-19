# Design decisions

Records the choices made while implementing [problem-statement(MCP).md](../problem-statement(MCP).md) where the spec left room for interpretation.

## 1. Tool names: underscores by default

The spec names tools `gmail.send_email` and similar. The MCP spec allows dots, but some hosts' function-calling layers only accept `^[a-zA-Z0-9_-]+$`. The server registers `gmail_send_email`, `google_docs_append`, `google_docs_get_metadata` and `connection_get_status` by default. Set `TOOL_NAME_STYLE=dotted` to expose the spec's names exactly.

Responses always report the canonical dotted name in `operation`, whichever style is used on the wire.

## 2. Reply threading under the `gmail.send` scope

`gmail.send` cannot read messages, so the server cannot look up the original email's `Message-ID` header from a Gmail message ID. Two optional fields cover threading:

- `reply_to_message_id`: the **RFC 5322 `Message-ID` header** of the original email. The server sets `In-Reply-To` and `References` from it.
- `thread_id`: the Gmail thread to add the message to.

A bare Gmail API ID (such as `18c123abc456`) passed as `reply_to_message_id` is rejected with an explanatory `INVALID_INPUT` error. The alternative, adding `gmail.metadata`, would widen the scopes and needs separate justification (§13).

## 3. Docs edit permission is detected at write time

`documents.get` only proves the account can read a document. Checking write permission ahead of time would need Drive scopes, so it isn't checked. A 403 from `batchUpdate` maps to `DOCUMENT_ACCESS_DENIED`.

## 4. Duplicate prevention

- **Explicit `idempotency_key`:** stored for `IDEMPOTENCY_TTL_SECONDS`. A repeat call returns the original result with `idempotent_replay: true`. Reusing a key with different arguments returns `DUPLICATE_REQUEST`.
- **No key:** identical requests are suppressed within `AUTO_DEDUPE_WINDOW_SECONDS` (default 60) with `DUPLICATE_REQUEST`. A silent replay could make an agent report "sent again" when nothing was sent. To resend on purpose, pass a new key.
- **Gmail sends are never retried automatically.** If the outcome is unknown (timeout, connection reset or 5xx after the request was written), the key is marked `outcome_unknown`. Later attempts with that key are refused, and the error tells the agent the email may already have been sent.
- **Docs appends are retried** on 429, 5xx and network errors. Before each retry the server re-reads the target tab. If the text is already at the end, it reports success (`verified_after_retry: true`) instead of inserting it again.
- **Limitation:** the idempotency store is a local file (or memory). Multi-instance deployments must implement `IdempotencyStore` over a shared database or Redis.

## 5. Confirmation without depending on the host

When policy requires confirmation:

1. **Clients that declare the elicitation capability** get a standard MCP input request: `inputRequired` on the 2026-07-28 protocol, shimmed to `elicitation/create` for 2025-era sessions. The host asks the user, and the action runs only on `confirm: true`.
2. **Other clients** get a `CONFIRMATION_REQUIRED` error with a single-use token. The token expires after 5 minutes and is bound to the user, the operation and a hash of the exact arguments.

   The token path relies on the agent to show the summary to the user, because the server cannot verify that it did. For deployments where that isn't acceptable, set `confirmation.mode: "elicitation_only"`, which refuses side effects on clients that can't ask the user directly.

## 6. Remote authentication

HTTP mode uses per-user bearer tokens. Configuration holds only their SHA-256 hashes, and tokens are compared in constant time. Each token resolves to exactly one `userId`, which selects that user's Google credentials (§15, §33). Users connect their Google account through `authorization_url`, which `connection.get_status` returns: a signed, single-use, 10-minute OAuth state completed at `/oauth2/callback`.

This is not a full MCP OAuth 2.1 authorization server with dynamic client registration. Adding one is the main next step for public multi-tenant hosting. The `resolveUserContext` seam is the only code that would change.

**Linking risk:** anyone who obtains a user's unexpired `authorization_url` could link *their own* Google account to that user's slot. The URL is short-lived and single-use. `connection.get_status` shows which account is linked.

## 6a. Creating documents (beyond the original spec)

The problem statement lists creating Google Docs as an MVP non-goal (§5). It was added at the user's request as `google_docs.create`, with these guards:

- **Off by default.** `googleDocs.create` must be enabled in policy.
- **No new permission.** The `documents` scope already covers creating documents.
- **Lock-down.** With `googleDocs.restrictToCreatedDocuments`, the server can only read or append to documents it created for that user, plus any in `allowedDocumentIds`. Created document IDs are recorded per user, in `DATA_DIR/created-docs.json` locally or in the shared KV store on Vercel.
- **No duplicates.** Creation is never retried automatically. If the document is created but inserting its initial content fails, the error returns the new `document_id`, the create is marked as done, and the agent finishes with `google_docs.append` instead of creating a second document.

## 7. Append text layout

The appended block is laid out as `[separator][timestamp/heading line][content]`. The separator comes first so new text never runs into the document's last paragraph. It is skipped when the target tab is empty. `custom_separator` is inserted verbatim. The heading is plain text: §21 rules out interpreting formatting in the MVP.

## 8. Logging and audit

Logs are JSON lines on stderr, because stdout carries the stdio protocol. Token, secret, body, content and heading fields are redacted by key name. Recipient addresses are hashed by default (`LOG_RECIPIENTS`).

Audit records go to `DATA_DIR/audit.log` and store targets, outcomes and a SHA-256 of the content, never the content itself.
