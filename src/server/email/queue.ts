import { randomUUID } from 'node:crypto';
import { type DB, nowIso } from '../db';
import { type EmailProvider, type OutgoingEmail, PermanentEmailError, RetryableEmailError } from './provider';

const MAX_ATTEMPTS = 10;
/** Quota waits can last a day; give up only after this long. */
const MAX_AGE_MS = 3 * 86400_000;

type JobRow = {
  id: string;
  kind: string;
  to_email: string;
  message: string;
  idempotency_key: string;
  attempts: number;
  created_at: string;
};

/**
 * Durable outgoing-email queue. Jobs are written in the same transaction as
 * the change that caused them, survive restarts, and are retried with
 * exponential backoff. The idempotency key goes to the provider, so a crash
 * between "sent" and "marked sent" never produces a duplicate email.
 */
export class EmailQueue {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private kick = false;
  private stopped = false;

  constructor(
    private db: DB,
    private provider: EmailProvider,
    private intervalMs = 1000,
    private log: (msg: string, extra?: object) => void = () => {},
    /** Last check before sending (e.g. still subscribed, still has access). */
    private stillWanted: (msg: OutgoingEmail) => boolean = () => true,
  ) {}

  get providerName() {
    return this.provider.name;
  }

  /** Insert a job; a duplicate idempotency key is ignored. */
  enqueue(kind: string, msg: OutgoingEmail, idempotencyKey: string) {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO email_jobs (id, kind, to_email, message, idempotency_key, status, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(randomUUID(), kind, msg.to, JSON.stringify(msg), idempotencyKey, now, now);
    this.poke();
  }

  start() {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(err => this.log('email queue tick failed', { error: String(err) })), this.intervalMs);
    this.timer.unref();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Process due jobs soon (after the current transaction commits). */
  poke() {
    if (this.stopped) return;
    setImmediate(() => void this.tick().catch(err => this.log('email queue tick failed', { error: String(err) })));
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.kick = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.kick = false;
        const due = this.db
          .prepare(
            `SELECT * FROM email_jobs WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 20`,
          )
          .all(nowIso()) as JobRow[];
        for (const job of due) {
          if (this.stopped) return;
          await this.process(job);
        }
      } while (this.kick && !this.stopped);
    } finally {
      this.running = false;
    }
  }

  private async process(job: JobRow) {
    const { meta: _meta, ...msg } = JSON.parse(job.message) as OutgoingEmail;
    if (!this.stillWanted({ meta: _meta, ...msg })) {
      this.db.prepare(`UPDATE email_jobs SET status = 'failed', last_error = 'cancelled: recipient no longer eligible' WHERE id = ?`).run(job.id);
      return;
    }
    try {
      const { id } = await this.provider.send(msg, job.idempotency_key);
      this.db
        .prepare(`UPDATE email_jobs SET status = 'sent', provider_id = ?, sent_at = ?, attempts = attempts + 1 WHERE id = ?`)
        .run(id, nowIso(), job.id);
      this.log('email sent', { kind: job.kind, job: job.id });
    } catch (err) {
      // Quota waits (an hour or more) don't count as failed attempts.
      const quotaWait = err instanceof RetryableEmailError && (err.retryAfterMs ?? 0) >= 3600_000;
      const attempts = job.attempts + (quotaWait ? 0 : 1);
      const tooOld = Date.now() - Date.parse(job.created_at) > MAX_AGE_MS;
      const permanent = err instanceof PermanentEmailError || attempts >= MAX_ATTEMPTS || tooOld;
      const retryAfter =
        err instanceof RetryableEmailError && err.retryAfterMs
          ? err.retryAfterMs
          : Math.min(3600_000, 5000 * 2 ** (attempts - 1));
      this.db
        .prepare(`UPDATE email_jobs SET status = ?, attempts = ?, last_error = ?, next_attempt_at = ? WHERE id = ?`)
        .run(
          permanent ? 'failed' : 'pending',
          attempts,
          String((err as Error).message).slice(0, 500),
          new Date(Date.now() + retryAfter).toISOString(),
          job.id,
        );
      this.log(permanent ? 'email failed permanently' : 'email failed, will retry', {
        kind: job.kind,
        job: job.id,
        error: (err as Error).message,
      });
    }
  }
}
