const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PUBLIC_ID = /^[a-z0-9]{32}$/;

export type OriginalKey = Readonly<{
  organizationId: string;
  documentPublicId: string;
  raw: string;
}>;

function assertIds(organizationId: string, documentPublicId: string): void {
  if (!ORG_ID.test(organizationId)) throw new Error("INVALID_ORGANIZATION_ID");
  if (!PUBLIC_ID.test(documentPublicId)) throw new Error("INVALID_DOCUMENT_PUBLIC_ID");
}

/** Identity-addressed originals contain only server-branded identifiers. */
export function mintOriginalKey(organizationId: string, documentPublicId: string): string {
  assertIds(organizationId, documentPublicId);
  const id = documentPublicId.toLowerCase();
  return `org/${organizationId}/original/${id.slice(0, 2)}/${id}`;
}

/** Total parser: malformed or non-mintable keys return null. */
export function parseOriginalKey(raw: string): OriginalKey | null {
  const match = /^org\/([^/]+)\/original\/([^/]+)\/([^/]+)$/.exec(raw);
  if (!match) return null;
  const [, organizationId, shard, documentPublicId] = match;
  if (!organizationId || !shard || !documentPublicId) return null;
  try {
    if (shard !== documentPublicId.slice(0, 2)) return null;
    const canonical = mintOriginalKey(organizationId, documentPublicId);
    return canonical === raw ? { organizationId, documentPublicId, raw } : null;
  } catch { return null; }
}
