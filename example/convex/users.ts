import { v } from "convex/values";
import { internalMutation } from "./_generated/server.js";

export const create = internalMutation({
  args: {
    provider: v.object({
      name: v.literal("password"),
      accountId: v.string(),
      profile: v.object({}),
    }),
  },
  returns: v.id("users"),
  handler: (ctx) => ctx.db.insert("users", {}),
});
