/// <reference types="vite/client" />
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

const email = {
  from: "me@example.com",
  to: ["you@example.com"],
  subject: "Hi",
  text: "Hello",
};
const args = { accountId: "account", apiToken: "token", email };
const cloudflareSays = (status: number, body: object) =>
  new Response(JSON.stringify(body), { status });
const accepted = (result: object) =>
  cloudflareSays(200, { success: true, result });
const refused = (status: number, message: string) =>
  cloudflareSays(status, { success: false, errors: [{ message }] });

describe("send", () => {
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

  const send = async () => {
    const sent = initConvexTest().action(api.lib.send, args);
    await vi.runAllTimersAsync();
    return sent;
  };

  it("returns Cloudflare's Message-ID once delivered", async () => {
    fetchMock.mockResolvedValueOnce(
      accepted({ message_id: "<a@b>", delivered: email.to }),
    );
    expect(await send()).toMatchObject({ messageId: "<a@b>" });
  });

  // The mail went out, so an answer shaped differently mustn't turn into a throw.
  it.each([
    ["a null list", { message_id: "<a@b>", delivered: email.to, queued: null }],
    [
      "a list with a non-address",
      { message_id: "<a@b>", delivered: [...email.to, 5] },
    ],
  ])("still reports a sent email given %s", async (_name, result) => {
    fetchMock.mockResolvedValueOnce(accepted(result));
    expect(await send()).toMatchObject({
      messageId: "<a@b>",
      delivered: email.to,
    });
  });

  it("leaves out a Message-ID that isn't text", async () => {
    fetchMock.mockResolvedValueOnce(
      accepted({ message_id: 5, delivered: email.to }),
    );
    expect(await send()).toEqual({ delivered: email.to });
  });

  it("counts a queued address as sent", async () => {
    fetchMock.mockResolvedValueOnce(
      accepted({ message_id: "<a@b>", queued: email.to }),
    );
    expect(await send()).toMatchObject({ messageId: "<a@b>" });
  });

  it.each(["permanent_bounces", "suppressed_recipients"])(
    "fails when success only lists the address under %s",
    async (field) => {
      fetchMock.mockResolvedValueOnce(
        accepted({
          message_id: "<a@b>",
          delivered: [],
          queued: [],
          [field]: email.to,
        }),
      );
      expect(await send()).toMatchObject({
        error: "Not delivered to you@example.com",
      });
    },
  );

  it.each([429, 503])("tries again after a %i", async (status) => {
    fetchMock
      .mockResolvedValueOnce(refused(status, "busy"))
      .mockResolvedValueOnce(
        accepted({ message_id: "<a@b>", delivered: email.to }),
      );
    expect(await send()).toMatchObject({ messageId: "<a@b>" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after three attempts", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(refused(429, "busy")));
    expect(await send()).toEqual({ error: "busy" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([400, 500])("doesn't retry a %i", async (status) => {
    fetchMock.mockResolvedValueOnce(refused(status, "no"));
    expect(await send()).toEqual({ error: "no" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("doesn't retry a thrown fetch, which may have gone out", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connection lost"));
    expect(await send()).toEqual({ error: "connection lost" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("send, the way Cloudflare's examples address mail", () => {
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

  const body = { from: "me@example.com", subject: "Hi", text: "Hello" };
  const sendEmail = (email: object) =>
    initConvexTest().action(api.lib.send, {
      accountId: "account",
      apiToken: "token",
      email: { ...body, ...email },
    });
  const sent = () =>
    JSON.parse(fetchMock.mock.lastCall![1]!.body as string) as object;

  const jane = { address: "jane@example.com", name: "Jane Doe" };
  it.each([
    ["one address", { to: "a@example.com" }],
    ["several", { to: ["a@example.com", "b@example.com"] }],
    ["a named address", { to: jane, from: jane }],
    ["plain and named together", { to: ["a@example.com", jane] }],
    ["cc and bcc alone", { cc: ["a@example.com"], bcc: "b@example.com" }],
  ])("passes on %s unchanged", async (_name, email) => {
    fetchMock.mockResolvedValueOnce(accepted({ message_id: "<a@b>" }));
    expect(await sendEmail(email)).toMatchObject({ messageId: "<a@b>" });
    expect(sent()).toEqual({ ...body, ...email });
  });

  it("sends replyTo as reply_to", async () => {
    fetchMock.mockResolvedValueOnce(accepted({ message_id: "<a@b>" }));
    await sendEmail({ to: "a@example.com", replyTo: jane });
    expect(sent()).toMatchObject({ reply_to: jane });
    expect(sent()).not.toHaveProperty("replyTo");
  });

  it("passes on files, inline images and headers", async () => {
    const extras = {
      attachments: [
        {
          content: "AAAA",
          filename: "a.pdf",
          type: "application/pdf",
          disposition: "attachment",
        },
        {
          content: "BBBB",
          filename: "logo.png",
          type: "image/png",
          disposition: "inline",
          content_id: "logo",
        },
      ],
      headers: { "List-Unsubscribe": "<https://example.com/u>" },
    };
    fetchMock.mockResolvedValueOnce(accepted({ message_id: "<a@b>" }));
    await sendEmail({ to: "a@example.com", ...extras });
    expect(sent()).toMatchObject(extras);
  });

  it("refuses an inline image with no content_id", async () => {
    await expect(
      sendEmail({
        to: "a@example.com",
        attachments: [
          { content: "A", filename: "a", type: "t", disposition: "inline" },
        ],
      }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says who got it and who didn't", async () => {
    fetchMock.mockResolvedValueOnce(
      accepted({
        message_id: "<a@b>",
        delivered: ["a@example.com"],
        queued: ["b@example.com"],
        permanent_bounces: ["c@example.com"],
        suppressed_recipients: ["d@example.com"],
      }),
    );
    expect(await sendEmail({ to: "a@example.com" })).toEqual({
      messageId: "<a@b>",
      delivered: ["a@example.com"],
      queued: ["b@example.com"],
      permanentBounces: ["c@example.com"],
      suppressed: ["d@example.com"],
    });
  });

  it.each([
    ["no recipients", {}, "`to`, `cc` or `bcc`"],
    ["an empty list", { to: [] }, "`to`, `cc` or `bcc`"],
    ["no body", { to: "a@example.com", text: "" }, "`text` or `html`"],
    [
      "over 50 recipients across to, cc and bcc",
      {
        to: Array.from({ length: 30 }, (_, i) => `to${i}@example.com`),
        cc: Array.from({ length: 20 }, (_, i) => `cc${i}@example.com`),
        bcc: "one-too-many@example.com",
      },
      "at most 50",
    ],
  ])("refuses %s without calling Cloudflare", async (_name, email, reason) => {
    const { error } = await sendEmail(email);
    expect(error).toContain(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("queue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fails an email whose send died, and leaves a finished one alone", async () => {
    const t = initConvexTest();
    const stuck = await t.mutation(api.lib.queue, {
      owner: "me",
      payload: "sealed",
    });
    const sent = await t.mutation(api.lib.queue, {
      owner: "me",
      payload: "sealed",
    });
    await t.mutation(api.lib.markResult, { emailId: sent, failed: false });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect((await t.query(api.lib.get, { emailId: stuck }))?.status).toBe(
      "failed",
    );
    expect((await t.query(api.lib.get, { emailId: sent }))?.status).toBe(
      "sent",
    );
  });
});

describe("markResult", () => {
  it("does nothing for an email removed while it was sending", async () => {
    const t = initConvexTest();
    const emailId = await t.mutation(api.lib.queue, {
      owner: "me",
      payload: "sealed",
    });
    await t.mutation(api.lib.remove, { emailId, owner: "me" });
    await expect(
      t.mutation(api.lib.markResult, { emailId, failed: false }),
    ).resolves.toBeNull();
  });
});

describe("reseal", () => {
  it("keeps the error when only the payload is passed", async () => {
    const t = initConvexTest();
    const emailId = await t.mutation(api.lib.queue, {
      owner: "me",
      payload: "sealed",
    });
    await t.mutation(api.lib.markResult, {
      emailId,
      failed: true,
      error: "sealed error",
    });
    await t.mutation(api.lib.reseal, {
      emailId,
      from: "sealed",
      payload: "new",
    });
    expect(await t.query(api.lib.get, { emailId })).toMatchObject({
      payload: "new",
      error: "sealed error",
    });
    await t.mutation(api.lib.reseal, {
      emailId,
      from: "new",
      payload: "newer",
      error: "resealed error",
    });
    expect(await t.query(api.lib.get, { emailId })).toMatchObject({
      payload: "newer",
      error: "resealed error",
    });
  });
});

describe("removeOwner", () => {
  it.each([0, -3, 0.5])(
    "deletes at least one a call given a limit of %d",
    async (limit) => {
      const t = initConvexTest();
      for (let i = 0; i < 2; i++)
        await t.mutation(api.lib.queue, { owner: "me", payload: "sealed" });
      // A caller loops until this is false, so a call that deletes nothing never ends.
      expect(
        await t.mutation(api.lib.removeOwner, { owner: "me", limit }),
      ).toBe(true);
      expect(
        await t.mutation(api.lib.removeOwner, { owner: "me", limit }),
      ).toBe(false);
    },
  );
});
