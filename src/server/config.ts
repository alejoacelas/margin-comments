import { randomBytes } from 'node:crypto';

export type Config = {
  port: number;
  host: string;
  databasePath: string;
  /** Public origin of this server, e.g. https://margin-comments.fly.dev */
  publicUrl: string;
  /** HMAC key for reply addresses, unsubscribe links and OAuth state. */
  appSecret: string;
  /** Password for /admin pages (outbox viewer). Empty disables them. */
  adminToken: string;
  /** Chrome extension IDs allowed as Google sign-in redirect targets. */
  extensionIds: string[];
  trustProxy: boolean;
  email: {
    resendApiKey: string;
    resendApiBase: string;
    resendWebhookSecret: string;
    /** Domain we send from, e.g. mail.example.com. */
    domain: string;
    /** Domain that receives replies (Resend inbound); defaults to `domain`. */
    replyDomain: string;
    from: string;
    /** Poll interval of the email job worker. */
    workerIntervalMs: number;
  };
  google: {
    clientId: string;
    clientSecret: string;
    authUrl: string;
    tokenUrl: string;
    userinfoUrl: string;
  };
  /** Session lifetime in days (sliding). */
  sessionDays: number;
  isProduction: boolean;
};

function env(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const isProduction = env('NODE_ENV') === 'production';
  let appSecret = env('APP_SECRET');
  if (!appSecret) {
    if (isProduction) throw new Error('APP_SECRET must be set in production');
    appSecret = randomBytes(32).toString('hex');
  }
  const domain = env('EMAIL_DOMAIN');
  const config: Config = {
    port: Number(env('PORT', '8787')),
    host: env('HOST', '0.0.0.0'),
    databasePath: env('DATABASE_PATH', './data/margin-comments.db'),
    publicUrl: env('PUBLIC_URL', `http://localhost:${env('PORT', '8787')}`).replace(/\/+$/, ''),
    appSecret,
    adminToken: env('ADMIN_TOKEN'),
    extensionIds: env('EXTENSION_IDS')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    trustProxy: env('TRUST_PROXY', isProduction ? 'true' : 'false') === 'true',
    email: {
      resendApiKey: env('RESEND_API_KEY'),
      resendApiBase: env('RESEND_API_BASE', 'https://api.resend.com').replace(/\/+$/, ''),
      resendWebhookSecret: env('RESEND_WEBHOOK_SECRET'),
      domain,
      replyDomain: env('REPLY_DOMAIN', domain),
      from: env('EMAIL_FROM', domain ? `Margin Comments <notifications@${domain}>` : ''),
      workerIntervalMs: Number(env('EMAIL_WORKER_INTERVAL_MS', '1000')),
    },
    google: {
      clientId: env('GOOGLE_CLIENT_ID'),
      clientSecret: env('GOOGLE_CLIENT_SECRET'),
      authUrl: env('GOOGLE_AUTH_URL', 'https://accounts.google.com/o/oauth2/v2/auth'),
      tokenUrl: env('GOOGLE_TOKEN_URL', 'https://oauth2.googleapis.com/token'),
      userinfoUrl: env('GOOGLE_USERINFO_URL', 'https://openidconnect.googleapis.com/v1/userinfo'),
    },
    sessionDays: Number(env('SESSION_DAYS', '180')),
    isProduction,
  };
  return { ...config, ...overrides };
}

/** Real email goes out through Resend once a key and a domain are configured. */
export function emailMode(config: Config): 'resend' | 'outbox' {
  return config.email.resendApiKey && config.email.domain ? 'resend' : 'outbox';
}

export function googleEnabled(config: Config): boolean {
  return !!(config.google.clientId && config.google.clientSecret);
}
