'use strict';
const { z } = require('zod');

const policies = z.array(z.object({ slug: z.string(), version: z.coerce.number().int() })).max(20).optional();
const email = z.string().trim().toLowerCase().email().max(254);

module.exports = {
  register: z.object({
    email,
    password: z.string().min(1).max(128),
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    phone: z.string().trim().max(20).optional(),
    acceptedPolicies: policies,
    marketingOptIn: z.boolean().optional(),
  }),
  login: z.object({ email, password: z.string().min(1).max(128) }),
  token: z.object({ token: z.string().min(10).max(300) }),
  email: z.object({ email }),
  reset: z.object({ token: z.string().min(10).max(300), password: z.string().min(1).max(128) }),
  changePassword: z.object({ currentPassword: z.string().max(128).optional(), newPassword: z.string().min(1).max(128) }),
  google: z.object({ credential: z.string().min(20).max(5000), acceptedPolicies: policies }),
  challenge: z.object({ challengeToken: z.string().min(10).max(300), code: z.string().max(10).optional(), recoveryCode: z.string().max(20).optional() }),
  code: z.object({ code: z.string().min(4).max(10) }),
  phone: z.object({ phone: z.string().trim().max(20).optional() }),
  disable2fa: z.object({ password: z.string().max(128).optional(), code: z.string().min(6).max(10) }),
};
