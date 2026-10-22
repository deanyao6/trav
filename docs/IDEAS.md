# Trav — Ranked Feature Ideas

Owner: ideation. Written 2026-10-22 during the research sprint (before `docs/VOICE.md` and the
research files existed; re-check against them when they land).

Scoring: **score = impact × fit ÷ effort**, with impact and fit on 1–5 and effort S=1, M=2, L=3.
"Fit" means fit with Trav's thesis (group travel, lives in the group chat, before/during/after) and
with the v0 demo. The formula rewards small useful things; the three founder seeds score lower on
paper only because they are M-sized. They are still the demo's magic and are already P0 in
`tasks/BACKLOG.md` (T-015, T-016, T-018). Part 1 specifies them in detail; Part 2 is the ranked
list of everything, including the seeds; Part 3 is what was cut and why.

Scenario shorthand: **BCN** = Barcelona, 6 friends 20–22 (flagship). **LIS** = Lisbon, Dean + Dad.
**TCI** = Turks and Caicos, family with a 14-year-old.

---

## Part 1 — Founder seeds, developed

### Seed A: Morning After (daily mini-Wrapped)

**User moment.** 10:00 the morning after a club night in BCN. Nobody remembers who paid for the
second round of Ubers. One message from Trav tells the whole group what happened, what it cost,
who owes whom, and shows the five best photos. Someone screenshots it.

**Why it matters.** This is the retention ritual. It makes the ledger visible every day (so it
never becomes the forgotten shared note from MOTIVATION.md), it makes settling a daily habit
instead of a post-trip chore, and it is the first thing people share outside the chat.

**Trigger logic.**
- Fires once per morning, default 10:00 local to the trip, never before 09:00, configurable
  (`@trav recap at 11`).
- **Night-out detection** decides the flavor. Signals: any booking tagged nightlife, any expense
  after 22:00, album photos after 23:00, chat activity after midnight. If ≥2 signals: full
  Morning After. Otherwise: the quieter **Daily settle-up** (money sections only, 3 lines).
- Nothing happened at all (travel day, no expenses, no photos): no message. Silence is a feature.
- **Family mode (TCI) / any minor in the group:** the card is titled "Yesterday", never
  "Morning After"; no night-out framing; no alcohol references anywhere; no roast line.
- First night of the trip: card includes a one-line explanation of what it is and how to tune it.

**Content outline (sections in order; each is skippable when empty).**
1. **Header** — "Morning After · Night 3 · Thu 23 → Fri 24". Who was out: "5 of 6 (Henry sat
   this one out)". Attendance comes from the "who's in tonight" state, never inferred from
   photos.
2. **What you did** — 3–5 timeline bullets reconstructed from bookings (Razzmatazz 01:10),
   expenses (dinner at Bar del Pla 21:40, 2 Ubers), and plan messages in chat. Times rounded to
   10 minutes.
3. **Spend** — group total for the night, per-person share, biggest single item, category split
   (food / drinks / rides / tickets). One pacing line against the daily budget if one is set
   ("€58/pp, budget €50 → 16% over; week pace is still fine").
4. **Best moment** — one photo or one chat message, chosen by the highlight scorer (see Seed C).
   Caption is one sentence in Trav's voice; it may quote the chat.
