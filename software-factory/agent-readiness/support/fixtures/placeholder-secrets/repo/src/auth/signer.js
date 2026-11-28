// tests/secrets.test.ts writes a generated key in place of the marker, as a key committed to shipped code.
export const defaultKey = `__PRIVATE_KEY__`;

export function signer(key = defaultKey) {
  return (payload) => `${key.length}:${JSON.stringify(payload)}`;
}
