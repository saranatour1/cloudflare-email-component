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
// By reference, so the component sees new values as soon as they're set. The prefix
// serves its routes at /email/inbound and /email/events.
app.use(cloudflareEmail, {
  httpPrefix: "/email/",
  env: {
    CLOUDFLARE_ACCOUNT_ID: app.env.CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_API_TOKEN: app.env.CLOUDFLARE_API_TOKEN,
    INBOUND_SECRET: app.env.INBOUND_SECRET,
    EVENTS_SECRET: app.env.EVENTS_SECRET,
  },
});

export default app;