5. **Who owes whom** — net balances after last night plus the minimal transfer set ("Maya → Sam
   €21, Dean → Sam €14"). One-tap "mark paid". Only shows people whose balance moved or who are
   >€10 out of square.
6. **Needs a tap** — count of card/email items that "look shared" and are waiting on their
   owner. The card shows only the count publicly; the items themselves go to each owner in the
   private lane (idea 6).
7. **Photos** — 3–6 from the shared album, taken inside the night window (18:00 → 06:00),
   opt-in members only, picked by the highlight scorer. Each photo carries a tiny credit
   ("Sam's"). Any member can say `@trav drop that one` and it is removed from this recap and
   excluded from Wrapped.
8. **Roast line** — only if roast mode is on for this group and no minor is present; only
   about spending or trip events (VOICE.md and SAFETY.md govern wording).
9. **Today** — next fixed thing (Park Güell 15:00, tickets attached), weather in one word, and
   the evening hook: "Tonight? I'll ask at 6."

**Effort:** M. **Dependencies:** ledger + settlement (T-003), attendance (T-002), album adapter
(T-018), simulator clock/scheduler, a card renderer in the simulator (T-019), VOICE.md.

**Privacy / safety.**
- Photos: opt-in per member per trip; absent members never appear in "who was out"; a photo of
  a member who opted out can still be contributed by someone else, so the "drop that one"
  command must work for anyone in the group, not only the uploader.
- Never restate a reason someone was absent ("sick") in Trav's own words; attendance is a fact,
  the reason is theirs.
- Card/email items stay private to their owner until confirmed; the group sees only counts.
- No inference about who left with whom, how much anyone drank, or anyone's state. Timeline
  bullets come from money and bookings only.
- Minors: handled by family mode above; roast blocked by the global rule.

**Score:** impact 5 × fit 5 ÷ M(2) = **12.5**

---

### Seed B: Trip Wrapped (end of trip)

**User moment.** The morning after the last night, or when the last person lands home. Trav
posts a carousel of cards built to be screenshotted and posted. It closes with "everyone's
square" or the exact transfers to get there.

**Why it matters.** It is the viral artifact and the emotional payoff that makes the group add
Trav to the next trip. It also finishes the money: a Wrapped with an outstanding balance has a
built-in reason to settle.

**Format.** 6–9 cards, 9:16, one big number or one big photo each, group name on every card, a
small Trav mark in a corner. No card ever shows card last-4, emails, addresses, or personal
balances beyond the group-visible ledger. Each card stands alone as a screenshot.

**Card outline.**
1. **Cover** — "Barcelona Wrapped · 6 friends · 5 nights · 4 home cities".
2. **By the numbers** — total spent, average per person, expenses captured, Ubers taken,
   dinners, tickets, latest night (time of the last expense), number of things Trav booked.
3. **Awards** (each with the stat that earned it, so it is defensible and not a vibe):
   - **MVP Spender** — fronted the most money for the group (an honor: "carried €412 up front").
   - **Uber Captain** — ordered the most rides.
   - **Night Owl** — latest last-expense timestamp, most nights.
   - **Early Bird** — first expense of the day, most days.
   - **The Photographer** — most album photos used in recaps (opt-in members only).
   - **Always In** — most "I'm in" responses to "who's in tonight".
   - **The Planner** — most @trav asks that became a booking.
   - **Best Value Night** — the night with the most reactions per euro.
   - **Big Night** — the night that cost the most (a group award, nobody's name on it).
   Rules: one award per person maximum where possible; a member can opt out of awards
   (`@trav no awards for me`) and is silently skipped; no award references drinking volume,
   bodies, romance, or anyone outside the chat; in family groups the minor can only receive
   positive, event-neutral awards (The Photographer, Early Bird) and nothing nightlife-adjacent.
4. **Best night** — highest combined signal (attendance × chat reactions × photo count), with
   3 photos and the timeline in one line.
5. **Top photos** — 6–9 grid, opt-in members only, de-duplicated, one per time cluster, covering
   different days and venues.
6. **Money** — settled vs outstanding; if outstanding, the minimal transfers with "mark paid";
   if square, a celebration card.
7. **Things you loved** — top 3–5 places by reactions and repeat visits. This card is also what
   gets written to group memory for the next trip (idea 17).
8. **Closing** — "Next trip?" with the invite link for adding Trav to another chat (idea 8).

**Per-person variant (later, P1):** a private "Your Wrapped" per member (your spend, your share,
your awards, your photos) sent in the private lane. Not shareable by default.

**Effort:** M. **Dependencies:** everything Morning After needs, plus a carousel/card renderer,
awards computation in `packages/core` (pure, testable), group memory write-back.

**Privacy / safety.** Same as Morning After, plus: photos of minors never appear on any card that
carries a share CTA; awards are computed only from the ledger, attendance, and the album (never
from message content beyond reactions); the group can turn off awards entirely.

**Score:** impact 5 × fit 5 ÷ M(2) = **12.5**

---

### Seed C: Shared album (consent-gated memory source)

**User moment.** On day 1 Trav posts one line: "If you want your photos in the recaps, reply
'photos on' or drop them in the trip album." From then on, the recaps have pictures and nobody
has to merge six camera rolls after the trip.

**Why it matters.** Memories are the third leg of the thesis (expenses, experiences, memories).
Without photos, Morning After and Wrapped are spreadsheets. With them, they are the thing people
share.

**Consent model (per member, per trip; default off).**
- **Off** (default): Trav never sees this member's photos. Their name never appears as a credit.
- **My picks**: the member sends chosen photos to Trav (in chat, or via a system photo picker in a
  future companion app). This is the only path both Apple and Google currently allow a third
  party without a native app: Apple exposes nothing for Shared Albums, and Google's Library API
  was narrowed in 2025 to app-created content plus Picker-selected items. Treat "my picks" as the
  realistic real-world default.
- **Auto** (mock only in v0): everything the member took inside the trip window and the trip's
  geofence. Real-world path: a shared trip album that Trav is a subscriber of, or a companion app
  with limited-library access. Document as a connector TODO, never promise it in the demo copy.
- Consent can be withdrawn any time (`@trav photos off`); existing recaps keep already-posted
  cards (they are in the chat history anyway) but the member's photos are excluded from
  everything generated afterward, including Wrapped.
- Group-wide kill switch: `@trav no photos this trip`.

**What Trav reads from a photo.** Timestamp, rough location, uploader, and a vision pass for
caption, quality, and a safety screen. **No face recognition, no identity inference** in v0:
"who is in the photo" is never computed; "who was out" comes from attendance.

**Highlight scorer (used by Morning After and Wrapped).**
1. Restrict to the window (night: 18:00 → 06:00; day: the calendar day; trip: all).
2. Cluster by 20-minute buckets and location; one winner per cluster for diversity.
3. Score = distinct uploaders in the cluster (more people there → better) + chat reactions
   within ±15 minutes + vision quality (sharp, lit, people visible) − penalties (screenshot,
   receipt, duplicate, blurry, text-heavy).
4. Safety screen before anything is selected: drop nudity, visible card numbers or IDs, and
   anything the vision pass flags as sensitive. Flagged photos are never shown, not even to the
   uploader, and are logged only as a count.
5. Receipts detected in the album are routed to the ledger as a "want me to log this?" offer to
   the uploader (private lane), not to the recap.
6. A dropped photo (`@trav drop that one`) is tombstoned for the trip.

**Effort:** M for the mock adapter + scorer; L for any real integration. **Dependencies:**
fixtures with timestamped, uploader-tagged photos; vision stub for offline mode; private lane.

**Privacy / safety.** Opt-in is per member and per trip, logged with timestamp as an audit event;
withdrawal is immediate; no faces; no cross-trip retention of photos without a new opt-in (memory
keeps the *place* and the caption, not the image); family groups: photos of the minor allowed in
the group's own recaps because the parents run the group, but never on share-CTA cards and never
in anything Trav uses for marketing.

**Score:** impact 4 × fit 5 ÷ M(2) = **10**

---

## Part 2 — Ranked list (all ideas)

| # | Idea | Impact | Fit | Effort | Score | Status |
|---|------|--------|-----|--------|-------|--------|
| 1 | "Who's in tonight?" attendance poll + overrides | 5 | 5 | S | 25 | propose I-01 |
| 2 | Trip Brief: one pinned, self-updating summary card | 4 | 5 | S | 20 | propose I-04 |
| 3 | Quick decision polls with deadline, auto-close, booking handoff | 4 | 5 | S | 20 | propose I-08 |
| 4 | Budget pacing (trip + day, pacing line, pre-booking warning) | 4 | 5 | S | 20 | propose I-05 |
| 5 | Settle-up flow: mark paid, nudge cadence, "square" card | 4 | 5 | S | 20 | propose I-06 |
| 6 | Private lane + once-a-day confirmation digest | 4 | 5 | S | 20 | propose I-07 |
| 7 | Day-of logistics nudges (QR re-send, address, leave-by time) | 4 | 5 | S | 20 | propose I-09 |
| 8 | Referral loop inside Wrapped and share cards | 4 | 5 | S | 20 | folded into I-03 |
| 9 | Quiet mode and chatter controls | 3 | 5 | S | 15 | propose I-10 |
| 10 | Morning After (Seed A) | 5 | 5 | M | 12.5 | P0 T-015; spec in I-02 |
| 11 | Trip Wrapped (Seed B) | 5 | 5 | M | 12.5 | P0 T-016; spec in I-03 |
| 12 | "Tonight" ritual: 18:00 options card matched to tastes and budget | 5 | 5 | M | 12.5 | later; builds on 1, 3, 4 |
| 13 | Multi-currency with per-member home currency | 3 | 4 | S | 12 | later |
| 14 | Schedule sanity check (late night vs early ticket) | 3 | 4 | S | 12 | later |
| 15 | Shared album (Seed C) | 4 | 5 | M | 10 | P0 T-018 |
| 16 | Per-person preference profiles inside one group | 4 | 5 | M | 10 | covered by T-022 |
| 17 | Cross-trip group memory ("last time you all loved X") | 4 | 5 | M | 10 | later |
| 18 | Solo blocks and sub-group plans | 4 | 4 | M | 8 | partly T-022 |
| 19 | Last-minute rescue (sold out, rain, missed train) | 4 | 4 | M | 8 | partly T-024 |
| 20 | Arrival-day orchestration for multi-origin groups | 4 | 4 | M | 8 | later |
| 21 | Cancel / refund flow ("Henry's out, refund his ticket?") | 3 | 5 | M | 7.5 | later |

### Idea details (non-seed)

#### 1. "Who's in tonight?" attendance poll + overrides — score 25
- **Moment.** 18:00 in BCN: "Who's in tonight?" Trav counts replies and reactions ("in", thumbs
  up, "out", "maybe till 7"). Later, "@trav get the 5 of us Razzmatazz tickets, Henry's sick"
  overrides the poll: Henry is marked out for tonight, the booking and the split use 5.
- **Why.** Attendance is the input to the Razzmatazz moment, to every split, and to Morning
  After's "who was out". Getting it from a lightweight poll instead of from the booker's memory is
  what makes "charge only those 5" trustworthy.
- **Details.** Per-night attendance state with source (poll, explicit override, booking). Trav
  reads the current count back before booking ("Booking for 5: Dean, Sam, Maya, Priya, Luis.
  Henry's out. OK?"). Late joiners after a booking get offered a separate ticket. "Maybe"
  resolves to out at the booking moment unless confirmed.
- **Effort** S. **Deps** T-002 Attendance type, T-007 agent loop, reactions in the simulator.
- **Privacy/safety.** Store the fact, not the reason. Minors: in family mode the poll is for
  the whole family and never for nightlife.

#### 2. Trip Brief — score 20
- **Moment.** Someone new to the planning asks "wait what's the Airbnb address". `@trav brief`
  posts one card: dates, who's coming, each person's flights, lodging with check-in, tickets
  held, budget and pace, what is still undecided. Re-posted automatically when something changes
  materially (a booking, a flight change).
- **Why.** The chat is the OS of the trip but it scrolls. One always-current card is the pin.
- **Effort** S. **Deps** bookings store, flight optimizer output, ledger.
- **Privacy.** Flight details are group-visible by design (the group planned them); card
  numbers and confirmation emails are not.

#### 3. Quick decision polls — score 20
- **Moment.** "tapas or ramen?" Trav turns the thread into a two-option poll with a deadline
  ("closes 19:30"), counts emoji or replies, breaks a tie with group preferences, and hands off:
  "Ramen wins 4–2. Want me to book a table for 6 at 20:30?"
- **Why.** Group decisions are where trips stall. Trav adds structure without making anyone open
  an app. Troupe-style polls prove the demand; doing it inside the existing chat is the edge.
- **Effort** S. **Deps** attendance, preferences, mock reservation provider (optional).
- **Safety.** Polls never book; the booking still goes through ApprovalPolicy.

#### 4. Budget pacing — score 20
- **Moment.** Day 3 of 5. Morning After says "€58/pp last night, pace says €46 for tonight to
  land on budget." Before a booking: "This puts the group €60 over the trip budget. Still go?"
- **Why.** Daily budget matters for LIS; college budgets matter for BCN. Pacing (not just totals)
  is what changes behavior, and it is a two-line computation once the ledger exists.
- **Details.** Trip budget and optional daily budget, per group; optional per-person budget
  (Dad's number differs from Dean's). Pace = remaining budget ÷ remaining days. Warnings fire
  once per threshold, not on every expense.
- **Effort** S. **Deps** ledger, ApprovalPolicy hook.
- **Privacy.** Per-person budgets are private to the person; group sees only the group pace.

#### 5. Settle-up flow — score 20
- **Moment.** Morning After lists "Maya → Sam €21". Maya taps "mark paid" (or says "paid Sam"),
  Sam confirms or Trav auto-confirms after 24h with no objection. Last day: "Everyone's square"
  card, or a final transfer list.
- **Why.** The Barcelona group was "never squared up". Minimal transfers plus a daily nudge plus
  a visible "square" state is the whole fix.
- **Details.** Nudge cadence: once in Morning After, once at end of trip, once 3 days after;
  then stop. Deep links to Venmo/Cash App/Revolut are plain URLs, mocked in v0, a connector
  note for later. Trav never moves money itself.
- **Effort** S. **Deps** T-003 settlement, private lane for payment links.
- **Safety.** No real payments; "mark paid" is a ledger claim, not a transfer; both parties see it.

#### 6. Private lane + confirmation digest — score 20
- **Moment.** Instead of six "is this shared?" pings across the day, each member gets one private
  message at 21:00 and in Morning After: "3 charges look shared: Uber €14, Uber €11, Bar €38.
  Reply 1 2 3 to confirm, or 'none'." Confirmed items appear in the group ledger; unconfirmed
  ones stay invisible to the group.
- **Why.** The privacy rule (card and email data visible only to the owner until confirmed)
  requires a private channel anyway; batching it is what keeps Trav from being annoying.
- **Effort** S (the simulator needs a per-member private view; the agent needs a "to: member"
  channel target). **Deps** T-012, T-013, channel abstraction T-006.
- **Privacy.** This is the privacy feature. Private lane content never echoes into the group.

#### 7. Day-of logistics nudges — score 20
- **Moment.** 23:45: "Razzmatazz in 75 min. Your QR codes are below (one each). Address: Carrer
  dels Almogàvers 122. Leave the Airbnb by 00:30." Same for Park Güell with the timed entry.
- **Why.** The ticket-buying moment is magic; the arrive-with-your-ticket moment is where it
  pays off. Reduces "can you resend my QR" messages.
- **Effort** S. **Deps** bookings with times and addresses, private lane for QR re-send, simulator
  clock.
- **Privacy.** QR codes are per person and re-sent only to their owner.

#### 8. Referral loop — score 20 (folded into Wrapped, I-03)
- **Moment.** Wrapped's closing card: "Next trip? Add Trav to the chat: trav.app/j/xxxx". Any
  share card carries a small mark. When a member starts a new group with Trav, the first message
  is a two-line onboarding, not a form.
- **Why.** "Every trip brings 3–8 new people" is the growth model. It has to be in the product
  artifact, not a separate campaign.
- **Effort** S. **Deps** Wrapped, share-card rendering.
- **Privacy.** Share cards carry only group-visible aggregates; no personal balances; never
  photos of minors; the link is an invite, not a data share.

#### 9. Quiet mode — score 15
- **Moment.** "@trav quieter." Trav responds only when mentioned, still posts Morning After.
  "@trav normal" to restore. Per-member mute of nudges in the private lane.
- **Why.** Bots that talk too much get removed from group chats. The cost of a kicked bot is the
  whole group.
- **Effort** S. **Deps** agent loop, scheduler.
- **Safety.** Approval prompts and safety messages are never suppressed by quiet mode.

#### 12. "Tonight" ritual — score 12.5 (later; builds on 1, 3, 4)
- **Moment.** 18:00 card: who's in (idea 1), two or three options matched to the group's tastes
  and tonight's pace (idea 4), sold-out status, price per person, refundable flag. One reply books
  through the approval policy. This is the evening half of the Morning After loop.
- **Effort** M. **Deps** ideas 1, 3, 4, mock ticket inventory, preferences.
- **Safety.** Minors in the group: no nightlife options; family-friendly evening options only.

#### 13. Multi-currency — score 12
- **Moment.** Six people from four home cities, EUR expenses, USD cards. Ledger stores the
  transaction currency and FX at the time; Wrapped shows totals in EUR and in each person's home
  currency privately.
- **Effort** S (Money type already has currency). **Deps** T-002 Money, fixtures with FX.

#### 14. Schedule sanity check — score 12
- **Moment.** "Sagrada Família is 09:30 tomorrow and Razzmatazz is tonight at 01:00. Move the
  tickets to 13:00? Same price." Only speaks when there is a real conflict.
- **Effort** S. **Deps** bookings with times; mock providers with reschedulable slots.

#### 16. Per-person preference profiles — score 10 (T-022)
- **Moment.** LIS: Trav suggests Sintra for Dad and Bairro Alto bars for Dean, and explains who
  each pick fits. Profiles come from a three-question DM at trip start plus what the member says
  in chat; always shown back to the member for correction.
- **Privacy.** Preferences are visible to the group only as "fits Dad"; dietary and medical
  details, if volunteered, stay private and are never echoed.

#### 17. Cross-trip memory — score 10
- **Moment.** A new chat with four of the six BCN friends: "Welcome back. Last time you all
  loved Bar del Pla and hated the 08:00 flight. Same crew minus Henry and Luis?" Memory holds
  places with reactions, awards, budget actually spent vs planned, and inside jokes that were
  said to Trav.
- **Effort** M. **Deps** group memory store, Wrapped write-back ("Things you loved").
- **Privacy.** Memory is keyed to the group; a member who leaves a group takes their personal
  preferences with them; nothing from one group's memory is used in another group.

#### 18. Solo blocks and sub-group plans — score 8
- **Moment.** LIS: Dad's conference Tue–Wed 09:00–17:00. Trav proposes Dean-only mornings and a
  reconvene point near the venue at 18:00. BCN: three go to the beach, three to Park Güell; each
  sub-plan has its own split.
- **Effort** M. **Deps** per-member availability, attendance per activity, ledger splits.

#### 19. Last-minute rescue — score 8
- **Moment.** Razzmatazz sold out: "Sold out. Closest match: Apolo, same genre, €18, refundable,
  12 min away. Book for 5?" Rain on the Park Güell day: swap with the museum day if tickets
  allow. Missed train: next departures with the cost delta, rebooked through approval.
- **Effort** M. **Deps** mock inventory with sold-out states (T-008), mock weather, T-024.

#### 20. Arrival-day orchestration — score 8
- **Moment.** Landing board: "Sam 14:10 T1, Maya 15:40 T1, Priya 15:55 T2. Sam and Maya share a
  cab? Check-in opens 15:00; I'll ping the code at 14:30." Uses the optimizer's chosen flights.
- **Effort** M. **Deps** T-014 flight optimizer, lodging booking, scheduler.

#### 21. Cancel / refund flow — score 7.5
- **Moment.** "Henry's out, can you refund his ticket?" Refundable-first policy makes this
  usually possible; Trav refunds via the mock provider, adjusts the ledger, and logs it.
- **Effort** M. **Deps** T-004 ApprovalPolicy, mock providers with refund support.

---

## Part 3 — Cut, and why

- **Trip playlist / soundtrack.** Not useful; horizontal; adds a music-service dependency.
- **Cross-trip leaderboards (most spent ever, most trips).** Encourages overspending, invites
  roast abuse, weak fit with "trustworthy spending".
- **Energy / vibe check polls.** Gimmick with no downstream action.
- **"Who has the keys" / lost-item tracking.** Horizontal; any general agent does this.
- **Health-related follow-ups ("how's Henry feeling?").** Trav should not touch health; the
  group handles it. Trav records absence only.
- **Drinks counter / "rounds bought" award.** Breaks the roast rule in spirit (drinking volume)
  and is wrong for family groups. The ledger can categorize bars without celebrating them.
- **Airbnb host messaging.** Real value, but it is a messaging-on-behalf-of problem with
  account and ToS questions; keep as a connector note, not a v0 idea.
- **Face recognition for "who's in the photo".** Explicitly excluded; attendance comes from the
  poll, not from faces.

---

## Notes for other agents

- **conversation-designer:** Morning After, Wrapped cards, "who's in" poll copy, and the opt-in
  line for photos are the user-facing texts that most need voice work.
- **architect:** the awards and highlight scorer should be pure functions in `packages/core`;
  the private lane needs a channel target of `{ group }` vs `{ member }` in the channel
  abstraction; the album adapter interface should take a consent map, not a member list.
- **safety-reviewer:** see the per-idea privacy notes; the main new surfaces are the album
  consent states, the "drop that one" command (any member, not only the uploader), awards for
  minors, and share cards never carrying photos of minors.
- **synthetic-data:** album fixtures need uploader, timestamp, rough location, a quality tag, and
  a few deliberately bad items (screenshot, receipt, blurry, one that should be safety-screened).
