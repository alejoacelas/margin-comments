# Resend: sending, inbound replies, webhooks (research notes, 2026-10-26)

Researched 2026-10-26 from the live docs at resend.com/docs (Markdown versions via
`https://resend.com/docs/<page>.md`, index at https://resend.com/docs/llms.txt), the
official OpenAPI spec (https://github.com/resend/resend-openapi, `resend.yaml`
v1.5.1, last pushed 2026-10-17), the `resend` Node SDK source
(https://github.com/resend/resend-node, v6.34.1), Resend's chat SDK adapter
(https://github.com/resend/resend-chat-sdk), and Svix / Standard Webhooks sources.
No account was created and nothing was sent.

**UNCONFIRMED** marks anything the sources do not state explicitly.

---

## 0. TL;DR for implementation

| Thing | Value |
|---|---|
| Base URL | `https://api.resend.com` (HTTPS only) |
| Auth | `Authorization: Bearer re_xxxxxxxxx` |
| Required extra header | `User-Agent: <anything>` (a request without it gets 403, error code 1010) |
| Send | `POST /emails` returns `200 {"id":"<uuid>"}` |
| Idempotency | `Idempotency-Key: <1..256 chars>` header, kept for 24 h |
| Error body | `{"statusCode":422,"message":"...","name":"missing_required_field"}` |
| Rate limit | 10 req/s **per team** (shared by all keys); 429 `rate_limit_exceeded`; `retry-after` header in seconds |
| Inbound event | webhook `type: "email.received"`, **metadata only** (no body, no headers) |
| Fetch inbound body | `GET /emails/receiving/{email_id}` returns `html`, `text`, `headers`, `authentication{spf,dkim,dmarc}`, `raw.download_url`, `attachments[]` |
| Key permission needed for inbound fetch | `full_access` (a `sending_access` key gets 401 `restricted_api_key`) |
| Webhook signing | Svix: headers `svix-id`, `svix-timestamp`, `svix-signature`; HMAC-SHA256 over `${id}.${timestamp}.${rawBody}` with key = base64-decode(secret without `whsec_`) |
| Webhook success | any 2xx (docs say "200"); otherwise retried: immediately, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h |
| Sending DNS | DKIM TXT `resend._domainkey`; SPF MX `send` → `feedback-smtp.<region>.amazonses.com` (prio 10); SPF TXT `send` → `v=spf1 include:amazonses.com ~all` (newer domains may get CNAMEs instead) |
| Receiving DNS | MX on the domain or subdomain itself → value from dashboard (`receive.forge.rmta.net`, `receive-euw1.forge.rmta.net` or `inbound-smtp.<region>.amazonaws.com`), prio 10, must be the lowest priority value on that name |

---

## 1. Sending: `POST https://api.resend.com/emails`

Sources: https://resend.com/docs/api-reference/emails/send-email ·
https://resend.com/docs/api-reference/introduction ·
OpenAPI `SendEmailRequest` (https://raw.githubusercontent.com/resend/resend-openapi/main/resend.yaml)

### 1.1 Request headers

```
Authorization: Bearer re_xxxxxxxxx
Content-Type: application/json
User-Agent: margin-comments/1.0      # REQUIRED; a missing UA gets 403 (Cloudflare error 1010)
Idempotency-Key: <optional, 1..256 chars>
```

- Missing `User-Agent` returns 403 with error code `1010` before the request reaches the API
  (https://resend.com/docs/knowledge-base/403-error-1010). Node's built-in `fetch` sends
  `User-Agent: node` by default (I checked this locally on Node v26.10.0), but set one explicitly.
- No API versioning header exists yet ("we plan to add versioning via calendar-based
  headers in the future", API intro page).

### 1.2 Body fields (JSON wire format is snake_case)

The Node SDK takes camelCase (`replyTo`, `scheduledAt`, `topicId`, attachment
`contentType`/`contentId`) and converts it to these snake_case names in
`src/common/utils/parse-email-to-api-options.ts`. A raw HTTP client or fake must use
snake_case.

| Field | Type | Notes |
|---|---|---|
| `from` | string, **required** | `"Name <addr@verified.domain>"` or a bare address |
| `to` | string \| string[], **required** | **Max 50** recipients |
| `subject` | string, **required** | |
| `cc` | string \| string[] | Max not documented (UNCONFIRMED) |
| `bcc` | string \| string[] | Max not documented (UNCONFIRMED) |
| `reply_to` | string \| string[] | Exact casing `reply_to` |
| `html` | string | |
| `text` | string | If omitted, Resend generates plain text from `html`. Send `""` to opt out |
| `headers` | object (string to string) | Custom headers, see §5 |
| `attachments` | array of `{ content?, filename?, path?, content_type?, content_id? }` | `content` is a base64 string (or a Buffer in the SDK); `path` is a URL Resend fetches. Max **40 MB per email after base64**. A 422 `invalid_attachment` comes back if neither `content` nor `path` is given |
| `tags` | array of `{ name, value }` | Both only ASCII letters, digits, `_`, `-`; ≤256 chars each |
| `scheduled_at` | string | ISO 8601 or natural language (`"in 1 min"`) |
| `template` | `{ id, variables? }` | Can't be combined with `html`/`text`/`react` |
| `topic_id` | string | Marketing topics; not needed here |
| `react` | | Node SDK only; never on the wire |

Minimal example:

```bash
curl -X POST 'https://api.resend.com/emails' \
  -H 'Authorization: Bearer re_xxxxxxxxx' \
  -H 'Content-Type: application/json' \
  -H 'User-Agent: margin-comments/1.0' \
  -H 'Idempotency-Key: notify/<commentId>/<recipientUserId>' \
  -d '{
    "from": "Margin <notify@m.example.com>",
    "to": ["alice@example.org"],
    "subject": "New reply on \"Some page\"",
    "html": "<p>...</p>",
    "text": "...",
    "reply_to": "r-<signedtoken>@m.example.com",
    "headers": { "X-Entity-Ref-ID": "<threadId>" },
    "tags": [{ "name": "kind", "value": "reply_notification" }]
  }'
```

### 1.3 Success response

`200 OK`

```json
{ "id": "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }
```

The response does **not** include the RFC `Message-ID`. Since 2026-07-08, `message_id`
is returned by `GET /emails/{email_id}`, by `GET /emails`, and in **all `email.*` webhooks**,
including `email.sent`, which fires as soon as the email is accepted
(https://resend.com/changelog/message-id-for-sent-emails). Example:
`"message_id": "<111-222-333@email.example.com>"`.

### 1.4 Error shape and status codes

The error body is a JSON object with `statusCode`, `message` and `name`. This shape comes
from real API responses recorded in the SDK's test fixtures
(`resend-node/src/**/__recordings__/*.har`) and from the SDK's `ErrorResponse` type
(`src/interfaces.ts`):

```json
{"statusCode":422,"message":"Missing `email` field.","name":"missing_required_field"}
{"statusCode":404,"message":"Contact not found","name":"not_found"}
```

All documented errors (https://resend.com/docs/api-reference/errors):

| Status | `name` | Meaning |
|---|---|---|
| 400 | `invalid_idempotency_key` | Key must be 1–256 chars |
| 400 | `validation_error` | Bad field(s); or "API key is invalid" on non-send endpoints |
| 401 | `missing_api_key` | No `Authorization` header |
| 401 | `restricted_api_key` | "This API key is restricted to only send emails." (a sending-access key on another endpoint, **including `GET /emails/receiving/*`**) |
| 401 | `validation_error` | "API key is invalid" on the **sending** endpoints |
| 403 | `email_above_quota` | Can't retrieve a received email's content because it arrived over quota |
| 403 | `invalid_permission` | OAuth token is missing scopes |
| 403 | `restricted_api_key` | "API key is not active" |
| 403 | `suspended_api_key` | |
| 403 | `validation_error` | Sending from `resend.dev` to anyone except your own address; or "The `domain.com` domain is not verified"; or domain registered by another team; or inbox limits |
| 404 | `not_found` | |
| 405 | `method_not_allowed` | |
| 409 | `concurrent_idempotent_requests` | Same key still in flight; safe to retry later |
| 409 | `invalid_idempotent_request` | Same key used within 24 h with a different body |
| 409 | `resource_locked` | |
| 422 | `invalid_attachment` | Attachment has neither `content` nor `path` |
| 422 | `invalid_parameter` | e.g. invalid `from` format, invalid UUID |
| 422 | `missing_required_field` | e.g. "Missing `from` field." |
| 422 | `missing_required_parameter` | |
| 429 | `daily_quota_exceeded` | Free plan only; resets at 00:00 UTC. **Don't retry soon** |
| 429 | `monthly_quota_exceeded` | **Don't retry soon** |
| 429 | `rate_limit_exceeded` | Too many requests per second; retry after `retry-after` |
| 500 | `application_error` | |
| 503 | `service_unavailable` | |

The SDK's `RESEND_ERROR_CODE_KEY` type also lists `invalid_api_key`, `invalid_from_address`,
`invalid_access`, `invalid_region`, `security_error` and `internal_server_error`. These are
not on the errors page, so a client should accept unknown `name` values.

### 1.5 Idempotency-Key

Source: https://resend.com/docs/dashboard/emails/idempotency-keys

- Header `Idempotency-Key`. Supported on `POST /emails` and `POST /emails/batch`, plus the
  Inboxes send, reply and forward endpoints. For SMTP, the equivalent is the
  `Resend-Idempotency-Key` email header.
- 1–256 chars, "unique per API request". Resend suggests the form `<event-type>/<entity-id>`,
  e.g. `welcome-user/123456789`.
- Keys are kept for **24 hours**. A repeat request with the same key and the same body inside
  24 h returns the **same response** (the original email `id`) without sending again.
- The key is scoped to "this HTTP method and endpoint" (from the `invalid_idempotent_request`
  message).
- Errors: 400 `invalid_idempotency_key`, 409 `invalid_idempotent_request` (body differs;
  pointless to retry), 409 `concurrent_idempotent_requests` (original still in progress;
  retry later).

### 1.6 Rate limits and 429

Sources: https://resend.com/docs/api-reference/rate-limit ·
https://resend.com/docs/knowledge-base/account-quotas-and-limits

- Default: **10 requests/second per team**, shared by all API keys. It's a per-second window
  with **no burst allowance**; the 11th request in one second gets 429. Support can raise it.
- Response headers on every request (IETF draft-ietf-httpapi-ratelimit-headers-06):
  - `ratelimit-limit`: max requests in the window
  - `ratelimit-remaining`: requests left in the window
  - `ratelimit-reset`: seconds until the window resets
  - `retry-after`: seconds to wait before retrying (on 429)
  - The SDK's real-API recordings also show `ratelimit-policy` (e.g. `2;w=1` in Oct 2025,
    when the default was 2/s). It isn't in the docs.
- Quota headers: `x-resend-daily-quota` (free plan only) and `x-resend-monthly-quota` (used
  counts).
- **Received emails count toward the quota too** (1 each). Every `to`/`cc`/`bcc` recipient
  counts as a separate email.
- The Node SDK does **not** retry automatically. On 429 it returns
  `{ data: null, error: {name:'rate_limit_exceeded', statusCode:429, ...}, headers }`.
- Batch: `POST /emails/batch` takes up to 100 emails per call and counts as 1 request;
  `attachments` isn't supported there.

### 1.7 Plan limits worth knowing (free plan)

100 emails/day and 3,000/month (sent and received combined), 3 domains, 30-day data
retention (https://resend.com/docs/knowledge-base/account-quotas-and-limits).

---

## 2. Receiving (inbound)

Sources: https://resend.com/docs/dashboard/receiving/introduction ·
https://resend.com/docs/dashboard/receiving/custom-domains ·
https://resend.com/docs/dashboard/receiving/create-receiving-webhook ·
https://resend.com/docs/webhooks/emails/received ·
https://resend.com/docs/dashboard/receiving/get-email-content ·
https://resend.com/docs/api-reference/emails/retrieve-received-email

### 2.1 How it works

1. Mail reaches Resend through an MX record, either Resend's own `<id>.resend.app` domain
   or your verified domain with receiving turned on.
2. Resend stores and parses the message, then sends a webhook `POST` with
   `type: "email.received"` to every endpoint subscribed to that event. Emails are stored
   even with no webhook configured or the endpoint down.
3. The webhook carries **metadata only**. Fetch the body, headers and auth results with
   `GET /emails/receiving/{email_id}`, and attachments with the attachments endpoints.

**Catch-all:** "Any email sent to any username at your receiving domain will be received by
Resend and forwarded to your webhook". You don't create addresses; route on `to`.

### 2.2 Resend-managed address (no DNS)

Every account has a `<id>.resend.app` subdomain that accepts any local part
(`anything@<id>.resend.app`). To find it: Dashboard → **Emails** → **Receiving** tab →
three-dots button → **Receiving address**.

### 2.3 Custom receiving domain (MX)

- The domain must be added and verified first. Turn on receiving with the **Receiving**
  toggle on the domain details page (or `capabilities.receiving: "enabled"` in the API). A
  modal then shows the MX record. Add it and click **I've added the record**; only the MX
  record gets verified, not the whole domain again.
- MX **host** = the domain you added: the root (`example.com`) or a subdomain
  (`reply.example.com`; the DNS UI name is `reply`).
- MX **value**: always copy it from the dashboard. It depends on the domain:
  `receive.forge.rmta.net`, a regional variant like `receive-euw1.forge.rmta.net`, or
  `inbound-smtp.<region>.amazonaws.com` (e.g. `inbound-smtp.us-east-1.amazonaws.com`).
- MX **priority**: guides use `10`. It **must be the lowest priority value** for that name,
  or the email won't reach Resend. With equal priorities the target is chosen at random per
  delivery.
- Use a **subdomain** if the root already has MX records (Google Workspace etc.).
- Resend **drops** mail for domains whose receiving MX isn't verified. Forwarding straight to
  the SMTP host in the MX record doesn't work.
- Receive-only is possible: turn off "Enable Sending". The SPF records can then be removed,
  but **the DKIM record must stay**.

### 2.4 Webhook event `email.received`: exact payload

From https://resend.com/docs/webhooks/emails/received (identical on the
create-receiving-webhook page):

```json
{
  "type": "email.received",
  "created_at": "2026-02-22T23:41:12.126Z",
  "data": {
    "email_id": "56761188-7520-42d8-8898-ff6fc54ce618",
    "created_at": "2026-02-22T23:41:11.894Z",
    "from": "onboarding@resend.dev",
    "to": ["delivered@resend.dev"],
    "bcc": [],
    "cc": [],
    "received_for": ["forwarded@example.com"],
    "message_id": "<111-222-333@email.example.com>",
    "subject": "Sending this example",
    "attachments": [
      {
        "id": "2a0c9ce0-3112-4728-976e-47ddcd16a318",
        "filename": "avatar.png",
        "content_type": "image/png",
        "content_disposition": "inline",
        "content_id": "img001"
      }
    ]
  }
}
```

Schema from OpenAPI `EmailReceivedEvent` / `EmailReceivedEventData`:
- Top level, all required: `type` (const `"email.received"`), `created_at` (ISO date-time,
  when the event was emitted), `data`.
- `data` required: `email_id`, `created_at`, `from`, `to[]`, `subject`, `message_id`,
  `bcc[]`, `cc[]`, `attachments[]`. Optional: `received_for[]`.
- `data.from` is the **bare address** for received mail. The display name is only in
  `headers.from` on the retrieve endpoint.
- `data.received_for` holds the envelope recipients taken from the `for` clause of the
  `Received:` headers. It differs from `to` when mail was forwarded server-side.
- Attachment metadata in the webhook is `id` (required), `filename`, `content_type`,
  `content_disposition`, `content_id`. It has **no `size` and no download URL**.
- The webhook has **no `reply_to`, no `headers`, no `html`/`text`** and no auth results.
- Generic webhook fields (`broadcast_id`, `template_id`, `tags`) appear in the docs' field
  list but not in the received example or schema. Treat them as absent for inbound.

### 2.5 Fetch the content: `GET /emails/receiving/{email_id}`

```
GET https://api.resend.com/emails/receiving/4ef9a417-02e9-4d39-ad75-9611e0fcc33c?html_format=cid
Authorization: Bearer re_xxx      # full_access key
User-Agent: margin-comments/1.0
```

Query `html_format`: `data_uri` (default; inline images embedded as base64 `data:` URIs) or
`cid` (keeps `<img src="cid:...">`). HTML that would inline to more than 100 MB always comes
back as `cid`, so read `html_format` from the response.

Response example (docs, verbatim):

```json
{
  "object": "email",
  "id": "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
  "to": ["delivered@resend.dev"],
  "from": "onboarding@resend.dev",
  "created_at": "2026-04-03T22:13:42.674Z",
  "subject": "Hello World",
  "html": "Congrats on sending your <strong>first email</strong>!",
  "html_format": "data_uri",
  "text": null,
  "headers": {
    "from": "Acme <onboarding@resend.dev>",
    "return-path": "lucas.costa@resend.com",
    "mime-version": "1.0"
  },
  "bcc": [],
  "cc": [],
  "reply_to": [],
  "received_for": ["forwarded@example.com"],
  "authentication": {
    "spf": "pass",
    "dkim": "pass",
    "dmarc": "pass"
  },
  "message_id": "<111-222-333@email.example.com>",
  "raw": {
    "download_url": "https://example.resend.com/receiving/raw/054da427-439a-4e91-b785-e4fb1966285f?Signature=...",
    "expires_at": "2026-04-03T23:13:42.674Z"
  },
  "attachments": [
    {
      "id": "2a0c9ce0-3112-4728-976e-47ddcd16a318",
      "filename": "avatar.png",
      "content_type": "image/png",
      "content_disposition": "inline",
      "content_id": "img001",
      "size": 4096
    },
    {
      "id": "3b1d0df1-4223-5839-087f-54eedd27b419",
      "filename": "document.pdf",
      "content_type": "application/pdf",
      "content_disposition": null,
      "content_id": null,
      "size": 13264
    }
  ]
}
```

Field notes:
- `html`, `text`: `string | null`. Either can be null; the example has `text: null`.
- `headers`: `Record<string,string> | null`. The docs example uses **lowercase** keys.
  Resend's own chat adapter checks both `"In-Reply-To"` and `"in-reply-to"` (and
  `References`/`references`), with the comment "Normalize header keys to handle Resend's
  varying casing" (`resend-chat-sdk/src/adapter.ts`). **Lowercase all keys before lookup.**
  How repeated headers such as multiple `Received:` lines are represented is UNCONFIRMED.
- **`In-Reply-To` / `References`**: available only in `headers` from this endpoint, never
  in the webhook. The 2026-07-08 changelog: "when an inbound reply arrives, its headers
  reference the original Message-ID, so you can link the reply back to the exact email that
  started the thread."
- **`authentication`**: `{ spf, dkim, dmarc }`, each one of
  `'pass' | 'fail' | 'gray' | 'processing_failed' | 'unknown'`. "These come from the
  receiving mail server, not from the message headers, so the sender cannot forge them."
  It's `null` for emails received before the field existed.
  - `spf: gray` = none, softfail or neutral.
  - `dkim: gray` = unsigned, or the signing domain doesn't match the `From` domain.
  - `dmarc: gray` = SPF or DKIM passed, but the domain has no DMARC policy or uses `p=none`.
- **`Authentication-Results` header**: whether it's present in `headers` is UNCONFIRMED. Use
  `authentication` instead.
- `raw`: `{ download_url, expires_at } | null`. A signed URL to the original `.eml`,
  attachments included. It expires after about 1 h, judging by the example's timestamps.
- Not every field is in the published schemas yet. `authentication` and `html_format` are in
  the docs but **not** in OpenAPI v1.5.1 or resend-node 6.34.1's
  `GetReceivingEmailResponseSuccess`, where `raw` is optional. Parse defensively.
- Errors: 404 `not_found`; 401 `restricted_api_key` with a sending-only key; 403
  `email_above_quota` when the email arrived over quota.

### 2.6 Other receiving endpoints

- `GET /emails/receiving?limit=&after=&before=` lists received emails (cursor pagination;
  `after` and `before` are mutually exclusive). Response
  `{ object:"list", has_more, data:[{id,to,from,subject,message_id,bcc,cc,reply_to,created_at,attachments[]}] }`.
- `GET /emails/receiving/{email_id}/attachments` returns
  `{ object:"list", has_more, data:[{ id, filename, content_type, content_id, content_disposition, download_url, expires_at, size }] }`.
- `GET /emails/receiving/{email_id}/attachments/{attachment_id}` returns
  `{ object:"attachment", id, filename, content_type, content_id, content_disposition, download_url, expires_at, size }`.
- `download_url` is valid for **1 hour**; call the endpoint again for a fresh one
  (https://resend.com/docs/dashboard/receiving/attachments).
- Resend's chat adapter falls back to the webhook's `attachments` when the fetched email's
  list is empty ("the fetched email may not include them").

### 2.7 Inboxes: an alternative to `email.received`

Resend also offers **Inboxes** (threads, labels, drafts; webhook `inbox.email.received`;
endpoints under `/inboxes/...`), with 3 inboxes free on every plan. They're a separate
product from domain-level receiving. They thread automatically, but each inbox is a single
fixed address, so they don't support a per-user, per-thread signed reply-to. For this
project, plain domain receiving with `email.received` fits better
(https://resend.com/docs/dashboard/inboxes/introduction).

---

## 3. Webhook security (Svix)

Sources: https://resend.com/docs/webhooks/verify-webhooks-requests ·
https://docs.svix.com/receiving/verifying-payloads/how-manual ·
https://resend.com/docs/webhooks/retries-and-replays ·
https://resend.com/docs/webhooks/create-webhook ·
https://resend.com/docs/api-reference/webhooks/rotate-signing-secret ·
Standard Webhooks JS source (`standard-webhooks/libraries/javascript/src/index.ts`), which
`svix` and `resend`'s `webhooks.verify()` both wrap.

### 3.1 Headers and secret

- `svix-id`: unique message id (e.g. `msg_p5jXN8AQM9LWM0D4loKWxJek`). It **stays the same on
  retries** of one message, so use it as the dedup key. It matches the event `id` in
  `GET /webhooks/{id}/events`.
- `svix-timestamp`: Unix **seconds**, as a string.
- `svix-signature`: **space-delimited** list of `version,base64sig`, e.g.
  `v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=`. Several entries can appear, for
  example during secret rotation.
- Signing secret format: `whsec_<base64>`. It's shown on the webhook details page and
  returned as `signing_secret` by `POST /webhooks`, `GET /webhooks/{id}` and
  `GET /webhooks`.
- Rotation: `POST /webhooks/{webhook_id}/signing-secret/rotate` returns the new
  `signing_secret`. **For 24 h after rotation, payloads are signed with both the old and new
  secret.** That's one reason to check every signature in the header.

### 3.2 Algorithm

1. Read the **raw** request body as a string. Don't parse and re-serialize the JSON.
2. `signedContent = svix_id + "." + svix_timestamp + "." + rawBody`.
3. `key = base64decode(secret.slice("whsec_".length))`.
4. `expected = base64( HMAC_SHA256(key, signedContent) )`.
5. Split `svix-signature` on spaces. For each `v1,<sig>`, compare `<sig>` to `expected` in
   **constant time**. Ignore other versions. Accept if any entry matches.
6. Timestamp tolerance: reject if `|now - svix_timestamp| > 300 s`. The libraries use
   `WEBHOOK_TOLERANCE_IN_SECONDS = 5 * 60`, failing with "too old" if
   `now - ts > 300` and "too new" if `ts > now + 300`.

Test vector from Svix: secret `whsec_plJ3nmyCDGBKInavdOK15jsl`, id `msg_loFOjxBNrRLzqYUf`,
timestamp `1731705121`, body `{"event_type":"ping","data":{"success":true}}` gives
`v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=`. The snippet below reproduces this
exactly; I ran it on Node 26.

### 3.3 Minimal TypeScript verification (`node:crypto`)

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

const TOLERANCE_SECONDS = 5 * 60; // same as the svix / standardwebhooks libraries

export class WebhookVerificationError extends Error {}

export function signResendWebhook(secret: string, id: string, timestamp: string, rawBody: string): string {
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64');
  return `v1,${sig}`;
}

/** Throws on failure; returns the parsed event on success. */
export function verifyResendWebhook(
  rawBody: string, // exact request body (UTF-8). Do NOT JSON.parse + re-stringify.
  headers: Record<string, string | string[] | undefined>, // e.g. req.headers (Node lowercases names)
  secret: string, // "whsec_..."
  nowSeconds: number = Math.floor(Date.now() / 1000),
): unknown {
  const h = (n: string) => { const v = headers[n]; return Array.isArray(v) ? v[0] : v; };
  const id = h('svix-id'), timestamp = h('svix-timestamp'), signatureHeader = h('svix-signature');
  if (!id || !timestamp || !signatureHeader) throw new WebhookVerificationError('Missing required headers');

  const ts = Number.parseInt(timestamp, 10);
  if (Number.isNaN(ts)) throw new WebhookVerificationError('Invalid timestamp');
  if (nowSeconds - ts > TOLERANCE_SECONDS) throw new WebhookVerificationError('Message timestamp too old');
  if (ts > nowSeconds + TOLERANCE_SECONDS) throw new WebhookVerificationError('Message timestamp too new');

  const expected = Buffer.from(signResendWebhook(secret, id, timestamp, rawBody).slice(3), 'utf8');
  for (const versioned of signatureHeader.split(' ')) {
    const [version, sig] = versioned.split(',');
    if (version !== 'v1' || !sig) continue;
    const given = Buffer.from(sig, 'utf8');
    if (given.length === expected.length && timingSafeEqual(given, expected)) return JSON.parse(rawBody);
  }
  throw new WebhookVerificationError('No matching signature found');
}
```

`signResendWebhook` also serves the local fake: it signs fake `email.received` posts the
same way Resend does.

SDK alternative (resend-node 6.34.1): `resend.webhooks.verify({ payload: rawBody, headers:
{ id, timestamp, signature }, webhookSecret })`. It wraps `standardwebhooks` and throws on
failure. Note the property names are `id`/`timestamp`/`signature` and `webhookSecret`.

### 3.4 Delivery, retries, failures

- Success = HTTP 200. The Resend FAQ says "If Resend does not receive a 200 response ... we
  will retry". Svix's docs say any `2xx` within **30 s** counts and **3xx redirects count as
  failures**. Respond 2xx quickly and do the work afterwards (or make it fast and
  idempotent).
- Retry schedule, each delay counted from the previous failure: **immediately, 5 s, 5 min,
  30 min, 2 h, 5 h, 10 h, 10 h**. Three failures before success means delivery about 35 min
  5 s after the first attempt.
- Endpoints that keep failing are **disabled automatically** and the team gets an email.
  Re-enable from the Webhooks page. (Svix's general rule is about 5 days of failures; Resend
  doesn't state its threshold, so it's UNCONFIRMED.)
- Which statuses count as failures: anything that isn't a success, including 4xx. A 400
  for a bad signature will be retried on the full schedule. That's harmless, since forged
  requests stay invalid.
- Svix stops retrying when the response carries `webhook-delivery: abort-message`
  (https://docs.svix.com/receiving/delivery-control). Whether Resend's deployment honors it
  is UNCONFIRMED.
- **At-least-once** delivery: dedupe on `svix-id`. **Ordering is not guaranteed**.
- Manual replay of failed or succeeded events works from the dashboard or through
  `POST /webhooks/{webhook_id}/events/{event_id}/replay`. Inspect deliveries with
  `GET /webhooks/{webhook_id}/events/{event_id}` (`status`:
  pending|attempting|success|failed, `next_attempt_at`, `payload`) and
  `/attempts` (`http_status_code`, `response`, `sent_at`).
- Source IPs, for allowlists: `44.228.126.217`, `50.112.21.217`, `52.24.126.164`,
  `54.148.139.208`, `2600:1f24:64:8000::/52`.

---

## 4. Domain setup and dashboard steps

Sources: https://resend.com/docs/add-a-domain ·
https://resend.com/docs/api-reference/domains/create-domain ·
https://resend.com/docs/guides/dns/cloudflare ·
https://resend.com/docs/dashboard/domains/manage-domains ·
https://resend.com/docs/dashboard/domains/custom-return-path ·
https://resend.com/docs/knowledge-base/how-do-i-avoid-conflicting-with-my-mx-records ·
https://resend.com/docs/dashboard/domains/dmarc · https://resend.com/docs/forge

### 4.1 DNS records

For a Resend domain `m.example.com` (a subdomain is recommended) with both sending and
receiving enabled. DNS UI names are relative to `example.com`.

| Purpose | Type | Name (FQDN) | Value | Priority |
|---|---|---|---|---|
| DKIM | TXT | `resend._domainkey.m.example.com` | `p=MIGfMA0G...` (unique per domain; copy from dashboard) | |
| SPF / Return-Path (bounces) | MX | `send.m.example.com` | `feedback-smtp.us-east-1.amazonses.com` (region-specific) | 10 |
| SPF | TXT | `send.m.example.com` | `v=spf1 include:amazonses.com ~all` | |
| Receiving | MX | `m.example.com` | as shown in dashboard: `receive.forge.rmta.net` / `receive-euw1.forge.rmta.net` / `inbound-smtp.us-east-1.amazonaws.com` | 10 (must be lowest on that name) |
| DMARC (recommended) | TXT | `_dmarc.m.example.com` (or `_dmarc.example.com`, which covers subdomains via `sp=`) | `v=DMARC1; p=none; rua=mailto:dmarc@example.com;` | |
| Click/open tracking (optional, leave off) | CNAME | `links.m.example.com` | `links1.resend-dns.com` | |

Variations to expect:
- **Domains created after August 2026 may get CNAME records for SPF/Return-Path instead of
  the MX+TXT pair.** There are two of them: the Return-Path subdomain and an `r`-prefixed
  sibling. With Return-Path `outbound` you'd add `outbound.<domain>` and
  `routbound.<domain>`. Both must verify for full status (`partially_verified` otherwise).
  A CNAME can't share a name with other records. **Always copy exactly what the Records
  tab shows.**
- **Resend Forge** (Resend's own infrastructure, us-east-1 only): activating it on an
  existing domain adds one CNAME for a new Return-Path subdomain (e.g. `mail.<domain>`) and,
  for receiving, swaps the MX to a `*.forge.rmta.net` host.
- Return-Path defaults to `send`. A custom one (`custom_return_path`) can only be set at
  creation time: ≤63 chars, starts with a letter, ends with a letter or digit, only letters,
  digits and hyphens.
- Cloudflare: records must be **DNS only** (gray cloud). Use only the relative name
  (`send`, not `send.example.com`). Give each MX a unique priority.
- Verification usually takes under 15 min and can take up to 72 h; after 72 h the status
  becomes `failed`. Statuses: `not_started`, `pending`, `verified`, `partially_verified`,
  `partially_failed`, `failed`, `temporary_failure`.
- Regions: `us-east-1` (default), `eu-west-1`, `sa-east-1`, `ap-northeast-1`.

### 4.2 Dashboard steps (what Alejo does)

1. **Create an account** at resend.com.
2. **Add the domain**: Domains → **Add Domain**. Enter a subdomain, e.g. `m.example.com`, and
   pick a region (us-east-1). Optionally set the Return-Path under Advanced options.
3. **Add DNS records** from the domain's **Records** tab at the DNS host (or use
   **Sign in to Cloudflare** / Domain Connect for auto-setup). Wait for **Verified**; if
   needed, click **Verify DNS Records** or **Restart verification**.
4. **Enable receiving**: on the domain details page, turn on the **Receiving** toggle. Add
   the MX record from the modal and click **I've added the record**. Wait until the receiving
   record shows verified.
5. **Create the API key**: API Keys → **Create API Key**. Give it a name (≤50 chars) and a
   permission:
   - `Full access`: create, delete, get and update any resource. **Needed** for
     `GET /emails/receiving/{id}`.
   - `Sending access`: can only send; optionally restricted to one domain.
   - The key (`re_...`) is shown **only once**. Either use one full-access key, or two keys:
     a sending key for `POST /emails` and a full-access key for inbound fetches.
6. **Create the webhook**: Webhooks → **Add Webhook**. Enter the public HTTPS URL (e.g.
   `https://<app>.fly.dev/webhooks/resend`), select the event **`email.received`**, and click
   **Add**. Open the webhook details page to copy the **Signing Secret** (`whsec_...`).
7. Set the secrets: `RESEND_API_KEY=re_...`, `RESEND_WEBHOOK_SECRET=whsec_...`,
   `EMAIL_DOMAIN=m.example.com`.
8. Optional: add the DMARC TXT record.

API equivalents (all need a full-access key):
- `POST /domains` with
  `{"name":"m.example.com","region":"us-east-1","capabilities":{"sending":"enabled","receiving":"enabled"}}`
  returns `{ id, name, status, records:[{record:"DKIM"|"SPF"|"Receiving"|"Tracking"|"TrackingCAA", name, type:"MX"|"TXT"|"CNAME"|"CAA", value, priority?, ttl, status}], region, capabilities, ... }`.
- `POST /domains/{id}/verify`.
- `PATCH /domains/{id}` with `{"capabilities":{"receiving":"enabled"}}`.
- `POST /api-keys` with
  `{"name":"...","permission":"full_access"|"sending_access","domain_id":"<optional>"}`
  returns `{ id, token }`.
- `POST /webhooks` with
  `{"endpoint":"https://.../webhooks/resend","events":["email.received"]}` returns
  `{ object:"webhook", id, signing_secret:"whsec_..." }`.

---

## 5. Gotchas

1. **Recipients**: `to` max 50. Limits for `cc`/`bcc` are undocumented (UNCONFIRMED).
   Every recipient counts against quota, so send one email per recipient for notifications.
2. **Custom headers** (`headers` object, string values):
   - Documented for `POST /emails`: `X-Entity-Ref-ID` (stops Gmail threading),
     `List-Unsubscribe`, and **`In-Reply-To` / `References`**. The reply-to-emails guide sets
     both on `POST /emails` (https://resend.com/docs/dashboard/receiving/reply-to-emails).
   - `List-Unsubscribe-Post` isn't mentioned (UNCONFIRMED, but no restriction is
     documented).
   - **`Message-ID`: no doc says it can be set.** Resend generates it and exposes it after
     sending (`email.sent` webhook, `GET /emails/{id}`). Whether a custom `Message-ID` in
     `headers` is accepted, ignored or rejected is UNCONFIRMED. **Don't depend on it.**
     Thread replies by the signed `reply_to` address instead.
   - The **Inboxes** reply, forward and draft endpoints reject `In-Reply-To`, `References`
     and `Reply-To` in `headers`, in any case, with 422. That rule is specific to Inboxes,
     not to `POST /emails`.
3. **Reply-to tokens and plus-addressing**: plus-addressing on receiving domains isn't
   documented. Receiving is a catch-all for any local part, so a distinct local part like
   `r-<token>@m.example.com` needs no `+`. Whether `+tag` survives intact in `to` is
   UNCONFIRMED. Recommendations, which are general email practice rather than Resend docs:
   - No `+`.
   - Lowercase-safe alphabet (base32 or hex), since some agents change case.
   - Local part ≤64 chars (RFC 5321).
   - Match the token against `to`, `cc` **and** `received_for`.
   - Whether `reply_to` must be on a verified domain is undocumented (UNCONFIRMED). Putting
     it on the same verified receiving domain sidesteps the question.
4. **Forwarded mail**: `to` reflects the `To:` header, and `received_for` holds the actual
   envelope recipient(s). A May 2026 status-page incident briefly changed `to` for
   server-side-forwarded inbound mail; it was reverted. Check both fields.
5. **Sender verification**: `data.from` is a bare address and is spoofable. Accept a reply
   only if (a) the signed token's user matches the `from` address, and (b) `authentication`
   from the retrieve endpoint shows `dmarc === "pass"`, or at least `spf`/`dkim` pass. A
   `null` `authentication` should be treated as unverified.
6. **Body handling**: `text` or `html` can be `null`. Prefer `text`; fall back to HTML-to-text.
   Quoted history and signatures are **not** stripped by Resend.
7. **Header casing** in the received `headers` object varies; normalize keys to lowercase.
8. **Size limits**: outbound max 40 MB per email after base64 (Inboxes: 25 MB of inline
   `content`). Inbound max size is undocumented (UNCONFIRMED). Inbound HTML over 100 MB once
   inlined is returned in `cid` format.
9. **Sending from `onboarding@resend.dev`** only reaches your own account address (403
   otherwise). `from` must be on a verified domain (403 "domain is not verified"). Test
   recipients: `delivered@resend.dev`, `bounced@resend.dev`, `complained@resend.dev`,
   `suppressed@resend.dev` (all accept `+label`).
10. **Quota**: inbound emails count against the same daily and monthly quota. On the free
    plan that's 100/day total.
11. **Retention**: emails are kept for 30 days, so fetch the inbound content promptly.
12. **Schema lag**: the docs are ahead of OpenAPI and the SDK types (`authentication`,
    `html_format`). Code against the docs and tolerate missing fields.
13. **Webhook body parsing**: frameworks that parse JSON before your handler break the
    signature. Capture the raw body, e.g. `express.raw({ type: 'application/json' })`, or
    `c.req.text()` in Hono, before parsing.
14. **No webhook for "sent Message-ID" ordering**: `email.sent` can arrive after the
    recipient has already replied, since ordering isn't guaranteed. Another reason to thread
    by reply-to token rather than by Message-ID.

---

## 6. Fake-server contract (what a local fake should mimic)

- `POST /emails`:
  - Require `Authorization: Bearer re_*` (401 `missing_api_key` otherwise).
  - Require `User-Agent` (403 otherwise).
  - Validate `from`/`to`/`subject`: 422 `missing_required_field` with
    `{"statusCode":422,"message":"Missing \`from\` field.","name":"missing_required_field"}`.
  - Reject more than 50 `to` addresses (422 `validation_error`; the exact status for this
    case is UNCONFIRMED).
  - Honor `Idempotency-Key` for 24 h: same body returns the same `{id}`, a different body
    returns 409 `invalid_idempotent_request`.
  - Return `200 {"id":"<uuid>"}`.
  - Optionally return 429 `rate_limit_exceeded` with `retry-after: 1`.
- Inbound: build the `email.received` JSON from §2.4. POST it to the app with `svix-id`
  (`msg_<random>`), `svix-timestamp` and `svix-signature` produced by `signResendWebhook`.
- `GET /emails/receiving/{id}`: return the §2.5 shape, with `headers` keys lowercased,
  `authentication` set, and `text`/`html` nullable. Without a full-access key, return
  401 `restricted_api_key`.
