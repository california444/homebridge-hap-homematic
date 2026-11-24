/**
 * Unit tests must never reach a real CCU or a CCU mock running on this
 * machine. Many tests build a real CcuClient on 127.0.0.1 and replace its
 * calls with spies; a call that slips past them (a new code path, a
 * missing spy) would otherwise go to the CCU's XML-RPC ports and change
 * devices there. Such a connection is sent to a closed port instead
 * (ECONNREFUSED, as without a CCU) and fails the test.
 */
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { afterEach, expect } from 'vitest';

const require = createRequire(import.meta.url);
const net = require('node:net') as typeof import('node:net');
const http = require('node:http') as typeof import('node:http');
const https = require('node:https') as typeof import('node:https');

/** XML-RPC ports of the CCU interfaces, plain and TLS. */
const CCU_PORTS = new Set([2000, 2001, 2010, 9292, 8701, 42000, 42001, 42010, 49292]);
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);
const CLOSED_PORT = 1;

const leaks: string[] = [];

function guard(host: unknown, port: unknown): number | undefined {
  const p = Number(port);
  if (!CCU_PORTS.has(p) || !LOCAL_HOSTS.has(String(host ?? 'localhost'))) {
    return undefined;
  }
  leaks.push(`${String(host)}:${p}`);
  return CLOSED_PORT;
}

type AnyFn = (...args: unknown[]) => unknown;

function wrapConnect(original: AnyFn): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    const [first] = args;
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      const o = first as { host?: string; port?: number };
      const to = guard(o.host, o.port);
      if (to !== undefined) args[0] = { ...o, port: to };
    } else if (typeof first === 'number' || typeof first === 'string') {
      const to = guard(args[1], first);
      if (to !== undefined) args[0] = to;
    }
    return original.apply(this, args);
  };
}

function wrapRequest(original: AnyFn): AnyFn {
  return function (this: unknown, ...args: unknown[]) {
    const [first] = args;
    if (first && typeof first === 'object' && !(first instanceof URL)) {
      const o = first as { host?: string; hostname?: string; port?: number | string };
      const to = guard(o.hostname ?? o.host, o.port);
      if (to !== undefined) args[0] = { ...o, port: to };
    }
    return original.apply(this, args);
  };
}

net.createConnection = wrapConnect(net.createConnection as AnyFn) as typeof net.createConnection;
net.connect = wrapConnect(net.connect as AnyFn) as typeof net.connect;
http.request = wrapRequest(http.request as AnyFn) as typeof http.request;
https.request = wrapRequest(https.request as AnyFn) as typeof https.request;
// ESM imports of the builtins (`import { createConnection } from 'node:net'`).
syncBuiltinESMExports();

afterEach(() => {
  const found = leaks.splice(0);
  expect(found, `test reached a CCU port: ${found.join(', ')}`).toEqual([]);
});
