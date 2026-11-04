/// <reference types="vite/client" />
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vite-plus/test";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

type Status =
  | "delivered"
  | "deferred"
  | "bounced"
  | "failed"
  | "rejected"
  | "complained";

const event = (eventId: string, status: Status, messageId = "a@b") => ({
  eventId,
  messageId,
  status,
  terminal: status !== "deferred",
  at: 1000,
  payload: "sealed",
});

const sentEmail = async (
  t: ReturnType<typeof initConvexTest>,
  owner = "me",
  messageId = "<a@b>",
) => {
  const emailId = await t.mutation(api.lib.queue, { owner, payload: "sealed" });
  await t.mutation(api.lib.markResult, { emailId, failed: false, messageId });
  return emailId;
};
const statusOf = async (
  t: ReturnType<typeof initConvexTest>,
  emailId: Awaited<ReturnType<typeof sentEmail>>,
) => (await t.query(api.lib.get, { emailId }))?.delivery;

const all = { numItems: 100, cursor: null };
const eventsOf = async (
  t: ReturnType<typeof initConvexTest>,
  emailId: Awaited<ReturnType<typeof sentEmail>>,
) => (await t.query(api.events.list, { emailId, paginationOpts: all })).page;

describe("events", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("matches Cloudflare's ids with or without angle brackets", async () => {
    const t = initConvexTest();
    const emailId = await sentEmail(t, "me", "<a@b>");
    const [result] = await t.mutation(api.events.record, {
      owner: "me",
      events: [event("e1", "delivered", " a@b ")],
    });
    expect(result).toEqual({ eventId: "e1", isNew: true, emailId });
    expect(await statusOf(t, emailId)).toBe("delivered");
  });

  test("a repeated event is stored once and isn't new", async () => {
    const t = initConvexTest();
    const emailId = await sentEmail(t);
    const events = [event("e1", "delivered")];
    await t.mutation(api.events.record, { owner: "me", events });
    const [again] = await t.mutation(api.events.record, {
      owner: "me",
      events,
    });
    expect(again?.isNew).toBe(false);
    expect(await eventsOf(t, emailId)).toHaveLength(1);
  });

  test.each([
    ["deferred then delivered", ["deferred", "delivered"], "delivered"],
    ["delivered then deferred", ["delivered", "deferred"], "delivered"],
    [
      "one bounce among deliveries",
      ["delivered", "bounced", "delivered"],
      "bounced",
    ],
    ["bounced before delivered", ["bounced", "delivered"], "bounced"],
    ["delivered then complained", ["delivered", "complained"], "complained"],
    ["complained then bounced", ["complained", "bounced"], "complained"],
  ] as [string, Status[], Status][])(
    "the email's status is the worst outcome: %s",
    async (_name, statuses, expected) => {
      const t = initConvexTest();
      const emailId = await sentEmail(t);
      await t.mutation(api.events.record, {
        owner: "me",
        events: statuses.map((status, i) => event(`e${i}`, status)),
      });
      expect(await statusOf(t, emailId)).toBe(expected);
    },
  );

  test("an event for another owner's message doesn't touch it", async () => {
    const t = initConvexTest();
    const emailId = await sentEmail(t, "victim");
    const [result] = await t.mutation(api.events.record, {
      owner: "attacker",
      events: [event("e1", "bounced")],
    });
    expect(result?.emailId).toBeUndefined();
    expect(await statusOf(t, emailId)).toBeUndefined();
    expect(await eventsOf(t, emailId)).toEqual([]);
  });

  test("the same event id from two owners is two events", async () => {
    const t = initConvexTest();
    const mine = await sentEmail(t, "me");
    const theirs = await sentEmail(t, "them");
    for (const owner of ["me", "them"]) {
      const [result] = await t.mutation(api.events.record, {
        owner,
        events: [event("e1", "delivered")],
      });
      expect(result?.isNew).toBe(true);
    }
    expect(await statusOf(t, mine)).toBe("delivered");
    expect(await statusOf(t, theirs)).toBe("delivered");
  });

  test("an event that beats markResult is picked up by it", async () => {
    const t = initConvexTest();
    await t.mutation(api.events.record, {
      owner: "me",
      events: [event("e1", "bounced")],
    });
    const emailId = await sentEmail(t);
    expect(await statusOf(t, emailId)).toBe("bounced");
    expect(await eventsOf(t, emailId)).toHaveLength(1);

    // Its scheduled clean-up finds the email now, so the event stays.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await eventsOf(t, emailId)).toHaveLength(1);
  });

  test("an event for mail the component never saw is dropped later", async () => {
    const t = initConvexTest();
    await t.mutation(api.events.record, {
      owner: "me",
      events: [event("e1", "delivered", "someone-else@b")],
    });
    const before = await t.query(api.events.page, { paginationOpts: all });
    expect(before.page).toHaveLength(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const after = await t.query(api.events.page, { paginationOpts: all });
    expect(after.page).toEqual([]);
  });

  test("an email with no message id has no events", async () => {
    const t = initConvexTest();
    const emailId = await t.mutation(api.lib.queue, {
      owner: "me",
      payload: "x",
    });
    expect(await eventsOf(t, emailId)).toEqual([]);
  });

  test("deleting an email takes its events along", async () => {
    const t = initConvexTest();
    const emailId = await sentEmail(t);
    const other = await sentEmail(t, "me", "<other@b>");
    await t.mutation(api.events.record, {
      owner: "me",
      events: [event("e1", "delivered"), event("e2", "delivered", "other@b")],
    });
    await t.mutation(api.lib.remove, { emailId, owner: "me" });
    const { page } = await t.query(api.events.page, { paginationOpts: all });
    expect(page).toHaveLength(1);
    expect(await eventsOf(t, other)).toHaveLength(1);
  });

  test("removeOwner clears events, including across batches", async () => {
    const t = initConvexTest();
    await sentEmail(t);
    await sentEmail(t, "them");
    await t.mutation(api.events.record, {
      owner: "me",
      events: [event("e1", "delivered"), event("e2", "bounced")],
    });
    await t.mutation(api.events.record, {
      owner: "them",
      events: [event("e3", "delivered")],
    });
    expect(
      await t.mutation(api.lib.removeOwner, { owner: "me", limit: 1 }),
    ).toBe(true);
    expect(await t.mutation(api.lib.removeOwner, { owner: "me" })).toBe(false);
    const { page } = await t.query(api.events.page, { paginationOpts: all });
    expect(page.map((e) => e.owner)).toEqual(["them"]);
  });

  test("reseal only replaces the payload it was given", async () => {
    const t = initConvexTest();
    await t.mutation(api.events.record, {
      owner: "me",
      events: [event("e1", "delivered")],
    });
    const { page } = await t.query(api.events.page, { paginationOpts: all });
    const id = page[0]!._id;
    await t.mutation(api.events.reseal, { id, from: "stale", payload: "new" });
    await t.mutation(api.events.reseal, {
      id,
      from: "sealed",
      payload: "newer",
    });
    const after = await t.query(api.events.page, { paginationOpts: all });
    expect(after.page[0]?.payload).toBe("newer");
  });
});
