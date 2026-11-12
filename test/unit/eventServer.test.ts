import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { Buffer } from 'node:buffer';
import { connect } from 'node:net';
import type { Logging } from 'homebridge';
import { EventServer, describeCall } from '../../src/ccu/EventServer.js';
import { PrefixedLogger } from '../../src/util/logger.js';
import { makeLog } from '../helpers/hapStub.js';

function call(port: number, body: string, method = 'POST'): Promise<{ status: number; body: string; connection?: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      // agent: false → one connection per call, closed afterwards.
      { host: '127.0.0.1', port, method, path: '/', agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          connection: res.headers.connection,
        }));
      },
    );
    req.on('error', reject);
    if (method === 'POST') {
      req.write(body);
    }
    req.end();
  });
}

let server: EventServer;
let port = 0;
let log: Logging;

const debugLines = (): string[] =>
  (log.debug as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c.map(String).join(' '));

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(async () => {
  log = makeLog();
  server = new EventServer({ host: '127.0.0.1', port: 0, log: new PrefixedLogger(log, 'ev') });
  await server.start();
  port = ((server as unknown as { server: { address(): { port: number } } }).server.address()).port;
});

afterEach(async () => {
  await server.stop();
});

describe('EventServer', () => {
  it('answers with Connection: close (one request per connection)', async () => {
    const body = '<methodCall><methodName>system.listMethods</methodName><params></params></methodCall>';
    const res = await call(port, body);
    expect(res.connection).toBe('close');
    expect((await call(port, '', 'GET')).connection).toBe('close');
  });

  it('rejects non-POST', async () => {
    const res = await call(port, '', 'GET');
    expect(res.status).toBe(405);
  });

  it('dispatches event() to event listeners', async () => {
    const handler = vi.fn();
    server.on('event', handler);
    const body = '<methodCall><methodName>event</methodName><params>'
      + '<param><value><string>cb</string></value></param>'
      + '<param><value><string>HmIP.0:1</string></value></param>'
      + '<param><value><string>STATE</string></value></param>'
      + '<param><value><boolean>1</boolean></value></param>'
      + '</params></methodCall>';
    const res = await call(port, body);
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ channelAddress: 'HmIP.0:1', datapoint: 'STATE', value: true }));
  });

  it('handles system.multicall batched events', async () => {
    const handler = vi.fn();
    server.on('event', handler);
    const inner = '<struct>'
      + '<member><name>methodName</name><value><string>event</string></value></member>'
      + '<member><name>params</name><value><array><data>'
      + '<value><string>cb</string></value>'
      + '<value><string>HmIP.0:1</string></value>'
      + '<value><string>STATE</string></value>'
      + '<value><boolean>0</boolean></value>'
      + '</data></array></value></member>'
      + '</struct>';
    const body = '<methodCall><methodName>system.multicall</methodName><params><param><value>'
      + '<array><data>'
      + `<value>${inner}</value>`
      + `<value>${inner}</value>`
      + '</data></array>'
      + '</value></param></params></methodCall>';
    await call(port, body);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('replies to system.listMethods', async () => {
    const body = '<methodCall><methodName>system.listMethods</methodName><params></params></methodCall>';
    const res = await call(port, body);
    expect(res.body).toContain('event');
    expect(res.body).toContain('system.multicall');
  });

  it('replies to listDevices with empty array', async () => {
    const body = '<methodCall><methodName>listDevices</methodName><params></params></methodCall>';
    const res = await call(port, body);
    expect(res.body).toContain('<array>');
  });

  it('emits newDevices', async () => {
    const handler = vi.fn();
    server.on('newDevices', handler);
    const body = '<methodCall><methodName>newDevices</methodName><params>'
      + '<param><value><string>cb</string></value></param>'
      + '</params></methodCall>';
    await call(port, body);
    expect(handler).toHaveBeenCalledWith('cb');
  });

  it('returns fault on malformed XML', async () => {
    const res = await call(port, 'not xml');
    expect(res.status).toBe(200);
    expect(res.body).toContain('faultCode');
  });

  it('returns "" for unknown methods', async () => {
    const body = '<methodCall><methodName>unknown.method</methodName><params></params></methodCall>';
    const res = await call(port, body);
    expect(res.status).toBe(200);
    expect(res.body).toContain('<string></string>');
  });

  it('skips multicall entries with no methodName', async () => {
    const handler = vi.fn();
    server.on('event', handler);
    const goodInner = '<struct>'
      + '<member><name>methodName</name><value><string>event</string></value></member>'
      + '<member><name>params</name><value><array><data>'
      + '<value><string>cb</string></value>'
      + '<value><string>X.0:1</string></value>'
      + '<value><string>STATE</string></value>'
      + '<value><boolean>1</boolean></value>'
      + '</data></array></value></member>'
      + '</struct>';
    const badInner = '<struct><member><name>params</name><value><array><data></data></array></value></member></struct>';
    const body = '<methodCall><methodName>system.multicall</methodName><params><param><value>'
      + '<array><data>'
      + `<value>${badInner}</value>`
      + `<value>${goodInner}</value>`
      + '</data></array></value></param></params></methodCall>';
    await call(port, body);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('debug-logs connections and calls', async () => {
    const body = '<methodCall><methodName>event</methodName><params>'
      + '<param><value><string>cb</string></value></param>'
      + '<param><value><string>X:1</string></value></param>'
      + '<param><value><string>STATE</string></value></param>'
      + '<param><value><boolean>1</boolean></value></param>'
      + '</params></methodCall>';
    await call(port, body);
    await until(() => debugLines().some((l) => l.includes('closed after')));
    const lines = debugLines();
    expect(lines.some((l) => /connection #%d from/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes('event(cb) X:1.STATE=true'))).toBe(true);
    expect(lines.some((l) => l.includes('closed after') && l.includes(' 1 '))).toBe(true);
  });

  it('debug-logs a response the CCU never received', async () => {
    // Send a request and close the socket before the body is complete.
    const sock = connect(port, '127.0.0.1');
    await new Promise<void>((r) => sock.once('connect', () => r()));
    sock.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n<method');
    await until(() => debugLines().some((l) => l.includes('from')));
    sock.destroy();
    await until(() => debugLines().some((l) => l.includes('not delivered')));
    expect(debugLines().some((l) => l.includes('not delivered'))).toBe(true);
  });
});

describe('describeCall', () => {
  it('summarizes event, multicall and other calls', () => {
    expect(describeCall('event', ['cb', 'A:1', 'LEVEL', 0.5])).toBe('event(cb) A:1.LEVEL=0.5');
    expect(describeCall('event', ['cb', 'A:1', 'X', { a: 'x'.repeat(50) }])).toMatch(/…$/);
    const calls = Array.from({ length: 7 }, (_, i) => ({ methodName: 'event', params: ['cb', `A:${i}`, 'STATE', true] }));
    const s = describeCall('system.multicall', [calls]);
    expect(s).toMatch(/^system\.multicall\[7\] event\(cb\) A:0\.STATE=true/);
    expect(s).toContain('… 2 more');
    expect(describeCall('system.multicall', [[{ }]])).toBe('system.multicall[1] ?');
    expect(describeCall('system.multicall', ['x'])).toBe('system.multicall[0] ');
    expect(describeCall('listDevices', ['cb'])).toBe('listDevices(cb)');
    expect(describeCall('system.listMethods', [])).toBe('system.listMethods');
  });
});
