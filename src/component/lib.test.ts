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
    expect(await send()).toEqual({ messageId: "<a@b>" });
  });

  it("counts a queued address as sent", async () => {
    fetchMock.mockResolvedValueOnce(
      accepted({ message_id: "<a@b>", queued: email.to }),
    );
    expect(await send()).toEqual({ messageId: "<a@b>" });
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
      expect(await send()).toEqual({
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
    expect(await send()).toEqual({ messageId: "<a@b>" });
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
