import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  mcpRequestsTotal,
  mcpRequestDuration,
  mcpErrorsTotal,
} from '../metrics.js';

/**
 * Wrapper rundt server.registerTool som instrumenterer tool-kall med
 * Prometheus-metrikker (antall, responstid, feil) uten å endre
 * eksisterende tool-kode. Typen er bevisst generisk — den faktiske
 * handler-signaturen settes av MCP SDK ved registrering.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function instrumentedRegisterTool(
  server: McpServer,
  name: string,
  config: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => Promise<any>,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const instrumentedHandler = async (args: any): Promise<any> => {
    const end = mcpRequestDuration.startTimer({ tool: name });
    let status: 'ok' | 'error' = 'ok';
    let errorType: string | undefined;
    try {
      const result = await handler(args);
      if (
        result &&
        typeof result === 'object' &&
        'isError' in result &&
        (result as { isError?: unknown }).isError === true
      ) {
        status = 'error';
        errorType = 'ToolError';
      }
      return result;
    } catch (error) {
      status = 'error';
      errorType = error instanceof Error ? error.name : 'UnknownError';
      throw error;
    } finally {
      mcpRequestsTotal.inc({ tool: name, status });
      if (status === 'error') {
        mcpErrorsTotal.inc({ tool: name, error_type: errorType ?? 'UnknownError' });
      }
      end();
    }
  };

  server.registerTool(name, config as Parameters<McpServer['registerTool']>[1], instrumentedHandler);
}
