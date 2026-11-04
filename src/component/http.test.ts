/// <reference types="vite/client" />
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vite-plus/test";
import { createFunctionHandle, makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { api } from "./_generated/api.js";
import { internalAction } from "./_generated/server.js";
import { initConvexTest } from "./setup.test.js";

// Stand-ins for the app's handlers. The component tests run it as the app, so these
// load as functions of this module.
const calls: unknown[] = [];
export const receive = internalAction({
  args: {
    raw: v.bytes(),
    envelopeFrom: v.optional(v.string()),
    envelopeTo: v.optional(v.string()),
  },
  returns: v.union(v.literal("accept"), v.literal("reject")),
  handler: async (_ctx, { raw, ...envelope }) => {
    const text = new TextDecoder().decode(raw);
    calls.push({ text, ...envelope });
    return text.includes("spam") ? "reject" : "accept";
  },
});
export const events = internalAction({
  args: { events: v.array(v.any()) },
  returns: v.null(),
  handler: async (_ctx, args) => {
    calls.push(args);
    return null;
  },
});

const handle = (t: ReturnType<typeof initConvexTest>, name: string) =>
  t.run(() =>
    createFunctionHandle(makeFunctionReference<"action">(`http.test:${name}`)),
  );

const post = (
  t: ReturnType<typeof initConvexTest>,
  path: string,
  secret: string,
  body: BodyInit,
  headers: Record<string, string> = {},
) =>
  t.fetch(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, ...headers },
    body,
  });

const sentEvent = {
  type: "cf.email.sending.message.delivered",
  payload: { eventId: "e1", messageId: "<a@b>", recipient: "you@example.com" },
};

describe("routes", () => {
  beforeEach(() => {
    calls.length = 0;
    vi.stubEnv("INBOUND_SECRET", "in-secret");
    vi.stubEnv("EVENTS_SECRET", "ev-secret");
  });
  afterEach(() => vi.unstubAllEnvs());

  test("take nothing without their own secret", async () => {
    const t = initConvexTest();
    await t.mutation(api.lib.setHandlers, {
      onReceive: await handle(t, "receive"),
      onEvents: await handle(t, "events"),
    });
    expect((await post(t, "/inbound", "ev-secret", "Hi")).status).toBe(401);
    expect((await post(t, "/events", "in-secret", "[]")).status).toBe(401);
    expect((await t.fetch("/inbound", { method: "POST" })).status).toBe(401);
    expect(calls).toEqual([]);
  });

  test("take nothing when the app hasn't bound a secret", async () => {
    vi.unstubAllEnvs();
    const t = initConvexTest();
    expect((await post(t, "/inbound", "", "Hi")).status).toBe(401);
  });

  test("ask to be tried again until the app sets its handlers", async () => {
    const t = initConvexTest();
    expect((await post(t, "/inbound", "in-secret", "Hi")).status).toBe(503);
    expect((await post(t, "/events", "ev-secret", "[]")).status).toBe(503);
  });

  test("hand inbound mail to the app, which can turn it away", async () => {
    const t = initConvexTest();
    await t.mutation(api.lib.setHandlers, {
      onReceive: await handle(t, "receive"),
    });
    const envelope = {
      "X-Envelope-From": "bounce@sender.example",
      "X-Envelope-To": "hi@example.com",
    };
    expect(
      (await post(t, "/inbound", "in-secret", "Subject: Hi", envelope)).status,
    ).toBe(204);
    expect(
      (await post(t, "/inbound", "in-secret", "Subject: spam", envelope))
        .status,
    ).toBe(403);
    expect(calls[0]).toEqual({
      text: "Subject: Hi",
      envelopeFrom: "bounce@sender.example",
      envelopeTo: "hi@example.com",
    });
  });

  test("hand the app only the delivery events it knows", async () => {
    const t = initConvexTest();
    await t.mutation(api.lib.setHandlers, {
      onEvents: await handle(t, "events"),
    });
    expect((await post(t, "/events", "ev-secret", "{}")).status).toBe(400);
    const body = JSON.stringify([sentEvent, { type: "something.new" }]);
    expect((await post(t, "/events", "ev-secret", body)).status).toBe(204);
    expect(calls).toEqual([{ events: [sentEvent] }]);
  });

  test("setting one handler keeps the other", async () => {
    const t = initConvexTest();
    await t.mutation(api.lib.setHandlers, {
      onReceive: await handle(t, "receive"),
    });
    await t.mutation(api.lib.setHandlers, {
      onEvents: await handle(t, "events"),
    });
    expect((await post(t, "/inbound", "in-secret", "Hi")).status).toBe(204);
    expect((await post(t, "/events", "ev-secret", "[]")).status).toBe(204);
  });
});
