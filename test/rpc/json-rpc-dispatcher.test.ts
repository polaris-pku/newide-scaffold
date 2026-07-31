import { describe, expect, it } from 'vitest';
import { JsonRpcDispatcher, JsonRpcLineSession } from '../../src/rpc/json-rpc-dispatcher';

describe('JsonRpcLineSession', () => {
  it('does not embed application methods in the transport dispatcher', async () => {
    const output: string[] = [];
    const session = new JsonRpcLineSession(new JsonRpcDispatcher(), (line) => output.push(line));

    await session.handleLine('{"jsonrpc":"2.0","id":1,"method":"system.ping"}');

    expect(output.map((line) => JSON.parse(line))).toEqual([
      {
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32601, message: 'Method not found' },
      },
    ]);
  });

  it('returns method not found and internal errors without plain-text output', async () => {
    const output: string[] = [];
    const dispatcher = new JsonRpcDispatcher();
    dispatcher.register('test.fail', () => {
      throw new Error('sensitive detail');
    });
    const session = new JsonRpcLineSession(dispatcher, (line) => output.push(line));

    await session.handleLine('{"jsonrpc":"2.0","id":2,"method":"missing"}');
    await session.handleLine('{"jsonrpc":"2.0","id":3,"method":"test.fail"}');

    expect(output.every((line) => line.startsWith('{'))).toBe(true);
    expect(output.map((line) => JSON.parse(line))).toMatchObject([
      { id: 2, error: { code: -32601, message: 'Method not found' } },
      { id: 3, error: { code: -32603, message: 'Internal error' } },
    ]);
  });

  it('does not respond to client notifications and can emit server notifications', async () => {
    const output: string[] = [];
    const dispatcher = new JsonRpcDispatcher();
    dispatcher.register('test.notify', () => ({ accepted: true }));
    const session = new JsonRpcLineSession(dispatcher, (line) => output.push(line));

    await session.handleLine('{"jsonrpc":"2.0","method":"test.notify","params":{}}');
    session.sendNotification('run.event', { run_id: 'run_1', sequence: 1 });

    expect(output.map((line) => JSON.parse(line))).toEqual([
      {
        jsonrpc: '2.0',
        method: 'run.event',
        params: { run_id: 'run_1', sequence: 1 },
      },
    ]);
  });
});
