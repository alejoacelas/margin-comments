import type { Thread } from '../shared/types';
import { threadLink } from '../shared/url';
import { type Config, emailMode } from './config';
import { base32Encode, hmac, safeEqual } from './crypto';
import type { DB } from './db';
import type { EmailQueue } from './email/queue';
import { replyAddress } from './email/reply-token';
import { loginEmail, notificationEmail, replyNotPostedEmail } from './email/templates';
import { canAccessGroup, participants } from './threads';
import { isUnboundEmail, type UserRow } from './users';

export function unsubscribeSig(secret: string, userId: string): string {
  return base32Encode(hmac(secret, `unsubscribe:v1:${userId}`).subarray(0, 10));
}

export function unsubscribeLink(config: Config, userId: string): string {
  return `${config.publicUrl}/unsubscribe?u=${encodeURIComponent(userId)}&s=${unsubscribeSig(config.appSecret, userId)}`;
}

export function checkUnsubscribeSig(secret: string, userId: string, sig: string): boolean {
  return safeEqual(unsubscribeSig(secret, userId), sig);
}

function fromAddress(config: Config): string {
  return config.email.from || 'Margin Comments <notifications@margin-comments.invalid>';
}

/**
 * Queue a reply notification for everyone who started or replied in the
 * thread, except the new comment's author and anyone who opted out.
 */
export function notifyNewComment(db: DB, queue: EmailQueue, config: Config, thread: Thread, commentId: string, author: UserRow) {
  const idx = thread.comments.findIndex(c => c.id === commentId);
  if (idx <= 0) return; // first comment (new thread) or not found: nobody to notify
  const comment = thread.comments[idx];
  const previous = thread.comments[idx - 1];
  const canReply = emailMode(config) === 'resend' && !!config.email.replyDomain;
  const link = threadLink(thread.url, thread.id);

  for (const user of participants(db, thread.id)) {
    if (user.id === author.id || !user.notify_email || isUnboundEmail(user.email)) continue;
    // People who lost access to the thread's group get nothing.
    if (!canAccessGroup(db, user, thread.groupId)) continue;
    const content = notificationEmail({
      threadId: thread.id,
      pageTitle: thread.title,
      pageUrl: thread.url,
      threadLink: link,
      quote: thread.quote,
      replyAuthor: author.name,
      replyBody: comment.body,
      previous: previous ? { author: previous.author.name, body: previous.body } : null,
      recipientStartedThread: thread.author.id === user.id,
      unsubscribeLink: unsubscribeLink(config, user.id),
      canReplyByEmail: canReply,
    });
    const domain = config.email.domain || 'margin-comments.invalid';
    const unsub = unsubscribeLink(config, user.id);
    queue.enqueue(
      'notification',
      {
        meta: { userId: user.id, threadId: thread.id },
        to: user.email,
        from: fromAddress(config),
        replyTo: canReply ? replyAddress(config.appSecret, config.email.replyDomain, thread.id, user.id) : undefined,
        subject: content.subject,
        text: content.text,
        html: content.html,
        headers: {
          // Group every notification for a thread into one conversation.
          'In-Reply-To': `<thread-${thread.id}@${domain}>`,
          References: `<thread-${thread.id}@${domain}>`,
          'List-Unsubscribe': `<${unsub}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      },
      `notify/${commentId}/${user.id}`,
    );
  }
}

export function queueReplyNotPosted(queue: EmailQueue, config: Config, emailId: string, to: string, reason: string, text: string) {
  const content = replyNotPostedEmail({ reason, text });
  queue.enqueue('reply-not-posted', { to, from: fromAddress(config), subject: content.subject, text: content.text, html: content.html }, `reply-not-posted/${emailId}`);
}

export function queueLoginEmail(queue: EmailQueue, config: Config, to: string, requestId: string, code: string, linkToken: string) {
  const content = loginEmail({ code, link: `${config.publicUrl}/auth/verify#token=${linkToken}`, minutes: 20 });
  queue.enqueue(
    'login',
    { to, from: fromAddress(config), subject: content.subject, text: content.text, html: content.html },
    `login/${requestId}`,
  );
}

/** Is this user still someone we should email about this thread? */
export function notificationStillWanted(db: DB, meta: { userId: string; threadId: string } | undefined, to?: string): boolean {
  if (!meta) return true;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(meta.userId) as UserRow | undefined;
  // The account's address changed since queueing: don't send to the old one.
  if (user && to !== undefined && user.email !== to.toLowerCase()) return false;
  const thread = db.prepare('SELECT group_id, deleted_at FROM threads WHERE id = ?').get(meta.threadId) as
    | { group_id: string; deleted_at: string | null }
    | undefined;
  if (!user || !user.notify_email || !thread || thread.deleted_at) return false;
  return canAccessGroup(db, user, thread.group_id);
}
