import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LIMITS, PUBLIC_GROUP_ID, type ServerConfig } from '../shared/types';
import { isValidPageKey, normalizeUrl } from '../shared/url';
import { type Config, emailMode, googleEnabled } from './config';
import { safeEqual } from './crypto';
import { type DB, openDb, tx } from './db';
import { processInbound, verifySvix } from './email/inbound';
import { type EmailProvider, OutboxProvider, ResendProvider, RetryableEmailError } from './email/provider';
import { EmailQueue } from './email/queue';
import { consumeState, exchangeCode, isAllowedExtensionRedirect, startGoogle } from './google';
import { LiveHub } from './live';
import { checkUnsubscribeSig, notifyNewComment, queueLoginEmail } from './notifications';
import { homePage, messagePage, outboxPage, PAGE_CSP, unsubscribePage, verifyPage } from './pages';
import {
  addComment,
  ApiError,
  canAccessGroup,
  clampTitle,
  createThread,
  deleteComment,
  editComment,
  getThread,
  listThreads,
  setResolved,
} from './threads';
import {
  cleanName,
  createSession,
  deleteSession,
  getUser,
  meOf,
  normalizeEmail,
  purgeExpired,
  recentLoginCount,
  startEmailLogin,
  updateUser,
  upsertUser,
  type UserRow,
  userForToken,
  verifyEmailCode,
  verifyEmailLink,
} from './users';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
    user?: UserRow;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const body = z
  .string()
  .transform(s => s.replace(/\r\n?/g, '\n').trim())
  .pipe(z.string().min(1, 'empty').max(LIMITS.commentBody));

const selector = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('TextQuoteSelector'),
    exact: z.string().min(1).max(LIMITS.quote),
    prefix: z.string().max(400).optional(),
    suffix: z.string().max(400).optional(),
  }),
  z.object({ type: z.literal('TextPositionSelector'), start: z.number().int().min(0), end: z.number().int().min(0) }),
  z.object({
    type: z.literal('RangeSelector'),
    startContainer: z.string().max(4000),
    startOffset: z.number().int().min(0),
    endContainer: z.string().max(4000),
    endOffset: z.number().int().min(0),
  }),
]);

const createThreadSchema = z.object({
  id: uuid,
  groupId: z.string().max(64).optional(),
  pageKeys: z.array(z.string()).min(1).max(2),
  url: z.string().max(LIMITS.url),
  title: z.string().max(5000).default(''),
  quote: z.string().min(1).max(LIMITS.quote),
  selectors: z
    .array(selector)
    .min(1)
    .max(5)
    .refine(s => s.some(x => x.type === 'TextQuoteSelector'), 'TextQuoteSelector required'),
  comment: z.object({ id: uuid, body }),
});

const addCommentSchema = z.object({ id: uuid, body });
const editCommentSchema = z.object({ body });
const resolveSchema = z.object({ resolved: z.boolean() });
const emailStartSchema = z.object({ email: z.string().max(LIMITS.email) });
const emailVerifySchema = z.union([
  z.object({ requestId: z.string().min(1).max(100), code: z.string().min(1).max(20) }),
  z.object({ token: z.string().min(1).max(200) }),
]);
const mePatchSchema = z.object({ name: z.string().max(200).optional(), notifyEmail: z.boolean().optional() });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new ApiError(400, 'invalid_request', r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  return r.data;
}

// ---------------------------------------------------------------------------
// Simple fixed-window limiter for keys other than IP (email, user).
// ---------------------------------------------------------------------------

class Limiter {
  private hits = new Map<string, { count: number; reset: number }>();
  hit(key: string, max: number, windowMs: number): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.reset < now) {
      this.hits.set(key, { count: 1, reset: now + windowMs });
      if (this.hits.size > 50_000) this.prune(now);
      return true;
    }
    entry.count++;
    return entry.count <= max;
  }
  private prune(now: number) {
    for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
  }
}

// ---------------------------------------------------------------------------

export type AppDeps = {
  config: Config;
  db?: DB;
  provider?: EmailProvider;
  /** Live socket heartbeat / session re-check interval (tests shorten it). */
  liveHeartbeatMs?: number;
};

