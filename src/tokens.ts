export interface CachedAccessToken {
  token: string;
  audience: string;
  tenantId: string | null;
  expiresAt: number;
  permissions: string[];
  storage: string;
}

interface TokenClaims {
  aud: string;
  exp: number;
  tid?: string;
  permissions: string[];
}

// Read access tokens only. MSAL account, ID token, and refresh token entries are excluded.
export function listMsalAccessTokens(decode: (token: string) => TokenClaims | null): CachedAccessToken[] {
  const found: CachedAccessToken[] = [];
  const seen = new Set<string>();
  for (const [storageName, getStorage] of [
    ['Session storage', () => sessionStorage], ['Local storage', () => localStorage]
  ] as const) {
    let storage: Storage;
    try { storage = getStorage(); } catch { continue; }
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key || !/(msal|accesstoken|access_token)/i.test(key)) continue;
      let raw: string | null;
      try { raw = storage.getItem(key); } catch { continue; }
      if (!raw) continue;
      let candidates: string[] = [];
      try {
        const entry = JSON.parse(raw);
        const credentialType = String(entry?.credentialType || '').toLowerCase();
        if (credentialType && !credentialType.startsWith('accesstoken')) continue;
        candidates = [entry?.accessToken, entry?.secret, entry?.token, entry?.credential]
          .filter((value): value is string => typeof value === 'string');
      } catch {
        if (/(accesstoken|access_token)/i.test(key)) candidates = [raw];
      }
      for (const token of candidates) {
        if (seen.has(token) || token.split('.').length !== 3) continue;
        const claims = decode(token);
        if (!claims?.aud || !Number.isFinite(claims.exp) || claims.exp <= 0) continue;
        seen.add(token);
        found.push({ token, audience: claims.aud, tenantId: claims.tid || null,
          expiresAt: claims.exp, permissions: claims.permissions, storage: storageName });
      }
    }
  }
  return found.sort((a, b) => b.expiresAt - a.expiresAt);
}
