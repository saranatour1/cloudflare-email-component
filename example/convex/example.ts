import { v } from "convex/values";
import { sendEmail, vEmail } from "@saranatour1/cloudflare-email-component";
import { components } from "./_generated/api.js";
import { env, internalAction, internalQuery } from "./_generated/server.js";

// Internal, so only the CLI, the dashboard or your own functions can call them.
// A public action here would be an open mail relay: authorize the caller first.
export const send = internalAction({
  args: { email: vEmail },
  handler: async (ctx, { email }) => {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !apiToken) {
      throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.");
    }
    return await sendEmail(ctx, components.cloudflareEmail, {
      owner: "example",
      accountId,
      apiToken,
      email,
      // shortcut: stored as plain text, encrypt here before sending real mail.
      seal: (text) => text,
    });
  },
});

export const list = internalQuery({
  args: { direction: v.union(v.literal("inbound"), v.literal("outbound")) },
  handler: async (ctx, { direction }) => {
    return await ctx.runQuery(components.cloudflareEmail.lib.list, {
      owner: "example",
      direction,
    });
  },
});
