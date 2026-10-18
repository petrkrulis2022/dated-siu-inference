/**
 * The trial's OAuth state for the live Blockworks MCP (D91): the client the server registered for us, our tokens, the PKCE verifier and the state of a login in progress, kept as small files
 * under the private directory (mode 0600, the directory 0700), never committed and never printed. The MCP SDK drives the flow (discovery, dynamic client registration, PKCE, token exchange,
 * refresh); this class only stores what it asks to be stored and says where the user must go to sign in. The Blockworks API key is typed by the owner into Blockworks' own sign-in page in a
 * browser and never reaches this code: what comes back is an OAuth token.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { pathWithin, privatePath } from "../paths.js";

export const DEFAULT_LOGIN_PORT = 8976;

export interface TrialOAuthOptions {
  /** the redirect URL registered with the server, `http://127.0.0.1:<port>/callback` */
  redirectUrl: string;
  /** where state is kept; defaults to the trial's private OAuth directory */
  dir?: string;
  /** called with the URL the owner must open to sign in */
  onRedirect?: (url: URL) => void | Promise<void>;
}

export class TrialOAuthProvider implements OAuthClientProvider {
  readonly #dir: string;
  readonly #redirectUrl: string;
  readonly #onRedirect: (url: URL) => void | Promise<void>;

  constructor(opts: TrialOAuthOptions) {
    this.#dir = opts.dir ?? privatePath("mcp-oauth");
    this.#redirectUrl = opts.redirectUrl;
    this.#onRedirect = opts.onRedirect ?? (() => undefined);
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
  }

  #file(name: string): string {
    return pathWithin(this.#dir, name);
  }
  #read<T>(name: string): T | undefined {
    const f = this.#file(name);
    if (!existsSync(f)) return undefined;
    try {
      return JSON.parse(readFileSync(f, "utf-8")) as T;
    } catch {
      return undefined;
    }
  }
  #write(name: string, value: unknown): void {
    const f = this.#file(name);
    writeFileSync(f, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    chmodSync(f, 0o600);
  }

  get redirectUrl(): string {
    return this.#redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Touchstone Assay trial harness",
      redirect_uris: [this.#redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  /** a fresh `state` for one login, remembered so the callback can be checked against it */
  state(): string {
    const s = randomBytes(24).toString("hex");
    this.#write("state.json", { state: s });
    return s;
  }
  expectedState(): string | undefined {
    return this.#read<{ state: string }>("state.json")?.state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const info = this.#read<OAuthClientInformationMixed & { redirect_uris?: string[] }>(
      "client.json",
    );
    // a registration made for a different redirect URL cannot be used with this one
    if (info?.redirect_uris !== undefined && !info.redirect_uris.includes(this.#redirectUrl))
      return undefined;
    return info;
  }
  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.#write("client.json", info);
  }

  tokens(): OAuthTokens | undefined {
    return this.#read<OAuthTokens>("tokens.json");
  }
  saveTokens(tokens: OAuthTokens): void {
    this.#write("tokens.json", tokens);
  }

  saveCodeVerifier(verifier: string): void {
    this.#write("verifier.json", { verifier });
  }
  codeVerifier(): string {
    const v = this.#read<{ verifier: string }>("verifier.json")?.verifier;
    if (v === undefined) throw new Error("no PKCE verifier saved: start the login again");
    return v;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    await this.#onRedirect(url);
  }

  /** Forget the tokens (a sign-out), keeping the registered client. */
  clearTokens(): void {
    rmSync(this.#file("tokens.json"), { force: true });
  }

  /** What is stored, as booleans: safe to print. */
  describe(): { registered: boolean; signedIn: boolean; hasRefreshToken: boolean } {
    const t = this.tokens();
    return {
      registered: this.clientInformation() !== undefined,
      signedIn: t?.access_token !== undefined,
      hasRefreshToken: t?.refresh_token !== undefined,
    };
  }

  toString(): string {
    return "[TrialOAuthProvider]";
  }
  toJSON(): string {
    return "[TrialOAuthProvider]";
  }
}
