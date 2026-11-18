import { describe, it, expect } from 'vitest';
import { parseXml, serializeFault, serializeResponse } from '../../src/ccu/xmlRpc.js';

describe('parseXml', () => {
  it('parses a simple methodCall with int + string + bool', () => {
    const body = `<?xml version="1.0"?>
<methodCall><methodName>event</methodName>
  <params>
    <param><value><string>cb-id</string></value></param>
    <param><value><string>HmIP.0:1</string></value></param>
    <param><value><string>STATE</string></value></param>
    <param><value><boolean>1</boolean></value></param>
  </params>
</methodCall>`;
    const r = parseXml(body);
    expect(r.method).toBe('event');
    expect(r.params).toEqual(['cb-id', 'HmIP.0:1', 'STATE', true]);
  });

  it('parses int and i4 as integers, double as float', () => {
    const body =
      '<methodCall><methodName>m</methodName><params>' +
      '<param><value><int>42</int></value></param>' +
      '<param><value><i4>43</i4></value></param>' +
      '<param><value><double>1.5</double></value></param>' +
      '</params></methodCall>';
    expect(parseXml(body).params).toEqual([42, 43, 1.5]);
  });

  it('parses arrays', () => {
    const body =
      '<methodCall><methodName>m</methodName><params><param><value>' +
      '<array><data>' +
      '<value><int>1</int></value>' +
      '<value><int>2</int></value>' +
      '</data></array>' +
      '</value></param></params></methodCall>';
    expect(parseXml(body).params).toEqual([[1, 2]]);
  });

  it('parses structs', () => {
    const body =
      '<methodCall><methodName>m</methodName><params><param><value>' +
      '<struct>' +
      '<member><name>a</name><value><int>1</int></value></member>' +
      '<member><name>b</name><value><string>x</string></value></member>' +
      '</struct>' +
      '</value></param></params></methodCall>';
    expect(parseXml(body).params).toEqual([{ a: 1, b: 'x' }]);
  });

  it('decodes entities', () => {
    const body =
      '<methodCall><methodName>m</methodName><params><param><value>' +
      '<string>&amp; &lt; &gt; &quot; &apos; &#65; &#x42;</string>' +
      '</value></param></params></methodCall>';
    expect(parseXml(body).params).toEqual(['& < > " \' A B']);
  });

  it('rejects DOCTYPE (XXE attack vector)', () => {
    const body =
      '<?xml version="1.0"?><!DOCTYPE foo SYSTEM "file:///etc/passwd"><methodCall><methodName>m</methodName></methodCall>';
    expect(() => parseXml(body)).toThrow(/DOCTYPE/i);
  });

  it('parses base64 to Buffer', () => {
    const body =
      '<methodCall><methodName>m</methodName><params><param><value><base64>aGVsbG8=</base64></value></param></params></methodCall>';
    const r = parseXml(body);
    expect(Buffer.isBuffer(r.params[0])).toBe(true);
    expect((r.params[0] as Buffer).toString('utf8')).toBe('hello');
  });

  it('parses nil', () => {
    const body =
      '<methodCall><methodName>m</methodName><params><param><value><nil/></value></param></params></methodCall>';
    expect(parseXml(body).params).toEqual([null]);
  });

  it('parses dateTime', () => {
    const body =
      '<methodCall><methodName>m</methodName><params><param><value><dateTime.iso8601>2026-05-02T10:00:00</dateTime.iso8601></value></param></params></methodCall>';
    expect(parseXml(body).params).toEqual(['2026-05-02T10:00:00']);
  });

  it('rejects unknown value types', () => {
    const body =
      '<methodCall><methodName>m</methodName><params><param><value><wat>1</wat></value></param></params></methodCall>';
    expect(() => parseXml(body)).toThrow(/Unsupported/);
  });

  it('handles empty value', () => {
    const body =
      '<methodCall><methodName>m</methodName><params><param><value></value></param></params></methodCall>';
    expect(parseXml(body).params).toEqual(['']);
  });

  it('skips comments and xml declaration', () => {
    const body =
      '<?xml version="1.0"?><!-- hi --><methodCall><methodName>m</methodName></methodCall>';
    expect(parseXml(body).method).toBe('m');
  });
});

describe('serializeResponse / serializeFault', () => {
  it('serializes int, double, string, bool', () => {
    expect(serializeResponse(42)).toContain('<i4>42</i4>');
    expect(serializeResponse(3.14)).toContain('<double>3.14</double>');
    expect(serializeResponse('x')).toContain('<string>x</string>');
    expect(serializeResponse(true)).toContain('<boolean>1</boolean>');
    expect(serializeResponse(false)).toContain('<boolean>0</boolean>');
  });

  it('serializes nil', () => {
    expect(serializeResponse(null)).toContain('<nil/>');
    expect(serializeResponse(undefined)).toContain('<nil/>');
  });

  it('serializes arrays and structs', () => {
    expect(serializeResponse([1, 'x'])).toContain('<array>');
    expect(serializeResponse({ a: 1 })).toContain('<struct>');
  });

  it('escapes XML entities in strings and struct keys', () => {
    expect(serializeResponse('<&>')).toContain('&lt;&amp;&gt;');
    expect(serializeResponse({ '<bad>': 1 })).toContain('&lt;bad&gt;');
  });

  it('serializes Buffer as base64', () => {
    expect(serializeResponse(Buffer.from('hi'))).toContain('<base64>aGk=</base64>');
  });

  it('serializeFault wraps fault values', () => {
    expect(serializeFault(-1, 'boom')).toContain('faultCode');
    expect(serializeFault(-1, 'boom')).toContain('boom');
  });
});

describe('parseXml round-trip', () => {
  it('survives serialize -> parse -> dispatch shape', () => {
    // Build an event call manually since serializeResponse is for replies.
    const xml = `<methodCall><methodName>event</methodName><params>
      <param>${'<value><string>cb</string></value>'}</param>
      <param>${'<value><string>addr</string></value>'}</param>
      <param>${'<value><string>STATE</string></value>'}</param>
      <param>${'<value><boolean>0</boolean></value>'}</param>
    </params></methodCall>`;
    const r = parseXml(xml);
    expect(r.method).toBe('event');
    expect(r.params[3]).toBe(false);
  });
});
