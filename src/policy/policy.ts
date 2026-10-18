import { readFileSync } from 'node:fs';
import * as z from 'zod';
import type { Config } from '../config/config.js';
import { AppError } from '../errors/appError.js';
import { domainOf } from '../utils/validation.js';

/** Deployment-level controls (§34). Authorization comes from tool calls + this policy, never from content. */
const policyFileSchema = z
  .object({
    gmail: z
      .object({
        send: z.boolean(),
        maxRecipients: z.number().int().positive(),
        maxBodyBytes: z.number().int().positive(),
        requireConfirmation: z.boolean(),
        allowedRecipientDomains: z.array(z.string()),
        blockedRecipientDomains: z.array(z.string()),
      })
      .partial()
      .strict(),
    googleDocs: z
      .object({
        append: z.boolean(),
        maxAppendBytes: z.number().int().positive(),
        requireConfirmation: z.boolean(),
        allowedDocumentIds: z.array(z.string()),
      })
      .partial()
      .strict(),
    confirmation: z
      .object({
        /**
         * auto: host-mediated elicitation when the client supports it, else a confirmation token.
         * elicitation_only: refuse side effects on clients that cannot ask the user directly.
         * token_only: always use the two-step token flow.
         */
        mode: z.enum(['auto', 'elicitation_only', 'token_only']),
        tokenTtlSeconds: z.number().int().positive().max(3600),
      })
      .partial()
      .strict(),
  })
  .partial()
  .strict();

export interface Policy {
  gmail: {
    send: boolean;
    maxRecipients: number;
    maxBodyBytes: number;
    requireConfirmation: boolean;
    allowedRecipientDomains: string[];
    blockedRecipientDomains: string[];
  };
  googleDocs: {
    append: boolean;
    maxAppendBytes: number;
    requireConfirmation: boolean;
    allowedDocumentIds: string[];
  };
  confirmation: { mode: 'auto' | 'elicitation_only' | 'token_only'; tokenTtlSeconds: number };
}

export function defaultPolicy(config: Config): Policy {
  return {
    gmail: {
      send: true,
      maxRecipients: config.limits.maxEmailRecipients,
      maxBodyBytes: config.limits.maxEmailBodyBytes,
      requireConfirmation: false,
      allowedRecipientDomains: [],
      blockedRecipientDomains: [],
    },
    googleDocs: {
      append: true,
      maxAppendBytes: config.limits.maxDocAppendBytes,
      requireConfirmation: false,
      allowedDocumentIds: [],
    },
    confirmation: { mode: 'auto', tokenTtlSeconds: 300 },
  };
}

export function mergePolicy(base: Policy, overrides: unknown): Policy {
  const parsed = policyFileSchema.safeParse(overrides);
  if (!parsed.success) {
    throw new Error(
      `Invalid policy: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const o = parsed.data;
  const lower = (xs: string[] | undefined) => xs?.map((d) => d.toLowerCase().replace(/^@/, ''));
  return {
    gmail: {
      ...base.gmail,
      ...o.gmail,
      allowedRecipientDomains: lower(o.gmail?.allowedRecipientDomains) ?? base.gmail.allowedRecipientDomains,
      blockedRecipientDomains: lower(o.gmail?.blockedRecipientDomains) ?? base.gmail.blockedRecipientDomains,
    },
    googleDocs: { ...base.googleDocs, ...o.googleDocs },
    confirmation: { ...base.confirmation, ...o.confirmation },
  };
}

export function loadPolicy(config: Config): Policy {
  const base = defaultPolicy(config);
  if (!config.policyFile) return base;
  const raw = JSON.parse(readFileSync(config.policyFile, 'utf8')) as unknown;
  return mergePolicy(base, raw);
}

function domainMatches(domain: string, rule: string): boolean {
  return domain === rule || domain.endsWith(`.${rule}`);
}

export class PolicyEngine {
  constructor(readonly policy: Policy) {}

  checkGmailSend(recipients: string[], bodyBytes: number): void {
    const p = this.policy.gmail;
    if (!p.send) throw new AppError('POLICY_BLOCKED', 'Sending email is disabled by server policy.');
    if (recipients.length > p.maxRecipients) {
      throw new AppError(
        'POLICY_BLOCKED',
        `Too many recipients (${recipients.length}); the limit across to/cc/bcc is ${p.maxRecipients}.`,
        { details: { max_recipients: p.maxRecipients } },
      );
    }
    if (bodyBytes > p.maxBodyBytes) {
      throw new AppError('POLICY_BLOCKED', `Email body exceeds the ${p.maxBodyBytes}-byte limit.`, {
        details: { max_body_bytes: p.maxBodyBytes },
      });
    }
    const blocked = recipients.filter((r) => {
      const d = domainOf(r);
      if (p.blockedRecipientDomains.some((rule) => domainMatches(d, rule))) return true;
      return (
        p.allowedRecipientDomains.length > 0 &&
        !p.allowedRecipientDomains.some((rule) => domainMatches(d, rule))
      );
    });
    if (blocked.length > 0) {
      throw new AppError(
        'POLICY_BLOCKED',
        'One or more recipient domains are not permitted by server policy.',
        {
          details: { blocked_domains: [...new Set(blocked.map(domainOf))] },
        },
      );
    }
  }

  checkDocsAppend(documentId: string, bytes: number): void {
    const p = this.policy.googleDocs;
    if (!p.append)
      throw new AppError('POLICY_BLOCKED', 'Appending to Google Docs is disabled by server policy.');
    if (p.allowedDocumentIds.length > 0 && !p.allowedDocumentIds.includes(documentId)) {
      throw new AppError('POLICY_BLOCKED', 'This document is not in the server policy allowlist.');
    }
    if (bytes > p.maxAppendBytes) {
      throw new AppError('POLICY_BLOCKED', `Appended content exceeds the ${p.maxAppendBytes}-byte limit.`, {
        details: { max_append_bytes: p.maxAppendBytes },
      });
    }
  }

  checkDocsRead(documentId: string): void {
    const p = this.policy.googleDocs;
    if (p.allowedDocumentIds.length > 0 && !p.allowedDocumentIds.includes(documentId)) {
      throw new AppError('POLICY_BLOCKED', 'This document is not in the server policy allowlist.');
    }
  }
}
