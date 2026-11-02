import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vite-plus/test";
import { defineTestApp } from "convex-test";
import { defineSchema } from "convex/server";
import { v } from "convex/values";
import componentTest from "../test.js";
import {
  type DeliveryEvent,
  isUndeliverable,
  parseDeliveryEvents,
  recordDeliveryEvents,
  sendEmail,
  vEmail,
} from "./index.js";

const app = defineTestApp({
  schema: defineSchema({}),
  components: { cloudflareEmail: componentTest },
});
const { api, createTest } = app.defineModules({
  mail: {
    send: app.action({
      args: { email: vEmail },
      handler: (ctx, { email }) =>
        sendEmail(ctx, app.components.cloudflareEmail, {
          owner: "me",
          accountId: "account",
          apiToken: "secret-token",
          email,
          seal: (text) => `sealed:${text}`,
        }),
    }),
    receiveEvents: app.mutation({
      args: { events: v.array(v.any()) },
      handler: (ctx, { events }) =>
        recordDeliveryEvents(ctx, app.components.cloudflareEmail, {
          owner: "me",
          events: parseDeliveryEvents(events),
          seal: (text) => `sealed:${text}`,
        }),
    }),
    eventsOf: app.query({
      args: { emailId: v.string() },
      handler: (ctx, { emailId }) =>
        ctx.runQuery(app.components.cloudflareEmail.events.list, { emailId }),
    }),
    get: app.query({
      args: { emailId: v.string() },
      handler: (ctx, { emailId }) =>
        ctx.runQuery(app.components.cloudflareEmail.lib.get, { emailId }),
    }),
  },
});

const email = {
  from: "me@example.com",
  to: ["you@example.com"],
  subject: "Hi",
  text: "Hello",
  attachments: [
    {
      content: "AAAA",
      filename: "a.txt",
      type: "text/plain",
      disposition: "attachment" as const,
    },
  ],
};

describe("sendEmail", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("records a sent email, sealed and without its attachments", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          result: { message_id: "<a@b>", delivered: email.to },
        }),
      ),
    );
    const t = createTest();
    const { emailId, messageId, error } = await t.action(api.mail.send, {
      email,
    });
    expect(messageId).toBe("<a@b>");
    expect(error).toBeUndefined();

    const sent = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string);
    expect(sent.attachments).toHaveLength(1);
    const stored = await t.query(api.mail.get, { emailId });
    expect(stored?.status).toBe("sent");
    expect(stored?.payload.startsWith("sealed:")).toBe(true);
    expect(JSON.parse(stored!.payload.slice("sealed:".length))).toEqual({
      ...email,
      attachments: [],
    });
    expect(JSON.stringify(stored)).not.toContain("secret-token");
  });

  test("records a refused email with its error sealed", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: false, errors: [{ message: "no" }] }),
        {
          status: 400,
        },
      ),
    );
    const t = createTest();
    const { emailId, error } = await t.action(api.mail.send, { email });
    expect(error).toBe("no");
    const stored = await t.query(api.mail.get, { emailId });
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toBe("sealed:no");
  });
});

const event = (type: string, over: object = {}) => ({
  type: `cf.email.sending.message.${type}`,
  source: { type: "email.sending", zoneId: "z", domain: "example.com" },
  payload: {
    eventId: `event-${type}`,
    messageId: "<a@b>",
    recipient: "you@example.com",
    subject: "Hi",
    terminal: true,
    ...over,
  },
  metadata: { eventTimestamp: "2026-06-01T02:48:57.132Z" },
});

describe("parseDeliveryEvents", () => {
  test("keeps Cloudflare's six kinds and leaves out anything else", () => {
    const kinds = [
      "delivered",
      "deferred",
      "bounced",
      "failed",
      "rejected",
      "complained",
    ];
    const known = kinds.map((kind) => event(kind));
    expect(
      parseDeliveryEvents([
        ...known,
        event("somethingNew"),
        { type: known[0]!.type, payload: { eventId: "no-ids" } },
        null,
        "text",
      ]),
    ).toEqual(known);
  });
});

describe("isUndeliverable", () => {
  const check = (e: object) => isUndeliverable(e as DeliveryEvent);
  test("is a complaint or a hard bounce, not a soft one", () => {
    expect(check(event("complained"))).toBe(true);
    expect(check(event("bounced", { bounce: { type: "hard" } }))).toBe(true);
    expect(check(event("bounced", { bounce: { type: "soft" } }))).toBe(false);
    expect(check(event("deferred"))).toBe(false);
    expect(check(event("delivered"))).toBe(false);
  });
});

describe("recordDeliveryEvents", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("links events to the email sendEmail recorded, sealed", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: true, result: { message_id: "<a@b>" } }),
      ),
    );
    const t = createTest();
    const { emailId } = await t.action(api.mail.send, { email });
    const [result] = await t.mutation(api.mail.receiveEvents, {
      events: [event("bounced", { bounce: { type: "hard" } })],
    });
    expect(result).toMatchObject({ isNew: true, emailId });
    expect(isUndeliverable(result!.event)).toBe(true);

    expect((await t.query(api.mail.get, { emailId }))?.delivery).toBe(
      "bounced",
    );
    const [stored] = await t.query(api.mail.eventsOf, { emailId });
    expect(stored?.status).toBe("bounced");
    expect(stored?.at).toBe(Date.parse("2026-06-01T02:48:57.132Z"));
    expect(stored?.payload.startsWith("sealed:")).toBe(true);
    expect(JSON.parse(stored!.payload.slice(7)).recipient).toBe(
      "you@example.com",
    );
  });
});
