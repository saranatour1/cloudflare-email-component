import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vite-plus/test";
import { api, components, internal } from "./_generated/api";
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

// A user who signed up with this email, as Convex Auth's token names them.
const signIn = async (
  t: ReturnType<typeof initConvexTest>,
  email = "me@example.com",
) => {
  const userId = await t.run((ctx) => ctx.db.insert("users", {}));
  await t.mutation(components.authUsername.public.setUsername, {
    userId,
    username: email,
  });
  return t.withIdentity({ subject: userId });
};

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
    vi.stubEnv("INBOX_USERS", "me@example.com");
    const as = await signIn(t);
    expect(await as.query(api.mail.deliveries, { emailId })).toMatchObject([
      { status: "delivered", recipient: "you@example.com" },
      { status: "bounced", recipient: "you@example.com" },
    ]);
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
    beforeEach(() => vi.stubEnv("INBOX_USERS", "Me@example.com, other@x.com"));
    const receive = (t: ReturnType<typeof initConvexTest>, raw: string) =>
      receiveRaw(t, raw, {
        envelopeFrom: "bounce-123@mailer.example.com",
        envelopeTo: "Support@example.com",
      });
    const page = { numItems: 50, cursor: null };
    const threadsOf = async (
      as: Awaited<ReturnType<typeof signIn>>,
      view: "inbox" | "sent" | "archive" | "trash" = "inbox",
    ) => {
      const { page: threads } = await as.query(api.mail.threads, {
        view,
        paginationOpts: page,
      });
      return Promise.all(
        threads.map(
          async (t) => (await as.query(api.mail.thread, { threadId: t._id }))!,
        ),
      );
    };
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

    test("turns away anyone not signed in, or not on INBOX_USERS", async () => {
      const t = initConvexTest();
      const args = { view: "inbox" as const, paginationOpts: page };
      await expect(t.query(api.mail.threads, args)).rejects.toThrow(
        "Not on INBOX_USERS",
      );
      const stranger = await signIn(t, "stranger@example.com");
      expect(await stranger.query(api.mail.me)).toBeNull();
      await expect(stranger.query(api.mail.threads, args)).rejects.toThrow(
        "Not on INBOX_USERS",
      );
      await expect(
        stranger.action(api.mail.compose, {
          from: "support@example.com",
          to: ["a@b.c"],
          subject: "Hi",
          text: "Hi",
        }),
      ).rejects.toThrow("Not on INBOX_USERS");
      const me = await signIn(t, "me@EXAMPLE.com");
      expect(await me.query(api.mail.me)).toBe("me@EXAMPLE.com");
    });

    test("parses mail into the inbox it came in on, attachments and all", async () => {
      const t = initConvexTest();
      expect(await receive(t, first)).toBe("accept");
      const as = await signIn(t);
      expect(await as.query(api.mail.inboxes)).toEqual(["support@example.com"]);
      const [thread] = await threadsOf(as);
      expect(thread).toMatchObject({
        inbox: "support@example.com",
        subject: "Café",
        with: "Them",
        unread: true,
        folder: "inbox",
      });
      const [message] = thread.messages;
      expect(message).toMatchObject({
        from: "them@example.org",
        fromName: "Them",
        replyTo: ["desk@example.org"],
        text: expect.stringContaining("Hello there"),
        attachments: [
          { filename: "a.pdf", contentType: "application/pdf", size: 16 },
        ],
      });
      const text = await t.run(async (ctx) =>
        (await ctx.storage.get(message.attachments[0].storageId))!.text(),
      );
      expect(text).toBe("not really a pdf");
    });

    test("makes text out of mail that's only HTML", async () => {
      const t = initConvexTest();
      await receive(
        t,
        'Content-Type: text/html\r\n\r\n<style>p{}</style><script>bad()</script><p>One <b onclick="x">two</b></p>Three',
      );
      const [thread] = await threadsOf(await signIn(t));
      expect(thread.messages[0].text).toBe("One two\nThree");
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
      const [thread] = await threadsOf(await signIn(t));
      expect(thread.messages[0].text).toContain("Café");
    });

    test("a reply threads with the mail, and their answer joins it", async () => {
      const sent = cloudflareSays();
      const t = initConvexTest();
      await receive(t, first);
      const as = await signIn(t);
      const [{ messages }] = await threadsOf(as);

      const { error } = await as.action(api.mail.reply, {
        emailId: messages[0].id,
        text: "Hi back",
      });
      expect(error).toBeUndefined();
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

      // Only In-Reply-To, as some mail clients send.
      await receive(
        t,
        [
          "From: them@example.org",
          "Subject: Re: Café",
          "Message-ID: <third@example.org>",
          "In-Reply-To: <ours@example.com>",
          "",
          "And again",
        ].join("\r\n"),
      );
      await receive(t, "From: other@example.org\r\nSubject: New\r\n\r\nHi");

      const threads = await threadsOf(as);
      expect(threads).toHaveLength(2);
      const thread = threads.find((th) => th.subject === "Café")!;
      expect(thread.messages.map((m) => m.direction)).toEqual([
        "inbound",
        "outbound",
        "inbound",
      ]);
      expect(thread).toMatchObject({ sent: true, snippet: "And again" });
      expect(await threadsOf(as, "sent")).toHaveLength(1);

      await as.action(api.mail.reply, {
        emailId: thread.messages[2].id,
        text: "Last one",
      });
      expect(sent()).toMatchObject({
        subject: "Re: Café",
        to: ["them@example.org"],
        headers: {
          "In-Reply-To": "<third@example.org>",
          References: "<third@example.org>",
        },
      });
    });

    test("retrying a failed reply stays in the thread", async () => {
      const sent = cloudflareSays();
      const t = initConvexTest();
      await receive(t, first);
      const as = await signIn(t);
      const [{ messages }] = await threadsOf(as);
      vi.mocked(fetch).mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: false, errors: [{ message: "No" }] }),
          { status: 400 },
        ),
      );
      const failed = await as.action(api.mail.reply, {
        emailId: messages[0].id,
        text: "Hi",
      });
      expect(failed.error).toBe("No");

      const [thread] = await threadsOf(as);
      expect(thread.messages).toHaveLength(2);
      expect(thread.messages[1]).toMatchObject({ status: "failed" });
      await as.action(api.mail.reply, {
        emailId: thread.messages[1].id,
        text: "Hi again",
      });
      expect(sent()).toMatchObject({
        to: ["desk@example.org"],
        subject: "Re: Café",
        headers: {
          "In-Reply-To": "<first@example.org>",
          References: "<first@example.org>",
        },
      });
      expect((await threadsOf(as))[0].messages).toHaveLength(3);
    });

    test("a long thread still fits in Cloudflare's header limit", async () => {
      const sent = cloudflareSays();
      const t = initConvexTest();
      const ids = Array.from({ length: 30 }, (_, i) => `<m${i}@example.org>`);
      await receive(
        t,
        `From: them@example.org\r\nSubject: Long\r\nMessage-ID: <last@example.org>\r\nReferences: ${ids.join(" ")}\r\n\r\nHi`,
      );
      const as = await signIn(t);
      const [{ messages }] = await threadsOf(as);
      await as.action(api.mail.reply, { emailId: messages[0].id, text: "Hi" });
      const references = sent().headers.References.split(" ");
      expect(references).toHaveLength(10);
      expect(references[0]).toBe("<m0@example.org>");
      expect(references.at(-1)).toBe("<last@example.org>");
    });

    test("won't take an empty reply", async () => {
      const t = initConvexTest();
      await receive(t, first);
      const as = await signIn(t);
      const [{ messages }] = await threadsOf(as);
      await expect(
        as.action(api.mail.reply, { emailId: messages[0].id, text: "  " }),
      ).rejects.toThrow("Write something");
      expect((await threadsOf(as))[0].messages).toHaveLength(1);
    });

    test("read, archive and trash, and an answer brings an archived thread back", async () => {
      const t = initConvexTest();
      await receive(t, first);
      const as = await signIn(t);
      const [{ _id: threadId }] = await threadsOf(as);
      await as.mutation(api.mail.setUnread, { threadId, unread: false });
      await as.mutation(api.mail.move, { threadId, folder: "archive" });
      expect(await threadsOf(as)).toEqual([]);
      expect(await threadsOf(as, "archive")).toMatchObject([{ unread: false }]);

      await receive(
        t,
        "From: them@example.org\r\nIn-Reply-To: <first@example.org>\r\n\r\nAnd?",
      );
      expect(await threadsOf(as)).toMatchObject([
        { _id: threadId, unread: true, snippet: "And?" },
      ]);

      await as.mutation(api.mail.move, { threadId, folder: "trash" });
      await receive(
        t,
        "From: them@example.org\r\nIn-Reply-To: <first@example.org>\r\n\r\nHello?",
      );
      expect(await threadsOf(as)).toEqual([]);
      expect(await threadsOf(as, "trash")).toHaveLength(1);
    });

    test("new mail waits under Sent until they answer", async () => {
      const sent = cloudflareSays();
      const t = initConvexTest();
      const as = await signIn(t);
      const { threadId } = await as.action(api.mail.compose, {
        from: "Support@example.com",
        to: ["them@example.org"],
        subject: "Hello",
        text: "First",
      });
      expect(sent()).toMatchObject({
        from: "Support@example.com",
        to: ["them@example.org"],
      });
      expect(await threadsOf(as)).toEqual([]);
      expect(await threadsOf(as, "sent")).toMatchObject([
        { _id: threadId, with: "them@example.org", folder: "archive" },
      ]);
      await receive(
        t,
        "From: them@example.org\r\nIn-Reply-To: <ours@example.com>\r\n\r\nHi!",
      );
      expect(await threadsOf(as)).toMatchObject([{ _id: threadId }]);
    });

    test("sends attachments from storage and keeps them with the message", async () => {
      const sent = cloudflareSays();
      const t = initConvexTest();
      await receive(t, first);
      const as = await signIn(t);
      const storageId = await t.run((ctx) =>
        ctx.storage.store(new Blob(["hello file"], { type: "text/plain" })),
      );
      const [{ messages }] = await threadsOf(as);
      await as.action(api.mail.reply, {
        emailId: messages[0].id,
        text: "See attached",
        attachments: [
          { storageId, filename: "a.txt", contentType: "text/plain" },
        ],
      });
      expect(sent().attachments).toEqual([
        {
          content: btoa("hello file"),
          filename: "a.txt",
          type: "text/plain",
          disposition: "attachment",
        },
      ]);
      const [thread] = await threadsOf(as);
      expect(thread.messages[1].attachments).toMatchObject([
        { filename: "a.txt", size: 10, storageId },
      ]);
    });

    test("won't send more than 10 MB of attachments", async () => {
      cloudflareSays();
      const t = initConvexTest();
      const as = await signIn(t);
      const storageId = await t.run((ctx) =>
        ctx.storage.store(new Blob([new Uint8Array(10 * 1024 * 1024 + 1)])),
      );
      await expect(
        as.action(api.mail.compose, {
          from: "support@example.com",
          to: ["them@example.org"],
          subject: "Big",
          text: "Too big",
          attachments: [{ storageId, filename: "big.bin", contentType: "" }],
        }),
      ).rejects.toThrow("10 MB");
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    test("counts unread conversations in the Inbox", async () => {
      const t = initConvexTest();
      await receive(t, first);
      await receive(t, "From: other@example.org\r\nSubject: New\r\n\r\nHi");
      const as = await signIn(t);
      expect(await as.query(api.mail.unreadCount)).toBe(2);
      const [a, b] = await threadsOf(as);
      await as.mutation(api.mail.setUnread, { threadId: a._id, unread: false });
      expect(await as.query(api.mail.unreadCount)).toBe(1);
      await as.mutation(api.mail.move, { threadId: b._id, folder: "archive" });
      expect(await as.query(api.mail.unreadCount)).toBe(0);
    });

    test("backfill files mail from before the index, once", async () => {
      const t = initConvexTest();
      await t.mutation(components.cloudflareEmail.lib.receive, {
        owner: "example",
        payload: JSON.stringify({
          from: "a@b.c",
          to: "support@example.com",
          text: "Old",
        }),
      });
      await t.mutation(components.cloudflareEmail.lib.receive, {
        owner: "someone-else",
        payload: "{}",
      });
      await t.action(internal.mail.backfill, {});
      await t.action(internal.mail.backfill, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const threads = await threadsOf(await signIn(t));
      expect(threads).toHaveLength(1);
      expect(threads[0].messages).toHaveLength(1);
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
