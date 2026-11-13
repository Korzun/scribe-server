/**
 * Everything the vault reads from its environment, resolved once at boot by
 * `loadConfig`. The setup code is deliberately NOT a field here: it must be
 * read live from `options.json` on every attempt (`readSetupCode`), so
 * holding it in a boot-time snapshot would defeat that.
 */
export interface AppConfig {
  /** Directory holding `options.json` and the SQLite database. */
  dataDir: string;
  /** Where encrypted blobs live: `BLOBS_DIR`, else `/media/<library_dir>/blobs` under the add-on, else `<dataDir>/blobs`. */
  blobsDir: string;
  port: number;
  /**
   * Absolute origin this instance is reachable at, or `null`. Never derived
   * from a request header: a `Host`-derived origin is a poisoning vector.
   */
  publicUrl: string | null;
  /**
   * How many reverse-proxy hops to trust for `X-Forwarded-For`. `0` (trust
   * nothing) is the safe default; any malformed value fails toward it so a
   * typo can never open the rate limiter up to header spoofing.
   */
  trustProxyHops: number;
  logLevel: string;
}
