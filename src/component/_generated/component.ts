/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    events: {
      list: FunctionReference<
        "query",
        "internal",
        { emailId: string },
        Array<{
          _creationTime: number;
          _id: string;
          at: number;
          eventId: string;
          messageId: string;
          owner: string;
          payload: string;
          status:
            | "delivered"
            | "deferred"
            | "bounced"
            | "failed"
            | "rejected"
            | "complained";
          terminal: boolean;
        }>,
        Name
      >;
      page: FunctionReference<
        "query",
        "internal",
        { cursor: string | null },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{ _id: string; owner: string; payload: string }>;
        },
        Name
      >;
      record: FunctionReference<
        "mutation",
        "internal",
        {
          events: Array<{
            at: number;
            eventId: string;
            messageId: string;
            payload: string;
            status:
              | "delivered"
              | "deferred"
              | "bounced"
              | "failed"
              | "rejected"
              | "complained";
            terminal: boolean;
          }>;
          owner: string;
        },
        Array<{ emailId?: string; eventId: string; isNew: boolean }>,
        Name
      >;
      reseal: FunctionReference<
        "mutation",
        "internal",
        { from: string; id: string; payload: string },
        null,
        Name
      >;
    };
    lib: {
      get: FunctionReference<
        "query",
        "internal",
        { emailId: string },
        null | {
          _creationTime: number;
          _id: string;
          delivery?:
            | "delivered"
            | "deferred"
            | "bounced"
            | "failed"
            | "rejected"
            | "complained";
          direction: "inbound" | "outbound";
          error?: string;
          messageId?: string;
          owner: string;
          payload: string;
          status: "queued" | "sent" | "failed" | "received";
        },
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { direction: "inbound" | "outbound"; limit?: number; owner: string },
        Array<{
          _creationTime: number;
          _id: string;
          delivery?:
            | "delivered"
            | "deferred"
            | "bounced"
            | "failed"
            | "rejected"
            | "complained";
          direction: "inbound" | "outbound";
          error?: string;
          messageId?: string;
          owner: string;
          payload: string;
          status: "queued" | "sent" | "failed" | "received";
        }>,
        Name
      >;
      markResult: FunctionReference<
        "mutation",
        "internal",
        {
          emailId: string;
          error?: string;
          failed: boolean;
          messageId?: string;
          payload?: string;
        },
        null,
        Name
      >;
      page: FunctionReference<
        "query",
        "internal",
        { cursor: string | null },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _id: string;
            error?: string;
            owner: string;
            payload: string;
          }>;
        },
        Name
      >;
      queue: FunctionReference<
        "mutation",
        "internal",
        { owner: string; payload: string },
        string,
        Name
      >;
      receive: FunctionReference<
        "mutation",
        "internal",
        { owner: string; payload: string },
        string,
        Name
      >;
      remove: FunctionReference<
        "mutation",
        "internal",
        { emailId: string; owner: string },
        null,
        Name
      >;
      removeOwner: FunctionReference<
        "mutation",
        "internal",
        { limit?: number; owner: string },
        boolean,
        Name
      >;
      reseal: FunctionReference<
        "mutation",
        "internal",
        { emailId: string; error?: string; from: string; payload: string },
        null,
        Name
      >;
      send: FunctionReference<
        "action",
        "internal",
        {
          accountId: string;
          apiToken: string;
          email: {
            attachments?: Array<
              | {
                  content: string;
                  disposition: "attachment";
                  filename: string;
                  type: string;
                }
              | {
                  content: string;
                  content_id: string;
                  disposition: "inline";
                  filename: string;
                  type: string;
                }
            >;
            bcc?:
              | string
              | { address: string; name?: string }
              | Array<string | { address: string; name?: string }>;
            cc?:
              | string
              | { address: string; name?: string }
              | Array<string | { address: string; name?: string }>;
            from: string | { address: string; name?: string };
            headers?: Record<string, string>;
            html?: string;
            replyTo?: string | { address: string; name?: string };
            subject: string;
            text?: string;
            to?:
              | string
              | { address: string; name?: string }
              | Array<string | { address: string; name?: string }>;
          };
        },
        {
          delivered?: Array<string>;
          error?: string;
          messageId?: string;
          permanentBounces?: Array<string>;
          queued?: Array<string>;
          suppressed?: Array<string>;
        },
        Name
      >;
    };
  };
