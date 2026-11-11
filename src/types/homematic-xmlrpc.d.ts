// Modified by california444 (2026) for homebridge-hap-homematic,
// a hard fork of Homebridge-Homematic-HAP (Apache-2.0). See NOTICE.
declare module 'homematic-xmlrpc' {
  interface XmlRpcClient {
    methodCall(
      method: string,
      params: unknown[],
      callback: (err: Error | null, value: unknown) => void,
    ): void;
  }

  interface CreateClientOptions {
    host: string;
    port: number;
    path?: string;
    rejectUnauthorized?: boolean;
    basic_auth?: { user: string; pass: string };
  }

  export function createClient(opts: CreateClientOptions): XmlRpcClient;
  export function createSecureClient(opts: CreateClientOptions): XmlRpcClient;
}
