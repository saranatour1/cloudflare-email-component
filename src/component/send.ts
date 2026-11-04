import type { Infer } from "convex/values";
import type { vEmail } from "./schema.js";

const retryWaitsMs = [1000, 3000];
const maxRecipients = 50;

// shortcut: retries only ride out a few seconds; schedule an app action with just the
// emailId, which reopens the sealed connection, if throttling lasts longer than that.
/** Sends through Cloudflare and says who got it, or why it failed. Stores nothing. */
export const sendThroughCloudflare = async ({
  accountId,
  apiToken,
  email: { replyTo, ...email },
}: {
  accountId: string;
  apiToken: string;
  email: Infer<typeof vEmail>;
}): Promise<{
  messageId?: string;
  error?: string;
  delivered?: string[];
  queued?: string[];
  permanentBounces?: string[];
  suppressed?: string[];
}> => {
  const recipients = [email.to, email.cc, email.bcc].flat().filter(Boolean);
  if (recipients.length === 0)
    return { error: "One of `to`, `cc` or `bcc` is required" };
  if (recipients.length > maxRecipients)
    return { error: `Cloudflare takes at most ${maxRecipients} recipients` };
  if (!email.text && !email.html)
    return { error: "One of `text` or `html` is required" };
  try {
    const post = () =>
      fetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/email/sending/send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ ...email, reply_to: replyTo }),
        },
      );
    let res = await post();
    // 429 and 503 mean it never went out. Anything else, a thrown fetch included, may
    // have, and Cloudflare takes no idempotency key, so a retry could send it twice.
    for (const wait of retryWaitsMs) {
      if (res.status !== 429 && res.status !== 503) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
      res = await post();
    }
    const body = (await res.json().catch(() => null)) as {
      success?: boolean;
      errors?: { message: string }[];
      result?: {
        message_id?: string;
        delivered?: string[];
        queued?: string[];
        permanent_bounces?: string[];
        suppressed_recipients?: string[];
      };
    } | null;
    if (!res.ok || !body?.success)
      return {
        error:
          body?.errors?.map((e) => e.message).join("; ") ||
          `HTTP ${res.status}`,
      };
    const {
      message_id: messageId,
      delivered,
      queued,
      permanent_bounces: permanentBounces,
      suppressed_recipients: suppressed,
    } = body.result ?? {};
    const outcome = { delivered, queued, permanentBounces, suppressed };
    // Cloudflare can say success while refusing every address.
    const dropped = [...(permanentBounces ?? []), ...(suppressed ?? [])];
    if (dropped.length && !delivered?.length && !queued?.length)
      return { ...outcome, error: `Not delivered to ${dropped.join(", ")}` };
    return { ...outcome, messageId };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};
