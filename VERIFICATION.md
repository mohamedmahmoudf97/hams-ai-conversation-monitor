# Phase 6 verification

## Hosted demo verification — 24 November 2026

Deployed the frontend and unchanged mock as separate Railway services from
commit `386c70f`. The public frontend loaded the inbox and live messages using
the HTTPS API. HTML, JavaScript, CSS, logo and favicons returned HTTP 200, and
the built JavaScript contained the hosted API URL without a localhost fallback.

Read-only API checks returned eight conversations and 5,004 messages for `c-1`,
with no duplicate IDs. The SSE stream delivered tokens, message starts/ends,
handoffs and status updates. Reconnecting with `since=525` replayed IDs 523–525,
then continued through 622 without gaps; overlapping payloads matched.

In Chrome, takeover enabled Noura's composer. Sending a mixed English/Arabic
reply received a real rejection and displayed the failed bubble with inline
Retry. Retrying confirmed the reply; a subsequent GET found exactly one matching
human message (`m-5274`). Arabic layout rendered correctly, Sara's thread loaded
5,016 messages, and live updates continued after an observed connection loss.
These are deployment smoke checks, not a new full browser regression run.

## Browser retry verification — 24 November 2026

Verified in the running Chrome app using the unchanged mock server. The sixth
test reply received an actual HTTP 500. Its bubble retained the mixed English/
Arabic text, displayed the red failed state and inline Retry action, and left the
composer empty. Switching to Arabic showed the localized status and action inside
the same bubble without a composer Alert.

Typed a separate draft, retried the failed bubble, and observed Sending followed
by one confirmed copy. The separate draft remained intact. The confirmed timestamp
used the server's acceptance time, as expected.

Also observed a separate app tab using DevTools Offline: its POST failed with
ERR_INTERNET_DISCONNECTED and appeared as Delivery unconfirmed. A controlled
offline-to-online cycle was not completed because Chrome tabs were changing
during the test. No application code or mock behavior was changed for this run.

## Inline failed-message retry — 24 November 2026

Latest `npm run check`: **199 tests in 16 files passed**, plus strict TypeScript
checks and the production build. Failed and uncertain delivery controls now live
inside the affected message bubble; the composer contains only the reply form.
Definite rejection retains a clearly marked local failure without adding it to
confirmed history or restoring duplicate text into the composer.

Tests cover original placement while failed/retrying, multiple retained failures,
targeted retries across conversation switches, preserved drafts (including an
identical newer draft), new request IDs with stable local bubble IDs, delivery
checks, confirmation deduplication and unchanged history references on metadata
updates. Retrying and confirming an already seen bubble does not add a new-message
count. Existing streaming, localization and 5,000-message regressions also pass.

No dependencies were added and the mock server was not changed. Live visual
verification was attempted, but browser access failed and the native Chrome
fallback timed out. The existing Vite chunk-size warning remains: **740.78 kB
JavaScript / 225.87 kB gzip**.

## Scroll and optimistic-history performance — 24 November 2026

At this stage, `npm run check`: **190 tests in 15 files passed**, plus strict TypeScript
checks and the production build. Controlled tests recorded these baselines before
changing production code, then passed after the changes:

| Scenario | Before | After |
| --- | ---: | ---: |
| Message-ID reads across 20 near-bottom scroll events with 5,000 messages | 100,000 | 0 |
| Memoized history-consumer renders across three delivery metadata updates with 5,000 cached messages and one optimistic reply | 3 | 0 |

The history consumer is a memoized test substitute used to observe array stability;
these are deterministic work counts, not browser FPS or timing measurements.
Returning from older history still refreshes seen IDs once. Tests also cover new
arrivals during smooth jumps, cancellation near the bottom, resizing to the end
without a scroll event, optimistic rollback, uncertain replies, confirmation
deduplication and Arabic UI updates.

No dependencies or extra performance hooks were added. The supplied mock remains
unchanged. The existing Vite chunk-size warning remains: **739.99 kB JavaScript /
225.49 kB gzip**.

## Memoization review — 24 November 2026

At this stage, `npm run check`: **185 tests in 14 files passed**, plus strict TypeScript
checks and the production build. Five new regression cases verify skipped parent
renders for preview, handoff, composer and stable message objects, plus thread and
virtualizer isolation from unrelated inbox activity. Relevant prop, store and
locale changes still update the UI. These check component execution using real
hooks and HeroUI components; they are not browser frame-rate measurements.

Preview, handoff, composer and thread now accept only their required primitive
props and use `memo`. MessageList also uses `memo` with its existing stable history
array. No custom comparators or new dependencies were added. The existing Vite
chunk-size warning remains: **739.96 kB JavaScript / 225.47 kB gzip**.

## Post-review bug fixes — 24 November 2026

At this stage, `npm run check`: **180 tests in 13 files passed**, including strict TypeScript
checks and the production build. Thirteen regression cases cover delayed replay,
clock differences, POST/SSE ordering, refresh races, independent thread/inbox
snapshots, multiple confirmed replies, and late responses after cache removal.
The composer no longer references a removed accessibility description.

Messages and inbox activity now follow event order. POST confirmations remain
protected until their stream events arrive; snapshot reconciliation preserves
the arrival order of events and confirmations. README explains this behavior.
The mock and original PDF hashes below remain unchanged. No dependencies were added.