export async function buildApp({ config, db: givenDb, provider: givenProvider, liveHeartbeatMs }: AppDeps) {
  const db = givenDb ?? openDb(config.databasePath);
  const provider: EmailProvider =
    givenProvider ??
    (emailMode(config) === 'resend'
      ? new ResendProvider(config.email.resendApiKey, config.email.resendApiBase)
      : new OutboxProvider(db));

  const app = Fastify({
    logger: config.isProduction
      ? { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] }
      : { level: process.env.LOG_LEVEL ?? 'warn' },
    bodyLimit: 2 * 1024 * 1024,
  });

  const log = (msg: string, extra?: object) => app.log.info(extra ?? {}, msg);
  const queue = new EmailQueue(db, provider, config.email.workerIntervalMs, log);
  const hub = new LiveHub(db, token => userForToken(db, token, config.sessionDays), liveHeartbeatMs);
  const limiter = new Limiter();

  // Keep the raw JSON body (needed to verify webhook signatures).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, raw, done) => {
    const text = raw as string;
    (req as FastifyRequest).rawBody = text;
    if (!text) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new ApiError(400, 'bad_json'), undefined);
    }
  });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, raw, done) => {
    done(null, Object.fromEntries(new URLSearchParams(raw as string)));
  });

  // Behind Fly's proxy the client address is in Fly-Client-IP (set by the
  // proxy). Without a trusted proxy, only the socket address counts: headers
  // are client-controlled and would let anyone dodge rate limits.
  const clientIp = (req: FastifyRequest): string => {
    if (config.trustProxy) {
      const fly = req.headers['fly-client-ip'];
      if (typeof fly === 'string' && fly) return fly;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  await app.register(rateLimit, {
    max: 600,
    timeWindow: '1 minute',
    keyGenerator: clientIp,
    allowList: (req: FastifyRequest) => req.url === '/healthz',
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err.statusCode === 429) return reply.code(429).send({ error: 'rate_limited', message: 'Too many requests' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong' });
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    if (String(reply.getHeader('content-type') ?? '').startsWith('text/html')) {
      reply.header('Content-Security-Policy', PAGE_CSP);
      reply.header('X-Frame-Options', 'DENY');
    }
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  const bearer = (req: FastifyRequest): string | null => {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return null;
    return h.slice(7).trim();
  };

  const requireUser = async (req: FastifyRequest) => {
    const user = userForToken(db, bearer(req), config.sessionDays);
    if (!user) throw new ApiError(401, 'unauthorized', 'Sign in first');
    req.user = user;
  };

  const userLimit = (user: UserRow, bucket: string, max: number, windowMs: number) => {
    if (!limiter.hit(`${bucket}:${user.id}`, max, windowMs)) throw new ApiError(429, 'rate_limited', 'Slow down a little');
  };

  const html = (reply: FastifyReply, content: string, status = 200) =>
    reply.code(status).type('text/html; charset=utf-8').send(content);

  // ---- basics ----

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/favicon.ico', async (_req, reply) => reply.code(204).send());
  app.get('/', async (_req, reply) => html(reply, homePage()));
  app.get('/api/config', async (): Promise<ServerConfig> => ({
    googleEnabled: googleEnabled(config),
    emailMode: emailMode(config),
  }));

  // ---- auth: email ----

  app.post('/api/auth/email/start', async req => {
    const { email: raw } = parse(emailStartSchema, req.body);
    const email = normalizeEmail(raw);
    if (!email) throw new ApiError(400, 'invalid_email', 'That email address looks wrong');
    if (!limiter.hit(`login-ip:${clientIp(req)}`, config.loginIpLimit, 15 * 60_000) || recentLoginCount(db, email, 60 * 60_000) >= 6) {
      throw new ApiError(429, 'rate_limited', 'Too many sign-in emails. Try again later.');
    }
    const { requestId, code, linkToken } = startEmailLogin(db, config.appSecret, email);
    queueLoginEmail(queue, config, email, requestId, code, linkToken);
    return { requestId, emailMode: emailMode(config) };
  });

  app.post('/api/auth/email/verify', async req => {
    if (!limiter.hit(`verify-ip:${clientIp(req)}`, config.loginIpLimit * 3, 15 * 60_000)) throw new ApiError(429, 'rate_limited');
    const input = parse(emailVerifySchema, req.body);
    const result =
      'token' in input
        ? verifyEmailLink(db, input.token)
        : verifyEmailCode(db, config.appSecret, input.requestId, input.code);
    if (!result.ok) {
      const messages = {
        invalid: 'That code or link is not valid.',
        expired: 'That code or link has expired. Request a new one.',
        too_many_attempts: 'Too many attempts. Request a new code.',
      };
      throw new ApiError(400, result.error, messages[result.error]);
    }
    const user = upsertUser(db, result.email);
    const token = createSession(db, user.id, config.sessionDays);
    return { token, user: meOf(user) };
  });

  app.post('/api/auth/logout', async req => {
    const token = bearer(req);
    if (token) {
      deleteSession(db, token);
      hub.disconnectSession(token);
    }
    return { ok: true };
  });

  // ---- auth: Google ----

  app.get('/api/auth/google/start', async (req, reply) => {
    if (!googleEnabled(config)) return html(reply, messagePage('Google sign-in is off', 'This server has no Google client configured.'), 404);
    const redirectUri = String((req.query as Record<string, unknown>).redirect_uri ?? '');
    if (!isAllowedExtensionRedirect(config, redirectUri)) {
      return html(reply, messagePage('Sign-in failed', 'This extension is not allowed to sign in here.'), 400);
    }
    return reply.redirect(startGoogle(db, config, redirectUri));
  });

  app.get('/api/auth/google/callback', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const state = q.state ? consumeState(db, q.state) : null;
    if (!state) return html(reply, messagePage('Sign-in failed', 'This sign-in link expired. Try again from the extension.'), 400);
    const fail = (code: string) => reply.redirect(`${state.redirectUri}#error=${encodeURIComponent(code)}`);
    if (q.error || !q.code) return fail(q.error ?? 'no_code');
    try {
      const profile = await exchangeCode(config, q.code, state.verifier);
      const email = normalizeEmail(profile.email);
      if (!email) return fail('invalid_email');
      const user = upsertUser(db, email, { name: profile.name, googleSub: profile.sub });
      const token = createSession(db, user.id, config.sessionDays);
      return reply.redirect(`${state.redirectUri}#session=${encodeURIComponent(token)}`);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'google sign-in failed');
      return fail('google_failed');
    }
  });

  // ---- me ----

  app.get('/api/me', { preHandler: requireUser }, async req => ({ user: meOf(req.user!) }));

  app.patch('/api/me', { preHandler: requireUser }, async req => {
    const input = parse(mePatchSchema, req.body);
    const patch: { name?: string; notifyEmail?: boolean } = {};
    if (input.name !== undefined) {
      const name = cleanName(input.name);
      if (!name) throw new ApiError(400, 'invalid_name', 'Name cannot be empty');
      patch.name = name;
    }
    if (input.notifyEmail !== undefined) patch.notifyEmail = input.notifyEmail;
    return { user: meOf(updateUser(db, req.user!.id, patch)) };
  });

  // ---- threads ----

  const groupOf = (raw: unknown) => {
    const g = typeof raw === 'string' && raw ? raw : PUBLIC_GROUP_ID;
    if (g.length > 64) throw new ApiError(400, 'invalid_group');
    return g;
  };

  app.get('/api/threads', { preHandler: requireUser }, async req => {
    const groupId = groupOf((req.query as Record<string, unknown>).group);
    if (!canAccessGroup(db, req.user!, groupId)) throw new ApiError(404, 'group_not_found');
    // Repeated `key` parameters (already decoded once by Fastify): page keys
    // may legitimately contain commas or percent-escapes.
    const raw = (req.query as Record<string, unknown>).key;
    const keys = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
      .filter((k): k is string => typeof k === 'string')
      .filter(isValidPageKey)
      .slice(0, 4);
    if (keys.length === 0) throw new ApiError(400, 'invalid_request', 'keys required');
    return { threads: listThreads(db, groupId, keys) };
  });

  app.get('/api/threads/:id', { preHandler: requireUser }, async req => {
    const id = parse(uuid, (req.params as { id: string }).id);
    const thread = getThread(db, id);
    if (!thread || !canAccessGroup(db, req.user!, thread.groupId)) throw new ApiError(404, 'thread_not_found');
    return { thread };
  });

  app.post('/api/threads', { preHandler: requireUser }, async (req, reply) => {
    const user = req.user!;
    userLimit(user, 'write', 120, 60_000);
    const input = parse(createThreadSchema, req.body);
    const groupId = groupOf(input.groupId);
    if (!canAccessGroup(db, user, groupId)) throw new ApiError(404, 'group_not_found');
    const pageKeys = [...new Set(input.pageKeys)];
    if (!pageKeys.every(isValidPageKey)) throw new ApiError(400, 'invalid_page_key');
    const url = normalizeUrl(input.url);
    if (!url) throw new ApiError(400, 'invalid_url');
    if (JSON.stringify(input.selectors).length > LIMITS.selectorsJson) throw new ApiError(413, 'selection_too_long');
    const result = createThread(db, user, {
      id: input.id,
      groupId,
      pageKeys,
      url,
      title: clampTitle(input.title),
      quote: input.quote.replace(/\s+/g, ' ').trim().slice(0, LIMITS.quote),
      selectors: input.selectors,
      comment: input.comment,
    });
    if (result.created) hub.publishThread(result.thread);
    return reply.code(result.created ? 201 : 200).send({ thread: result.thread });
  });

  /**
   * Add a comment and queue its notifications in one transaction (a crash
   * can't leave a comment whose notifications were never queued), then
   * publish the change.
   */
  const postComment = (user: UserRow, threadId: string, comment: { id: string; body: string }, source: 'web' | 'email' = 'web') => {
    const result = tx(db, () => {
      const r = addComment(db, user, threadId, comment, source);
      if (r.created) notifyNewComment(db, queue, config, r.thread, r.commentId, user);
      return r;
    });
    if (result.created) hub.publishThread(result.thread);
    return result;
  };

  app.post('/api/threads/:id/comments', { preHandler: requireUser }, async (req, reply) => {
    const user = req.user!;
    userLimit(user, 'write', 120, 60_000);
    const threadId = parse(uuid, (req.params as { id: string }).id);
    const input = parse(addCommentSchema, req.body);
    const result = postComment(user, threadId, input);
    return reply.code(result.created ? 201 : 200).send({ thread: result.thread });
  });

  app.patch('/api/comments/:id', { preHandler: requireUser }, async req => {
    const user = req.user!;
    userLimit(user, 'write', 120, 60_000);
    const id = parse(uuid, (req.params as { id: string }).id);
    const input = parse(editCommentSchema, req.body);
    const thread = editComment(db, user, id, input.body);
    hub.publishThread(thread);
    return { thread };
  });

  app.delete('/api/comments/:id', { preHandler: requireUser }, async req => {
    const user = req.user!;
    userLimit(user, 'write', 120, 60_000);
    const id = parse(uuid, (req.params as { id: string }).id);
    const result = deleteComment(db, user, id);
    if (result.kind === 'thread') {
      hub.publishDeleted(result.groupId, result.threadId, result.pageKey, result.altPageKey);
      return { deletedThread: result.threadId };
    }
    if (result.kind === 'comment') {
      hub.publishThread(result.thread);
      return { thread: result.thread };
    }
    return { ok: true };
  });

  app.post('/api/threads/:id/resolve', { preHandler: requireUser }, async req => {
    const user = req.user!;
    userLimit(user, 'write', 120, 60_000);
    const id = parse(uuid, (req.params as { id: string }).id);
    const input = parse(resolveSchema, req.body);
    const before = getThread(db, id);
    const thread = setResolved(db, user, id, input.resolved);
    if (!before || before.version !== thread.version) hub.publishThread(thread);
    return { thread };
  });

  // ---- live ----

  app.get('/api/live', { websocket: true }, socket => {
    hub.attach(socket);
  });

  // ---- pages ----

  app.get('/auth/verify', async (_req, reply) => html(reply, verifyPage()));

  const unsubscribeParams = (req: FastifyRequest) => {
    const q = req.query as Record<string, string | undefined>;
    const u = q.u ?? '';
    const s = q.s ?? '';
    if (!/^[a-z2-7]{12}$/.test(u) || !checkUnsubscribeSig(config.appSecret, u, s)) return null;
    return { u, s };
  };

  app.get('/unsubscribe', async (req, reply) => {
    const p = unsubscribeParams(req);
    if (!p) return html(reply, messagePage('Link not valid', 'This unsubscribe link is not valid.'), 400);
    return html(reply, unsubscribePage(p.u, p.s, false));
  });

  app.post('/unsubscribe', async (req, reply) => {
    const p = unsubscribeParams(req);
    if (!p) return html(reply, messagePage('Link not valid', 'This unsubscribe link is not valid.'), 400);
    if (getUser(db, p.u)) updateUser(db, p.u, { notifyEmail: false });
    return html(reply, unsubscribePage(p.u, p.s, true));
  });

  app.get('/admin/outbox', async (req, reply) => {
    const auth = req.headers.authorization ?? '';
    const password = auth.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString().split(':').slice(1).join(':') : '';
    if (!config.adminToken || !limiter.hit(`admin-ip:${clientIp(req)}`, 60, 15 * 60_000) || !safeEqual(password, config.adminToken)) {
      reply.header('WWW-Authenticate', 'Basic realm="margin-comments admin", charset="UTF-8"');
      return html(reply, messagePage('Sign in required', 'Use the admin password.'), 401);
    }
    const rows = db
      .prepare('SELECT to_email, subject, text, created_at, reply_to FROM outbox_emails ORDER BY created_at DESC LIMIT 50')
      .all() as Array<{ to_email: string; subject: string; text: string; created_at: string; reply_to: string | null }>;
    return html(reply, outboxPage(rows, emailMode(config)));
  });

  // ---- inbound email (Resend webhook) ----

  app.post('/webhooks/resend', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!config.email.resendWebhookSecret || !verifySvix(config.email.resendWebhookSecret, req.headers as any, req.rawBody ?? '')) {
      return reply.code(401).send({ error: 'invalid_signature' });
    }
    const event = req.body as { type?: string; data?: { email_id?: string } };
    if (event?.type !== 'email.received') return { ignored: true };
    const emailId = event.data?.email_id;
    if (typeof emailId !== 'string' || !emailId || emailId.length > 200) return { ignored: true };
    if (!provider.getReceived) {
      req.log.warn('inbound email received but the provider cannot fetch it');
      return { ignored: true };
    }
    let email;
    try {
      email = await provider.getReceived(emailId);
    } catch (err) {
      req.log.warn({ err: (err as Error).message }, 'could not fetch inbound email');
      // 5xx makes Resend redeliver later; a permanent error is acknowledged.
      if (err instanceof RetryableEmailError) return reply.code(503).send({ error: 'fetch_failed' });
      return { ignored: true, reason: 'fetch_failed' };
    }
    const outcome = processInbound(
      {
        db,
        secret: config.appSecret,
        replyDomain: config.email.replyDomain,
        requireSenderAuth: config.email.requireSenderAuth,
        getUser: id => getUser(db, id),
        postComment: (userId, threadId, commentId, text) => {
          postComment(getUser(db, userId)!, threadId, { id: commentId, body: text }, 'email');
        },
      },
      email,
    );
    req.log.info({ emailId, status: outcome.status, reason: outcome.status === 'rejected' ? outcome.reason : undefined }, 'inbound email');
    return { status: outcome.status };
  });

  // ---- lifecycle ----

  const housekeeping = setInterval(() => {
    try {
      purgeExpired(db);
    } catch (err) {
      app.log.warn(err);
    }
  }, 3600_000);
  housekeeping.unref();

  app.addHook('onClose', async () => {
    clearInterval(housekeeping);
    queue.stop();
    hub.close();
    if (!givenDb) db.close();
  });

  queue.start();
  return { app, db, hub, queue, provider };
}
