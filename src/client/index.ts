import type { GenericActionCtx, GenericDataModel } from "convex/server";
import type { Infer } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import { vEmail } from "../component/schema.js";

export * from "./cloudflare.js";
export { vEmail };

export type Email = Infer<typeof vEmail>;

type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runMutation" | "runAction"
>;

/**
 * Queues, sends and records one email. `seal` turns what gets stored into the
 * opaque string the component keeps, so encrypt there, or pass `(text) => text`
 * to store it as plain text. It sees the email and any error, never the token.
 * A send that dies midway is marked failed by the component 15 minutes later.
 */
export async function sendEmail(
  ctx: ActionCtx,
  component: ComponentApi,
  args: {
    owner: string;
    accountId: string;
    apiToken: string;
    email: Email;
    seal: (text: string) => string | Promise<string>;
  },
) {
  const { owner, accountId, apiToken, email, seal } = args;
  const emailId = await ctx.runMutation(component.lib.queue, {
    owner,
    // Attachments stay out, they'd run into the document size limit.
    payload: await seal(JSON.stringify({ ...email, attachments: [] })),
  });
  const { messageId, error } = await ctx.runAction(component.lib.send, {
    accountId,
    apiToken,
    email,
  });
  await ctx.runMutation(component.lib.markResult, {
    emailId,
    failed: error !== undefined,
    error: error && (await seal(error)),
  });
  return { emailId, messageId, error };
}
