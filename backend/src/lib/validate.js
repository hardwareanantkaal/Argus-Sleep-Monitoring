const { z } = require('zod');
const { E } = require('../errors');

// Parse `data` with a zod schema; on failure throw 400 VALIDATION with the
// first bad field, e.g. {code:"VALIDATION", field:"phone", message:"..."}.
function parse(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw E.bad('VALIDATION', issue.message, issue.path.join('.') || undefined);
}

// Shared field rules (same limits as the database CHECKs).
const f = {
  phone: z.string().trim().regex(/^\+[1-9][0-9]{7,14}$/, 'Phone must be in international format, e.g. +919825012345'),
  country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Country must be a 2-letter ISO code, e.g. IN'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128, 'Password is too long'),
  fullName: z.string().trim().min(1, 'Name is required').max(80, 'Name is too long'),
};

module.exports = { z, parse, f };
