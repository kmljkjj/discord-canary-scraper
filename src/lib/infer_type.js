/**
 * Shared experiment type inference.
 *
 * Used by extract.js and mobile_from_files.js to classify an experiment as
 * guild-scoped or user-scoped based on its ID string.
 *
 * @param {string|number} id - experiment ID
 * @returns {'guild'|'user'}
 */
function inferType(id) {
  const s = String(id || '').toLowerCase();
  if (/guild|server|role|channel_list|community|moderat|automod|raid/.test(s))
    return 'guild';
  return 'user';
}

module.exports = { inferType };
