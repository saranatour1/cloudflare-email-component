import { v } from "convex/values";
import { internalMutation } from "./_generated/server.js";

// Convex Auth keeps accounts and passwords in its components, and the app keeps the users.
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
