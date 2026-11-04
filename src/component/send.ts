import type { Infer } from "convex/values";
import type { BodyResponse, vEmail } from "./validators";

const retryWaitsMs = [1000, 3000];
const maxRecipients = 50;

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

    // 429 and 503 mean it never went out.
    for (const wait of retryWaitsMs) {
      if (res.status !== 429 && res.status !== 503) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
      res = await post();
    }

    const body = (await res.json().catch(() => null)) as BodyResponse;

    if (!res.ok || !body?.success)
      return {
        error:
          body?.errors?.map((e) => e.message).join("; ") ||
          `HTTP ${res.status}`,
      };

    const r = body.result ?? {};
    const outcome = {
      delivered: r.delivered,
      queued: r.queued,
      permanentBounces: r.permanent_bounces,
      suppressed: r.suppressed_recipients,
    };
    // Cloudflare can say success while refusing every address.
    const dropped = [
      ...(r.permanent_bounces ?? []),
      ...(r.suppressed_recipients ?? []),
    ];
    const accepted = r.delivered?.length || r.queued?.length;
    return dropped.length && !accepted
      ? { ...outcome, error: `Not delivered to ${dropped.join(", ")}` }
      : { ...outcome, messageId: r.message_id };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
};
