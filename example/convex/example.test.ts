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

const listOf = async (
  t: ReturnType<typeof initConvexTest>,
  direction: "inbound" | "outbound",
) =>
  (
    await t.query(internal.example.list, {
      direction,
      paginationOpts: { numItems: 50, cursor: null },
    })
  ).page;

const eventsOf = async (
  t: ReturnType<typeof initConvexTest>,
  emailId: string,
) =>
  (
    await t.query(internal.example.deliveryEvents, {
      emailId,
      paginationOpts: { numItems: 50, cursor: null },
    })
  ).page;

// What the component's /email/inbound route hands the app, after checking the secret.
const receiveRaw = (
  t: ReturnType<typeof initConvexTest>,
  raw: string | Uint8Array,
  envelope: { envelopeFrom?: string; envelopeTo?: string } = {},
) =>
  t.action(internal.inbox.receive, {
    raw: (typeof raw === "string" ? new TextEncoder().encode(raw) : raw).slice()
      .buffer,
    ...envelope,
  });

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
    const [sent] = await listOf(t, "outbound");
    expect(sent.status).toBe("sent");
  });

  test("won't send without the Cloudflare settings", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", undefined);
    const t = initConvexTest();
    const { error } = await t.action(internal.example.send, { email });
    expect(error).toMatch("CLOUDFLARE_API_TOKEN");
    const [failed] = await listOf(t, "outbound");
    expect(failed.status).toBe("failed");
  });

  test("keeps the inbound mail the component hands over", async () => {
    const t = initConvexTest();
    expect(
      await receiveRaw(t, "Subject: Hi\r\n\r\nHello", {
        envelopeFrom: "them@example.com",
        envelopeTo: "me@example.com",
      }),
    ).toBe("accept");
    const [received] = await listOf(t, "inbound");
    expect(received.status).toBe("received");
    expect(JSON.parse(received.payload)).toMatchObject({
      from: "them@example.com",
      subject: "Hi",
      text: expect.stringContaining("Hello"),
    });
  });

  test("records the delivery events the component hands over", async () => {
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
    const delivered = {
      type: "cf.email.sending.message.delivered",
      payload: {
        eventId: "e1",
        messageId: "<a@b>",
        recipient: "you@example.com",
        terminal: true,
      },
    };
    const bounced = {
      type: "cf.email.sending.message.bounced",
      payload: {
        ...delivered.payload,
        eventId: "e2",
        bounce: { type: "hard" },
      },
    };

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await t.action(internal.example.onEvents, { events: [delivered] });
    await t.action(internal.example.onEvents, { events: [bounced] });
    // Queues delivers at least once.
    await t.action(internal.example.onEvents, { events: [bounced] });

    const events = await eventsOf(t, emailId);
    expect(events.map((e: { status: string }) => e.status)).toEqual([
      "delivered",
      "bounced",
    ]);
    expect(
      log.mock.calls.filter(([m]) => String(m).includes("e2")),
    ).toHaveLength(1);
    const [sent] = await listOf(t, "outbound");
    expect(sent.delivery).toBe("bounced");
    log.mockRestore();
  });

  test("turns away inbound mail too large to keep", async () => {
    const t = initConvexTest();
    expect(
      await receiveRaw(t, `Subject: Hi\r\n\r\n${"x".repeat(1024 * 1024)}`),
    ).toBe("reject");
    expect(await listOf(t, "inbound")).toEqual([]);
  });

  describe("inbox", () => {
    const receive = (t: ReturnType<typeof initConvexTest>, raw: string) =>
      receiveRaw(t, raw, {
        envelopeFrom: "bounce-123@mailer.example.com",
        envelopeTo: "Support@example.com",
      });
    const threadsOf = async (t: ReturnType<typeof initConvexTest>) =>
      (await t.fetch("/inbox/threads")).json();
    const reply = (t: ReturnType<typeof initConvexTest>, body: unknown) =>
      t.fetch("/inbox/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const first = [
      "From: Them <them@example.org>",
      "Reply-To: desk@example.org",
      "Subject: =?UTF-8?B?Q2Fmw6k=?=",
      "Message-ID: <first@example.org>",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      btoa("Hello there"),
      "--b",
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="a.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      btoa("not really a pdf"),
      "--b--",
    ].join("\r\n");
    const cloudflareSays = () => {
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              success: true,
              result: { message_id: "<ours@example.com>", delivered: ["x"] },
            }),
          ),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      return () =>
        JSON.parse(
          (fetchMock.mock.lastCall as unknown as [string, RequestInit])[1]
            .body as string,
        );
    };

    test("the page runs only its own script", async () => {
      const res = await initConvexTest().fetch("/inbox");
      const [, nonce] = /script-src 'nonce-([^']+)'/.exec(
        res.headers.get("Content-Security-Policy")!,
      )!;
      expect(await res.text()).toContain(`<script nonce="${nonce}">`);
    });

    test("parses mail into the inbox it came in on", async () => {
      const t = initConvexTest();
      expect(await receive(t, first)).toBe("accept");
      const [[message]] = await threadsOf(t);
      expect(message).toMatchObject({
        inbox: "support@example.com",
        from: "them@example.org",
        fromName: "Them",
        replyTo: ["desk@example.org"],
        subject: "Café",
        text: expect.stringContaining("Hello there"),
        attachments: ["a.pdf"],
      });
    });

    test("makes text out of mail that's only HTML", async () => {
      const t = initConvexTest();
      await receive(
        t,
        'Content-Type: text/html\r\n\r\n<style>p{}</style><script>bad()</script><p>One <b onclick="x">two</b></p>Three',
      );
      const [[message]] = await threadsOf(t);
      expect(message.text).toBe("One two\nThree");
    });

    test("keeps a message's bytes when it isn't UTF-8", async () => {
      const t = initConvexTest();
      const body = new Uint8Array([
        ...new TextEncoder().encode(
          "Subject: Hi\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\nCaf",
        ),
        0xe9,
      ]);
      await receiveRaw(t, body, { envelopeTo: "support@example.com" });
      const [[message]] = await threadsOf(t);
      expect(message.text).toContain("Café");
    });

    test("a reply threads with the mail, and their answer joins it", async () => {
      const sent = cloudflareSays();
      const t = initConvexTest();
      await receive(t, first);
      const [[message]] = await threadsOf(t);

      const res = await reply(t, { emailId: message.id, text: "Hi back" });
      expect((await res.json()).messageId).toBe("<ours@example.com>");
      expect(sent()).toMatchObject({
        from: "support@example.com",
        to: ["desk@example.org"],
        subject: "Re: Café",
        text: "Hi back",
        headers: {
          "In-Reply-To": "<first@example.org>",
          References: "<first@example.org>",
        },
      });

      await receive(
        t,
        [
          "From: them@example.org",
          "Subject: Re: Café",
          "Message-ID: <third@example.org>",
          "In-Reply-To: <ours@example.com>",
          "References: <first@example.org> <ours@example.com>",
          "",
          "And again",
        ].join("\r\n"),
      );
      await receive(t, "From: other@example.org\r\nSubject: New\r\n\r\nHi");

      const threads = await threadsOf(t);
      expect(threads).toHaveLength(2);
      const thread = threads.find(
        (m: { subject: string }[]) => m[0].subject === "Café",
      );
      expect(thread.map((m: { direction: string }) => m.direction)).toEqual([
        "inbound",
        "outbound",
        "inbound",
      ]);

      await reply(t, { emailId: thread[2].id, text: "Last one" });
      expect(sent()).toMatchObject({
        subject: "Re: Café",
        to: ["them@example.org"],
        headers: {
          "In-Reply-To": "<third@example.org>",
          References:
            "<first@example.org> <ours@example.com> <third@example.org>",
        },
      });
    });

    test("retrying a failed reply stays in the thread", async () => {
      const sent = cloudflareSays();
      const t = initConvexTest();
      await receive(t, first);
      const [[message]] = await threadsOf(t);
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: false, errors: [{ message: "No" }] }),
          { status: 400 },
        ),
      );
      const failed = await reply(t, { emailId: message.id, text: "Hi" });
      expect((await failed.json()).error).toBe("No");

      const [thread] = await threadsOf(t);
      expect(thread).toHaveLength(2);
      expect(thread[1].status).toBe("failed");
      await reply(t, { emailId: thread[1].id, text: "Hi again" });
      expect(sent()).toMatchObject({
        to: ["desk@example.org"],
        subject: "Re: Café",
        headers: {
          "In-Reply-To": "<first@example.org>",
          References: "<first@example.org>",
        },
      });
    });

    test("a long thread still fits in Cloudflare's header limit", async () => {
      const sent = cloudflareSays();
      const t = initConvexTest();
      const ids = Array.from({ length: 30 }, (_, i) => `<m${i}@example.org>`);
      await receive(
        t,
        `From: them@example.org\r\nSubject: Long\r\nMessage-ID: <last@example.org>\r\nReferences: ${ids.join(" ")}\r\n\r\nHi`,
      );
      const [[message]] = await threadsOf(t);
      await reply(t, { emailId: message.id, text: "Hi" });
      const references = sent().headers.References.split(" ");
      expect(references).toHaveLength(10);
      expect(references[0]).toBe("<m0@example.org>");
      expect(references.at(-1)).toBe("<last@example.org>");
    });

    test("won't take an empty reply", async () => {
      const t = initConvexTest();
      await receive(t, first);
      const [[message]] = await threadsOf(t);
      const body = { emailId: message.id, text: "Hi" };
      expect((await reply(t, { ...body, text: "  " })).status).toBe(400);
      const threads = await threadsOf(t);
      expect(threads).toHaveLength(1);
      expect(threads[0]).toHaveLength(1);
    });

    test("setUpInbox routes each new address to one Worker", async () => {
      vi.stubEnv("CONVEX_SITE_URL", "https://app.example");
      const calls: [string, string | undefined][] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init?: RequestInit) => {
          calls.push([url, init?.method]);
          const result = url.endsWith("/email/routing")
            ? { enabled: true }
            : url.includes("rules?per_page")
              ? [
                  {
                    id: "old",
                    matchers: [{ type: "literal", value: "taken@example.com" }],
                    actions: [{ type: "forward", value: ["me@else.com"] }],
                  },
                ]
              : { id: "new" };
          return Promise.resolve(
            new Response(JSON.stringify({ success: true, result })),
          );
        }),
      );
      const result = await initConvexTest().action(internal.inbox.setUpInbox, {
        zoneId: "zone",
        addresses: ["support@example.com", "taken@example.com"],
      });
      expect(result).toEqual({
        worker: "email-inbox-example-com",
        rules: [
          { address: "support@example.com", id: "new" },
          {
            address: "taken@example.com",
            alreadyRouted: true,
            id: "old",
            forwardsTo: "me@else.com",
          },
        ],
      });
      expect(calls.filter(([, method]) => method === "PUT")).toHaveLength(1);
    });

    test("setUpInbox leaves turning on Email Routing to you", async () => {
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ success: true, result: { enabled: false } }),
          ),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      await expect(
        initConvexTest().action(internal.inbox.setUpInbox, {
          zoneId: "zone",
          addresses: ["support@example.com"],
        }),
      ).rejects.toThrow("Turn on Email Routing");
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  });
});
