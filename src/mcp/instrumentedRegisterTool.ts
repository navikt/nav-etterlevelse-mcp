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
    try {
      const result = await handler(args);
      mcpRequestsTotal.inc({ tool: name, status: 'ok' });
      return result;
    } catch (error) {
      mcpRequestsTotal.inc({ tool: name, status: 'error' });
      const errorType = error instanceof Error ? error.name : 'UnknownError';
      mcpErrorsTotal.inc({ tool: name, error_type: errorType });
      throw error;
    } finally {
      end();
    }
  };

  server.registerTool(name, config as Parameters<McpServer['registerTool']>[1], instrumentedHandler);
}
