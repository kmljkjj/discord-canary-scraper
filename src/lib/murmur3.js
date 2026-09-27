/**
 * Shared MurmurHash3 (x86 32-bit) implementation.
 *
 * Used by apex_rollouts.js and user_rollouts.js to map experiment IDs to
 * buckets deterministically. Keeping a single copy here avoids drift between
 * the two consumers.
 *
 * @param {string|number} key - the key to hash
 * @param {number} [seed=0] - 32-bit seed
 * @returns {number} unsigned 32-bit hash
 */
function murmur3(key, seed = 0) {
  let h1 = seed >>> 0;
  const c1 = 0xcc9e2d51,
    c2 = 0x1b873593;
  const bytes = Buffer.from(String(key), 'utf8');
  const len = bytes.length,
    nblocks = len >> 2;
  for (let i = 0; i < nblocks; i++) {
    let k1 =
      bytes[i * 4] | (bytes[i * 4 + 1] << 8) | (bytes[i * 4 + 2] << 16) | (bytes[i * 4 + 3] << 24);
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = (Math.imul(h1, 5) + 0xe6546b64) >>> 0;
  }
  let k1 = 0,
    off = nblocks * 4,
    tail = len & 3;
  if (tail === 3) k1 ^= bytes[off + 2] << 16;
  if (tail >= 2) k1 ^= bytes[off + 1] << 8;
  if (tail >= 1) {
    k1 ^= bytes[off];
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
  }
  h1 ^= len;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;
  return h1 >>> 0;
}

module.exports = { murmur3 };
