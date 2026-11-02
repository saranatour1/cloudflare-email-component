import { defineApp } from "convex/server";
import { v } from "convex/values";
import cloudflareEmail from "@saranatour1/cloudflare-email-component/convex.config.js";

const app = defineApp({
  env: {
    CLOUDFLARE_ACCOUNT_ID: v.optional(v.string()),
    CLOUDFLARE_API_TOKEN: v.optional(v.string()),
    INBOUND_SECRET: v.optional(v.string()),
    EVENTS_SECRET: v.optional(v.string()),
  },
});
app.use(cloudflareEmail);

export default app;
