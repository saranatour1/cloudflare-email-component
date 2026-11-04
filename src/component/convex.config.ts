import { defineComponent } from "convex/server";
import { v } from "convex/values";

// All optional, so an app can still pass credentials per call and skip the routes.
export default defineComponent("cloudflareEmail", {
  env: {
    CLOUDFLARE_ACCOUNT_ID: v.optional(v.string()),
    CLOUDFLARE_API_TOKEN: v.optional(v.string()),
    INBOUND_SECRET: v.optional(v.string()),
    EVENTS_SECRET: v.optional(v.string()),
  },
});
