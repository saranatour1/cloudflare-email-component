import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vite-plus/test";
import { internal } from "./_generated/api";
import { initConvexTest } from "./setup.test";

const email = {
  from: "me@example.com",
  to: ["you@example.com"],
  subject: "Hi",
  text: "Hello",
};

describe("example", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "account");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "token");
    vi.stubEnv("INBOUND_SECRET", "secret");
    vi.stubEnv("EVENTS_SECRET", "events-secret");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test("sends through the installed component and lists the result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              success: true,
              result: { message_id: "<a@b>", delivered: email.to },
            }),
          ),
        ),
      ),
    );
    const t = initConvexTest();
    const { messageId } = await t.action(internal.example.send, { email });
    expect(messageId).toBe("<a@b>");
    const [sent] = await t.query(internal.example.list, {
      direction: "outbound",
    });
    expect(sent.status).toBe("sent");
  });

  test("won't send without the Cloudflare settings", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", undefined);
    await expect(
      initConvexTest().action(internal.example.send, { email }),
    ).rejects.toThrow("CLOUDFLARE_API_TOKEN");
  });

  test("keeps inbound mail only with the right secret", async () => {
    const t = initConvexTest();
    const post = (authorization?: string) =>
      t.fetch("/email/inbound", {
        method: "POST",
        headers: {
          ...(authorization && { Authorization: authorization }),
          "X-Envelope-From": "them@example.com",
          "X-Envelope-To": "me@example.com",
        },
        body: "Subject: Hi\r\n\r\nHello",
      });
    expect((await post()).status).toBe(401);
    expect((await post("Bearer wrong")).status).toBe(401);
    expect(
      await t.query(internal.example.list, { direction: "inbound" }),
    ).toEqual([]);

    expect((await post("Bearer secret")).status).toBe(204);
    const [received] = await t.query(internal.example.list, {
      direction: "inbound",
    });
    expect(received.status).toBe("received");
    expect(JSON.parse(received.payload).from).toBe("them@example.com");
  });

  test("takes delivery events only with the right secret, and only a list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ success: true, result: { message_id: "<a@b>" } }),
          ),
        ),
      ),
    );
    const t = initConvexTest();
    const { emailId } = await t.action(internal.example.send, { email });
    const post = (authorization: string, body: unknown) =>
      t.fetch("/email/events", {
        method: "POST",
        headers: { Authorization: authorization },
        body: JSON.stringify(body),
      });
    const delivered = {
      type: "cf.email.sending.message.delivered",
      payload: {
        eventId: "e1",
        messageId: "<a@b>",
        recipient: "you@example.com",
        terminal: true,
      },
    };

    expect((await post("Bearer secret", [delivered])).status).toBe(401);
    expect((await post("Bearer events-secret", { not: "a list" })).status).toBe(
      400,
    );
    expect(await t.query(internal.example.deliveryEvents, { emailId })).toEqual(
      [],
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await post("Bearer events-secret", [delivered])).status).toBe(204);
    const bounced = {
      type: "cf.email.sending.message.bounced",
      payload: {
        ...delivered.payload,
        eventId: "e2",
        bounce: { type: "hard" },
      },
    };
    expect((await post("Bearer events-secret", [bounced])).status).toBe(204);
    // Queues delivers at least once.
    expect((await post("Bearer events-secret", [bounced])).status).toBe(204);

    const events = await t.query(internal.example.deliveryEvents, { emailId });
    expect(events.map((e: { status: string }) => e.status)).toEqual([
      "delivered",
      "bounced",
    ]);
    expect(
      log.mock.calls.filter(([m]) => String(m).includes("e2")),
    ).toHaveLength(1);
    const [sent] = await t.query(internal.example.list, {
      direction: "outbound",
    });
    expect(sent.delivery).toBe("bounced");
    log.mockRestore();
  });

  test("turns away inbound mail too large to keep", async () => {
    const t = initConvexTest();
    const res = await t.fetch("/email/inbound", {
      method: "POST",
      headers: { Authorization: "Bearer secret" },
      body: "x".repeat(1024 * 1024),
    });
    expect(res.status).toBe(403);
    expect(
      await t.query(internal.example.list, { direction: "inbound" }),
    ).toEqual([]);
  });
});
