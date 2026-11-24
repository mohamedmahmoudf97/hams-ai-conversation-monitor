# Hams.AI conversation monitor

A React and TypeScript app for watching live customer conversations, following AI
replies as they stream, and taking over when human help is needed.

Built with Vite, TanStack Query, Zustand, Zod, and TanStack Virtual. The interface
uses HeroUI v3, Tailwind CSS, and Phosphor icons.

## Demo

[Open the live app](https://hams-ai-conversation-monitor-production.up.railway.app/).

The frontend and unchanged mock run as separate Railway services from this
repository. Railway builds the frontend with `npm run build` and serves `dist`.
Its `VITE_API_BASE_URL` points to
`https://hams-ai-mock-api-production.up.railway.app`. The backend runs
`node mock-server.mjs` with one instance and `/conversations` as its health check.

Demo data is shared between visitors and resets when the mock restarts. Hosting
currently uses Railway's limited trial, so availability depends on its remaining
time and credit. The local setup below works independently of the hosted demo.

## Run locally

Use Node 22.12 or newer and npm. The project was developed with Node 24.12.0,
also specified in `.nvmrc`.

From the project folder, install dependencies:

```sh
npm ci
```

Start the supplied mock server:

```sh
npm run mock
```

In a second terminal, start the frontend:

```sh
npm run dev
```

Open http://127.0.0.1:5173. The mock runs at http://localhost:4000 and has not
been modified.

To use another API address, copy `.env.example` to `.env.local`, set
`VITE_API_BASE_URL`, and restart Vite. For example, `PORT=5000 npm run mock`
runs the mock on port 5000.

Choose a conversation to follow its messages. When it shows **Needs human**,
select **Take over** to enable replies. Enter sends; Shift+Enter adds a new line.
The **En / Ar** buttons switch the interface language and direction.

The mock deliberately drops its event connection every 20–40 seconds and rejects
roughly one in five sends. These are useful for checking reconnect and retry behavior.
If you restart the mock, reload the app too: its data and event IDs reset.

## State ownership

- **TanStack Query** stores the conversation list and fetched message history.
  Live events update these caches as messages and statuses change.
- **Zustand** stores connection state, plus per-conversation streaming text,
  handoff reasons, drafts, and local reply attempts.
- **React state** stores the selected conversation, language, and drawer state.
- **React Context** shares one controller instance through
  [LiveProvider](src/features/conversations/live/LiveProvider.tsx). Components access
  its store and actions with `useConversationLive`. The provider starts the live
  connection and cleans it up on unmount; changing data stays in Query and Zustand.

This split keeps frequent token updates out of the message-history array.
Each message row and inbox preview subscribes to its own streaming text; when
the AI finishes, its final text is committed to the Query cache.

UI components live in `src/features/conversations/components`. The
[controller](src/features/conversations/live/controller.ts) coordinates API
responses and events; [reconcile.ts](src/features/conversations/live/reconcile.ts)
contains the pure functions that merge them. REST responses and SSE payloads are
validated with Zod before use.

## Streaming and reconnecting

1. The first inbox response supplies `lastEventId`. The app opens one
   `EventSource` connection at `/events?since=<lastEventId>`.
2. After processing an event, the app remembers its ID. Events with an ID already
   handled are ignored, including the overlap the mock sends on reconnect.
3. If the connection drops, the app closes it and reconnects after three seconds,
   using the latest **processed** ID. Invalid events or gaps trigger another
   reconnect without advancing that ID.

An explicit `since` value is needed because the mock gives it priority over the
browser's `Last-Event-ID` header. A toast shows connection loss, reconnection,
and recovery.

REST requests can finish while live events are arriving. The app buffers those
events, installs the response, then applies only events newer than the response's
`lastEventId`. Inbox and thread responses are tracked separately, so loading one
thread cannot skip events belonging to another. If a stream arrives without its
starting text, the app fetches that thread to recover it.

The connection and timer are cleaned up when the app unmounts. See
[connection.ts](src/features/conversations/live/connection.ts) for the transport.

## Handoff and replies

A `transfer_to_human` event changes the conversation to **Needs human** and shows
the reason with a **Take over** action. Replies become available after human status
is confirmed and message history has loaded. Closed conversations stay read-only.

A reply appears immediately as **Sending**. The POST response and SSE echo are
matched by message ID or `clientMessageId` so confirmation produces one message,
whichever arrives first.

If the mock rejects the request, the bubble becomes **Reply was not sent** with an
inline **Retry reply** button. This rolls back the sending state while retaining
the unsent text; it is excluded from confirmed history and the inbox preview.
Retry targets that bubble and leaves any newer draft intact.

A network error is different: the server may have accepted the reply before the
connection was lost. The bubble shows **Delivery unconfirmed** and offers
**Check delivery** before **Send again**. The mock does not enforce idempotency,
so resending can create a duplicate. POST requests are never retried automatically.

This behavior lives in [replyActions.ts](src/features/conversations/live/replyActions.ts).

## Performance and language support

TanStack Virtual renders the visible messages plus a small buffer and measures
their heights. The 5,000-message conversation therefore does not mount thousands
of message components at once. Memoized components, narrow props, and stable
message references keep unrelated history rows from rerendering on each token.

The thread follows incoming messages while the reader is near the bottom.
Scrolling back pauses following; **Jump to latest** returns to the newest message.

Language changes update `lang` and `dir` on `<html>` and the HeroUI locale.
Message bodies use `dir="auto"` for mixed Arabic and English, and `Intl` formats
dates and counts. Customer bubbles stay on the left and AI/human replies on the
right in both languages. Below 1024px, the inbox opens in a drawer.

## Checks

```sh
npm run check
```

This runs the tests, strict TypeScript checks, and production build. The current
suite has 199 passing tests covering stream ordering, replay deduplication,
handoff, reply failures and confirmation races, draft preservation, RTL behavior,
and bounded rendering of a 5,000-message history.

Use `npm run test:watch` while developing. After a build, `npm run preview`
serves the production app at http://127.0.0.1:4173; keep the mock running.

## Limitations

- The mock has no mark-as-read endpoint. Counts update from server snapshots and
  new customer events, but opening a conversation does not clear them.
- Handoff reasons are only available for events received during the current
  session; the REST response does not include them.
- Drafts, failed replies, and the language choice are kept in memory and reset
  on a page reload.
- Streaming events have no server timestamp, so the app uses receipt time until
  a later snapshot supplies the server value. Message order follows the snapshot
  and event sequence rather than comparing browser and server clocks.
- The app detects some mock restarts from a lower event counter, but reliable
  detection would need a server session identifier.

## What was skipped

All seven required features are implemented. The hosted demo is available above;
the optional walkthrough recording is not included yet.

## What I would improve with more time

I would add browser automation for reconnects and retries, profile long threads,
and reduce the production bundle size. Backend support for idempotent sends,
mark-as-read, and stored handoff reasons would address the remaining API limitations.
