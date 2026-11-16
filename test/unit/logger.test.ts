import { describe, it, expect, vi } from 'vitest';
import { PrefixedLogger, scrubArgs } from '../../src/util/logger.js';
import { makeLog } from '../helpers/hapStub.js';

describe('scrubArgs', () => {
  it('keeps every argument, not only the first five', () => {
    expect(scrubArgs(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('redacts password-like keys', () => {
    expect(scrubArgs([{ user: 'u', password: 'p' }])).toEqual([{ user: 'u', password: '[redacted]' }]);
  });
  it('redacts in nested objects', () => {
    expect(scrubArgs([{ a: { token: 't' } }])).toEqual([{ a: { token: '[redacted]' } }]);
  });
  it('redacts keys like apiKey, api_key, secret', () => {
    expect(scrubArgs([{ apiKey: 'x', api_key: 'y', secret: 'z' }]))
      .toEqual([{ apiKey: '[redacted]', api_key: '[redacted]', secret: '[redacted]' }]);
  });
  it('passes primitives through', () => {
    expect(scrubArgs(['hello', 42, true, null, undefined])).toEqual(['hello', 42, true, null, undefined]);
  });
  it('handles arrays', () => {
    expect(scrubArgs([[{ password: 'p' }]])).toEqual([[{ password: '[redacted]' }]]);
  });
  it('caps depth', () => {
    let nested: Record<string, unknown> = { password: 'p' };
    for (let i = 0; i < 10; i++) {
      nested = { nested };
    }
    const out = scrubArgs([nested]);
    expect(JSON.stringify(out)).toContain('depth');
  });
  it('coerces unknown types', () => {
    expect(scrubArgs([Symbol.for('s')])).toEqual([String(Symbol.for('s'))]);
  });
});

describe('PrefixedLogger', () => {
  it('prepends prefix and forwards to underlying log', () => {
    const log = makeLog();
    const p = new PrefixedLogger(log, 'X');
    p.info('hi %s', 'world');
    expect(vi.mocked(log.info)).toHaveBeenCalledWith('[X] hi %s', 'world');
  });

  it('chains child prefixes', () => {
    const log = makeLog();
    const p = new PrefixedLogger(log, 'X').child('Y');
    p.warn('oops');
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith('[X:Y] oops');
  });

  it('routes all levels', () => {
    const log = makeLog();
    const p = new PrefixedLogger(log, 'X');
    p.success('a');
    p.error('b');
    p.debug('c');
    expect(vi.mocked(log.success)).toHaveBeenCalled();
    expect(vi.mocked(log.error)).toHaveBeenCalled();
    expect(vi.mocked(log.debug)).toHaveBeenCalled();
  });

  it('scrubs secrets in args', () => {
    const log = makeLog();
    const p = new PrefixedLogger(log, 'X');
    p.info('payload %o', { password: 'p' });
    expect(vi.mocked(log.info)).toHaveBeenCalledWith('[X] payload %o', { password: '[redacted]' });
  });
});
