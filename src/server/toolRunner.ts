import { randomBytes } from 'node:crypto';
import {
  isInputRequiredResult,
  type CallToolResult,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import type * as z from 'zod';
import { resolveUserContext, type UserContext } from '../auth/userContext.js';
import { toAppError, toErrorResult } from '../errors/appError.js';
import type { Logger } from '../utils/logging.js';
import type { ServerDeps } from './deps.js';

export interface ToolContext {
  requestId: string;
  user: UserContext;
  logger: Logger;
  ctx: ServerContext;
  deps: ServerDeps;
  /** Capabilities the connected client declared at initialization (legacy-era sessions). */
  clientCapabilities: Record<string, unknown> | undefined;
}

export type ToolOutput = Record<string, unknown>;

export interface ToolDefinition<Input extends z.ZodObject = z.ZodObject> {
  /** Canonical, dotted name from the specification, e.g. `gmail.send_email`. */
  name: string;
  title: string;
  description: string;
  inputSchema: Input;
  outputSchema: z.ZodObject;
  annotations: ToolAnnotations;
  handler: (args: z.output<Input>, tc: ToolContext) => Promise<ToolOutput | InputRequiredResult>;
}

/** The wire name: dotted as in the spec, or underscored for hosts whose function-calling rejects dots. */
export function wireToolName(name: string, style: 'dotted' | 'underscore'): string {
  return style === 'dotted' ? name : name.replace(/\./g, '_');
}

export const newRequestId = () => `req_${randomBytes(9).toString('base64url')}`;

/**
 * Registers a tool with uniform cross-cutting behaviour: request IDs,
 * identity resolution, structured success/error results, logging and metrics.
 */
export function registerTool<Input extends z.ZodObject>(
  server: McpServer,
  def: ToolDefinition<Input>,
  deps: ServerDeps,
): void {
  const wireName = wireToolName(def.name, deps.config.toolNameStyle);

  const run = async (
    args: z.output<Input>,
    ctx: ServerContext,
  ): Promise<CallToolResult | InputRequiredResult> => {
    const requestId = newRequestId();
    const started = performance.now();
    const logger = deps.logger.child({ request_id: requestId, tool: def.name });
    let userId: string | undefined;
    try {
      const user = resolveUserContext(deps.mode, deps.config.defaultUserId, ctx.http?.authInfo);
      userId = user.userId;
      const output = await def.handler(args, {
        requestId,
        user,
        logger: logger.child({ user_id: user.userId }),
        ctx,
        deps,
        clientCapabilities: server.server.getClientCapabilities() as Record<string, unknown> | undefined,
      });
      const duration = performance.now() - started;
      if (isInputRequiredResult(output)) {
        logger.info('tool call awaiting user input', { user_id: userId, duration_ms: Math.round(duration) });
        deps.metrics.inc('mcp_tool_calls_total', { tool: def.name, status: 'input_required' });
        return output;
      }
      const payload = { ...output, request_id: requestId };
      logger.info('tool call completed', {
        user_id: userId,
        duration_ms: Math.round(duration),
        success: true,
      });
      deps.metrics.inc('mcp_tool_calls_total', { tool: def.name, status: 'success' });
      deps.metrics.observe('mcp_tool_latency_ms', duration, { tool: def.name });
      return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload };
    } catch (err) {
      const appErr = toAppError(err);
      const duration = performance.now() - started;
      const fields = {
        user_id: userId,
        duration_ms: Math.round(duration),
        success: false,
        error_code: appErr.code,
        // Internal diagnostics only; never sent to the client.
        error: appErr.code === 'INTERNAL_ERROR' ? (appErr.cause ?? err) : appErr.message,
      };
      if (appErr.code === 'INTERNAL_ERROR') logger.error('tool call failed', fields);
      else logger.warn('tool call failed', fields);
      deps.metrics.inc('mcp_tool_calls_total', { tool: def.name, status: 'error' });
      deps.metrics.inc('mcp_tool_errors_total', { tool: def.name, error_code: appErr.code });
      deps.metrics.observe('mcp_tool_latency_ms', duration, { tool: def.name });
      return toErrorResult(appErr, def.name, requestId);
    }
  };

  server.registerTool(
    wireName,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      outputSchema: def.outputSchema,
      annotations: { title: def.title, ...def.annotations },
    },
    run as never,
  );
}
