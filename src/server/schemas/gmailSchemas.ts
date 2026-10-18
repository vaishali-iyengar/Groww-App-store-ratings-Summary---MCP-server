import * as z from 'zod';

const address = z.string().max(320);
/** Hard structural cap; the effective (configurable) recipient limit is enforced by policy. */
const recipientList = z.array(address).max(100);

export const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/)
  .describe(
    'Optional unique key for this request (e.g. a UUID). Retrying with the same key never performs the action twice; ' +
      'the original result is returned instead.',
  );

export const confirmationToken = z
  .string()
  .max(128)
  .describe(
    'Only when a previous call returned CONFIRMATION_REQUIRED and the user approved: the token from that error.',
  );

export const sendEmailInput = z
  .object({
    to: z
      .array(address)
      .min(1)
      .max(100)
      .describe(
        'Primary recipients. Plain email addresses only (e.g. "priya@example.com"), no display names.',
      ),
    cc: recipientList.optional().describe('Optional Cc recipients (plain email addresses).'),
    bcc: recipientList
      .optional()
      .describe('Optional Bcc recipients (plain email addresses). Hidden from other recipients.'),
    subject: z.string().max(2000).describe('Email subject line. Must be non-empty and a single line.'),
    body: z.string().describe('Email body. Plain text, or HTML when content_type is "text/html".'),
    content_type: z
      .enum(['text/plain', 'text/html'])
      .default('text/plain')
      .describe('Body format. HTML emails automatically include a plain-text alternative.'),
    thread_id: z
      .string()
      .regex(/^[A-Za-z0-9]{1,64}$/)
      .optional()
      .describe('Optional Gmail thread ID to add this message to an existing conversation.'),
    reply_to_message_id: z
      .string()
      .max(998)
      .optional()
      .describe(
        'Optional RFC 5322 Message-ID header of the email being replied to, e.g. "<CAF=abc@mail.gmail.com>". ' +
          'Sets In-Reply-To/References. Use together with thread_id and a matching subject ("Re: ...") for Gmail threading.',
      ),
    idempotency_key: idempotencyKey.optional(),
    confirmation_token: confirmationToken.optional(),
  })
  .strict();

export type SendEmailInput = z.output<typeof sendEmailInput>;

export const sendEmailOutput = z.object({
  success: z.literal(true),
  operation: z.literal('gmail.send_email'),
  message_id: z.string(),
  thread_id: z.string(),
  label_ids: z.array(z.string()),
  recipients: z.array(z.string()).describe('To and Cc recipients the message was sent to.'),
  bcc_count: z.number().int(),
  content_type: z.enum(['text/plain', 'text/html']),
  idempotent_replay: z
    .boolean()
    .optional()
    .describe(
      'True when this is the stored result of an earlier call with the same idempotency_key; nothing was re-sent.',
    ),
  request_id: z.string(),
});
