'use strict';
const { E } = require('./errors');

/** Wrap async route handlers so rejections reach the error middleware. */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Consistent success envelope. */
function ok(res, data, meta, status = 200) {
  const body = { success: true, data };
  if (meta) body.meta = meta;
  body.requestId = res.req?.id;
  return res.status(status).json(body);
}
const created = (res, data, meta) => ok(res, data, meta, 201);

/** Parse page/limit/sort from query with safe bounds. */
function parsePagination(query, { defaultLimit = 20, maxLimit = 100, allowedSort = ['createdAt'], defaultSort = '-createdAt' } = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  let sort = String(query.sort || defaultSort);
  const field = sort.replace(/^-/, '');
  if (!allowedSort.includes(field)) sort = defaultSort;
  const sortObj = { [sort.replace(/^-/, '')]: sort.startsWith('-') ? -1 : 1, _id: sort.startsWith('-') ? -1 : 1 };
  return { page, limit, skip: (page - 1) * limit, sort: sortObj, sortKey: sort };
}

async function paginate(model, filter, pg, { projection, populate, lean = true } = {}) {
  let q = model.find(filter, projection).sort(pg.sort).skip(pg.skip).limit(pg.limit);
  if (populate) q = q.populate(populate);
  if (lean) q = q.lean();
  const [items, total] = await Promise.all([q, model.countDocuments(filter)]);
  return { items, meta: { page: pg.page, limit: pg.limit, total, pages: Math.ceil(total / pg.limit) } };
}

/** Validate req[part] with a zod schema, replacing it with parsed output. */
const validate = (schema, part = 'body') => (req, _res, next) => {
  const r = schema.safeParse(req[part] ?? {});
  if (!r.success) {
    return next(E.validation(r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))));
  }
  if (part === 'query') req.validQuery = r.data;
  else req[part] = r.data;
  next();
};

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { asyncHandler, ok, created, parsePagination, paginate, validate, escapeRegex };
