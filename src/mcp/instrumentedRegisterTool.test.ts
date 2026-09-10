import { beforeEach, describe, expect, it, vi } from 'vitest';

// instrumentedRegisterTool pakker inn *alle* MCP-tools (34 stk) med metrikker.
// En feil her påvirker instrumentering for hele verktøyflaten, så vi mocker
// metrics.js og verifiserer at wrapperen teller riktig og aldri svelger feil.
const incMock = vi.fn();
const startTimerMock = vi.fn();
const endTimerMock = vi.fn();

vi.mock('../metrics.js', () => ({
  mcpRequestsTotal: { inc: (labels: unknown) => incMock('requests', labels) },
  mcpErrorsTotal: { inc: (labels: unknown) => incMock('errors', labels) },
  mcpRequestDuration: {
    startTimer: (labels: unknown) => {
      startTimerMock(labels);
      return endTimerMock;
    },
  },
}));

const { instrumentedRegisterTool } = await import('./instrumentedRegisterTool.js');

function fakeServer() {
  let registeredHandler: ((args: unknown) => Promise<unknown>) | undefined;
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerTool: (_name: string, _config: unknown, handler: any) => {
      registeredHandler = handler;
    },
    invoke: (args: unknown = {}) => registeredHandler!(args),
  };
}

describe('instrumentedRegisterTool', () => {
  beforeEach(() => {
    incMock.mockClear();
    startTimerMock.mockClear();
    endTimerMock.mockClear();
  });

  it('teller vellykkede kall og stopper timeren nøyaktig én gang', async () => {
    const server = fakeServer();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    instrumentedRegisterTool(server as any, 'mitt_tool', {}, async () => ({ content: [] }));

    await server.invoke();

    expect(startTimerMock).toHaveBeenCalledWith({ tool: 'mitt_tool' });
    expect(endTimerMock).toHaveBeenCalledTimes(1);
    expect(incMock).toHaveBeenCalledWith('requests', { tool: 'mitt_tool', status: 'ok' });
    expect(incMock).not.toHaveBeenCalledWith('errors', expect.anything());
  });

  it('teller isError-resultat som feil, uten å kaste videre', async () => {
    const server = fakeServer();
    instrumentedRegisterTool(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      server as any,
      'mitt_tool',
      {},
      async () => ({ content: [], isError: true }),
    );

    const result = await server.invoke();

    expect(result).toEqual({ content: [], isError: true });
    expect(incMock).toHaveBeenCalledWith('requests', { tool: 'mitt_tool', status: 'error' });
    expect(incMock).toHaveBeenCalledWith('errors', { tool: 'mitt_tool', error_type: 'ToolError' });
  });

  it('teller kastede feil med error.name og rekaster dem videre uendret', async () => {
    const server = fakeServer();
    instrumentedRegisterTool(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      server as any,
      'mitt_tool',
      {},
      async () => {
        throw new TypeError('noe gikk galt');
      },
    );

    await expect(server.invoke()).rejects.toThrow('noe gikk galt');
    expect(incMock).toHaveBeenCalledWith('requests', { tool: 'mitt_tool', status: 'error' });
    expect(incMock).toHaveBeenCalledWith('errors', { tool: 'mitt_tool', error_type: 'TypeError' });
    expect(endTimerMock).toHaveBeenCalledTimes(1);
  });
});
