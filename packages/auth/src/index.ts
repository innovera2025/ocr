import { createHmac, timingSafeEqual } from "node:crypto";

export * from "./password.js";
export * from "./session.js";

export type Principal = Readonly<{ userId: string; tenantId: string; claims: Readonly<Record<string, unknown>> }>;
export type JwtPolicy = Readonly<{ issuer?: string; audience?: string }>;

export class AuthenticationError extends Error {
  constructor(message = "UNAUTHENTICATED") { super(message); this.name = "AuthenticationError"; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const decode = (value: string): string => Buffer.from(value, "base64url").toString("utf8");

export function authenticateBearer(header: string | undefined, secret: string | readonly string[], policy: JwtPolicy = {}): Principal {
  const secrets = typeof secret === "string" ? [secret] : secret;
  if (secrets.length === 0 || secrets.some((value) => !value)) throw new AuthenticationError("AUTH_NOT_CONFIGURED");
  if (!header?.startsWith("Bearer ")) throw new AuthenticationError();
  const token = header.slice(7);
  const parts = token.split(".");
  if (parts.length !== 3) throw new AuthenticationError("INVALID_TOKEN");
  const [encodedHeader, encodedPayload, signature] = parts;
  try {
    const headerValue = JSON.parse(decode(encodedHeader!)) as { alg?: string; typ?: string };
    const claims = JSON.parse(decode(encodedPayload!)) as Record<string, unknown>;
    if (headerValue.alg !== "HS256" || headerValue.typ !== "JWT") throw new AuthenticationError("INVALID_TOKEN");
    const actual = Buffer.from(signature!, "base64url");
    const validSignature = secrets.some((key) => {
      const expected = createHmac("sha256", key).update(`${encodedHeader}.${encodedPayload}`).digest();
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    });
    if (!validSignature) throw new AuthenticationError("INVALID_TOKEN");
    if (typeof claims.exp === "number" && claims.exp <= Math.floor(Date.now() / 1000)) throw new AuthenticationError("TOKEN_EXPIRED");
    if (policy.issuer && claims.iss !== policy.issuer) throw new AuthenticationError("INVALID_ISSUER");
    if (policy.audience && !((typeof claims.aud === "string" && claims.aud === policy.audience) || (Array.isArray(claims.aud) && claims.aud.includes(policy.audience)))) throw new AuthenticationError("INVALID_AUDIENCE");
    const userId = typeof claims.sub === "string" ? claims.sub : "";
    const tenantId = typeof claims.organization_id === "string" ? claims.organization_id : typeof claims.tenant_id === "string" ? claims.tenant_id : "";
    if (!UUID.test(userId) || !UUID.test(tenantId)) throw new AuthenticationError("INVALID_PRINCIPAL");
    return Object.freeze({ userId, tenantId, claims: Object.freeze(claims) });
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;
    throw new AuthenticationError("INVALID_TOKEN");
  }
}