The existing Vite chunk-size warning remains: **739.93 kB JavaScript / 225.47 kB gzip**.
This follow-up used automated checks; the browser observations and earlier test
counts below are the historical Phase 6 verification, not a new browser run.

---

Verified on 24 November 2026 against the supplied assessment and unchanged mock.
Results below distinguish automated checks from observations in Chrome at
`http://127.0.0.1:5173`, using the existing API on port 4000.

## Automated results

`npm run check` passed: **164 tests in 12 files**, strict TypeScript checking,
and a production build. The only production change replaces standalone form labels
on conversation names with HeroUI Typography, correcting the browser-reported
label association issue. No dependencies were added.

The new [MessageRow test](src/features/conversations/components/MessageRow.test.tsx)
uses the real event controller and store with React `Profiler` around three
representative mounted rows, backed by a 5,000-message cache:

- Four interleaved English/Arabic tokens produced two commits for each active
  stream and zero commits for the unchanged historical row.
- Tokens preserved the confirmed history array's identity.
- Ending one stream left the other stream intact; a replayed token caused no
  extra commit or duplicated text.
- Both final message texts, inbox previews, cleared overlays and cursor were correct.

This measures React commits in jsdom, not browser frame rate. The existing
[App integration test](src/app/App.test.tsx) separately verifies fewer than 40
mounted rows while navigating a 5,000-message history, language switching,
new-message counts and keyboard jumping.

A new App regression switches conversations during an active reply, delivers the
remaining tokens and completion, and verifies the selected thread stays unchanged,
the inbox preview updates, and returning shows the completed reply without a refetch.
This conversation-switching check is deterministic test evidence.

## Assessment coverage

| Requirement | Implementation and evidence |
| --- | --- |
| REST inbox/thread and state ownership | App, API, thread and live store; loading/error/empty/selection/cancellation tests; ownership explained in README. |
| Correct streaming, preview and unread updates | Controller/reconciliation and per-row subscriptions; ordering, concurrent-token, preview and snapshot-race tests. |
| Resume, deduplication and connection status | Connection tests cover fresh cursors, overlap, gaps, stale callbacks and cleanup; actual reconnects observed below. |
| Handoff, takeover, optimistic replies and rollback | Reply/controller/App tests cover reasons, confirmation races, definite rejection and uncertain delivery; takeover and rejection/retry observed below. |
| Large histories and efficient token rendering | Virtualizer and memoized rows; bounded-row integration test and Profiler regression; large live history navigated below. |
| Arabic/English and RTL/LTR | Root language/direction, HeroUI locale, logical layout, message direction and Intl formatting; localization and responsive integration tests. |
| Required ordering, replay and handoff tests | Controller, connection, reconciliation and reply suites, plus the new concurrent-stream regression. |

## Live observations

- **Reconnect:** Network showed successive stream requests with `since=78286`,
  `78330`, `78360`, `78374` and `78390`. Deliberate connection drops were followed
  by fresh requests and continued updates. The badge changed from Reconnecting
  back to Connected. The mock intentionally destroys SSE responses, so Chrome's
  `ERR_INCOMPLETE_CHUNKED_ENCODING` entries are expected during these drops.
- **Handoff and takeover:** Sara's thread showed Needs human and the received
  reason `العميل غير راضٍ ويطلب موظفاً`. Take over changed the confirmed status to
  Human handling and revealed the composer.
- **Rejection and retry:** Enter submitted a multiline English/Arabic verification
  reply. Its pending row appeared, then an actual HTTP 500 removed that row and
  preserved the text in the error and draft. Retry reply returned HTTP 201 and
  cleared the failure. A subsequent API snapshot contained exactly one matching
  human message (`m-34868`) with a `clientMessageId`.
- **Large history:** Sara's thread contained 8,823 messages when opened, exceeding
  the original 5,000-message seed. Keyboard Home reached old history without
  mounting the entire list. New arrivals retained that history view and showed
  `2 new messages`. Tab reached Jump to latest; Enter returned focus to history.
  The smooth jump reached the newest messages and resumed following arrivals.
- **Responsive and keyboard:** 320px English/Arabic layouts remained usable;
  the 768px Arabic drawer opened from the right. Escape restored focus to its menu
  button, and selecting a conversation closed the drawer. At 1024px the permanent
  inbox returned and the menu button disappeared.
- **Browser accessibility issue:** Conversation names used standalone form labels.
  Replacing them with HeroUI Typography removed Chrome's label-association warnings;
  the Issues panel reported no issues after a fresh load.

## Limits and integrity

- Browser observations are smoke checks, not an exhaustive accessibility audit or
  a frame-rate benchmark. Reduced motion, IME input and asynchronous race cases
  have deterministic test coverage.
- The production build retains Vite's existing chunk-size warning: approximately
  707.83 kB JavaScript, 216.12 kB gzip. It does not fail the build; no warning was
  hidden or threshold changed.
- The mock source was not modified or restarted for verification. Runnable mock
  and supplied attachment are byte-identical. SHA-256:
  `8a75b13b6dc48eff695850ec9958a6d5ca14a67bf0de81a7596d6adf815d2c6d`.
- The original assessment PDF hash remains
  `b3f7927668ed3b4ba51c802069e2b1cabab99aef3e4371252f0163e308ba5bfd`.
- Existing backend limitations (unread semantics, session-only handoff reasons,
  restart detection and non-idempotent resend) remain documented in README.

Phase 7 remains: final README/delivery review, submission package and interview walkthrough.
