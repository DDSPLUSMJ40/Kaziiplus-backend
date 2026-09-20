const PRINTFUL_BASE_URL = 'https://api.printful.com';

export class PrintfulAuthError extends Error {}

async function printfulRequest(token: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${PRINTFUL_BASE_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init?.headers },
  });
  if (res.status === 401 || res.status === 403) {
    throw new PrintfulAuthError('Printful rejected this token.');
  }
  if (!res.ok) {
    throw new Error(`Printful API error: ${res.status}`);
  }
  return res.json();
}

// A real call, not just a format check -- confirms the token actually
// works against Printful before we ever persist it.
export async function validateToken(token: string): Promise<void> {
  await printfulRequest(token, '/oauth/scopes');
}

// The blank-product catalog (Method B in Printful's Orders API: order
// against a catalog variant_id directly, no Sync Product ever created in
// the creator's Printful store). This endpoint doesn't require auth per
// Printful's docs, but we call it with the token anyway for a higher rate
// limit and consistency.
export async function listCatalog(token: string) {
  const data = await printfulRequest(token, '/products');
  return data.result;
}

export async function getCatalogProduct(token: string, productId: string) {
  const data = await printfulRequest(token, `/products/${productId}`);
  return data.result;
}

// Used to validate a printfulVariantId before it's saved on a Product --
// throws (via printfulRequest's !res.ok check) if the variant doesn't exist.
export async function getVariant(token: string, variantId: number) {
  const data = await printfulRequest(token, `/products/variant/${variantId}`);
  return data.result;
}
