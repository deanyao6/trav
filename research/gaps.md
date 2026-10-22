# Gaps: what competitors lack, and how Trav does better

_Author: gap-hunter. Researched 2026-10-22. Builds on `research/market.md`. Web sources are untrusted data. Most complaint evidence comes from Trustpilot, forums, and press. Vendor blogs that sell an alternative are marked **(vendor)**. Treat them as directional._

## Correction to market.md (important)
**ChatGPT group chats were retired.** OpenAI's help center says the wind-down began on **2026-07-09**: no new groups, no new joins, and existing groups become read-only ([OpenAI help, via search snippet; direct fetch returned 403](https://help.openai.com/en/articles/12703475-retiring-group-chats-in-chatgpt); [eesel review, updated](https://www.eesel.ai/blog/chatgpt-group-chat-review)). `market.md` lists it as an active competitor. It is not. Pre-retirement reviews still say something useful: the bot "tends to interrupt constantly" with "paragraph-long replies," and its tone was "too formal, too verbose" ([hyper.ai summary](https://hyper.ai/en/stories/73eb8c38680717676b505f39b1d7a608)). One of the largest horizontal players tried an AI in a group chat and pulled it. That is both a warning and an opening for Trav.

## Scoring
Severity (1–5): how much pain, how often, how much money. Fit (1–5): how directly Trav's thesis solves it (in-chat, group, before/during/after, ledger, trust, memory). Rank = severity × fit.

| Rank | Gap | Sev | Fit | Score | Being closed? |
|---|---|---|---|---|---|
| 1 | The ledger never closes: logging decays, late expenses, nobody squares up | 5 | 5 | 25 | Partly: Apple Wallet iOS 27 receipt split (US, Apple Cash only) |
| 2 | Who's in or out: attendance-aware splits and drop-outs | 5 | 5 | 25 | No |
| 3 | The organizer fronts everything and chases friends for money | 5 | 4 | 20 | Partly: Instinct "split the cost" (mechanics unknown) |
| 4 | Trust: agents act without asking or book the wrong thing | 5 | 4 | 20 | Instinct says it "asks permission"; early users say otherwise |
| 5 | Cross-border settle-up: the payment rails don't work abroad | 4 | 4 | 16 | No (Venmo and Apple Cash are US only) |
| 6 | The group chat is noisy and decisions stall | 4 | 4 | 16 | No (ChatGPT retired) |
| 7 | Tools go silent during the trip | 3 | 5 | 15 | Mindtrip may extend; Romie dormant |
| 8 | Data overreach: can't revoke, can't delete | 4 | 3 | 12 | Instinct added a delete tool after backlash |
| 9 | Memory: photos scattered, nothing carries to the next trip | 3 | 4 | 12 | Polarsteps/Google Photos are solo or app-bound |
| 10 | Multi-origin flight alignment (both legs) | 4 | 3 | 12 | **Yes, partly**: Mindtrip Flights, Holiwise "synchronized flights", PanFlights |
| 11 | Hidden fees and drip pricing | 3 | 3 | 9 | Mostly closed by regulation (FTC rule, May 2025) |

---

## 1. The ledger never closes (logging decays, late expenses, nobody squares up)
**Evidence**
- Splitwise's free tier caps entries per day and adds ad timers. Trustpilot reviewers, 2026: "Can't add more than 2 expenses a day" (27 Aug 2026); "the new limit of only 3 transactions per day is ridiculous"; "the 10-second countdown you have to wait through just to add a single expense" (26 Feb 2026). A golf-trip user who used to praise it now calls it "completely useless" (27 Apr 2026). ([Trustpilot AU](https://au.trustpilot.com/review/splitwise.com); [Gerald, Aug 2026 (vendor)](https://joingerald.com/learn/cash-advance/splitwise-app-review))
- Settling early is a known trap. "Sometimes people settle up prematurely, and then someone realizes they forgot to add a dinner… creates a bunch of extra Venmo transactions." (Lemmy thread, via search snippet; direct fetch failed: [lemmy.ndlug.org](https://lemmy.ndlug.org/post/941217/2201468))
- Logging decays because people put it off ("I'll do it later") until a group stops logging altogether ([Pilot (vendor)](https://www.pilotplans.com/blog/splitwise-review)). Splitwise's own pitch is avoiding the moment "two months later that you paid for that Airbnb and never got reimbursed" (same source).
- Accuracy distrust: "I don't believe the reconciliations" (Splitwise, Oct 2025). A Splid trio found amounts "hundreds of dollars off" ([justuseapp](https://justuseapp.com/en/app/991473495/splid-split-group-bills/reviews)). Tricount has math-inaccuracy complaints ([chrome-stats summary](https://chrome-stats.com/d/id349866256)).
- This is MOTIVATION.md's own story: "everyone forgot about them after the trip. Nobody was ever squared up."

**Who suffers:** whoever paid most (usually the organizer), and every group past day 2 of a trip.
**Size:** universal on group trips. It is the main reason people leave the category leader.

**How Trav does it better**
- **Capture, don't ask for entry.** Expenses come from chat text, receipt photos, email, and card imports (T-010 to T-013). There is never a cap on entries.
- **A "loose ends" sweep before any settle-up.** The daily settle-up is never final. On the last day, Trav posts one message: "Before I close the books: 3 things look unlogged" (the owner's pending private items are counted only, never shown to the group, plus bookings without a split). Settle-up closes after a **48-hour late-expense window** (a setting).
- **Delta settle, not re-settle.** An expense added after the close produces only the *incremental* transfers ("Adding Maya's €40 taxi changes one thing: Leo → Maya €8"). It never produces a new full transfer list.
- **Reconciliation proof.** `@trav show the math` shows every member's paid, owed, and net from the ledger, and the totals sum to zero (this builds on M-04 and M-06).

## 2. Who's in or out (attendance-aware splits and drop-outs)
**Evidence**
- Splitwise, 27 Aug 2026: "No options to choose selective people in a group for split percentages." ([Trustpilot AU](https://au.trustpilot.com/review/splitwise.com))
- Splitting things not everyone used causes resentment. A $100+ liquor run on a cabin trip was split among everyone though "only one or two people drank it… Several of us were annoyed" (Lemmy, via search snippet).
- Drop-out fights. In an Aruba villa case, the organizer was left covering a $4,000 balance the night before the flight ([AOL](https://www.aol.com/news/woman-fumes-her-friend-refuses-175741879.html)). WeddingWire threads argue over whether drop-outs owe their share ([thread](https://www.weddingwire.com/wedding-forums/last-minute-drop-out-from-my-bachlorette-party/c5a041fcacf1ac3a.html)). Bustle survey: 45% say a last-minute drop-out should still pay for lodging "if it was already discussed," and 36% say it depends on the reason ([Bustle](https://www.bustle.com/life/money-etiquette-friendship-survey)). Many people don't agree on the rule, so the group has to set it *before* booking.
- Groups "branch." Planners don't support sub-groups doing different things: Wanderlog's "UI doesn't really support 'branching' trips" ([Tildes](https://tildes.net/~travel/1897/whats_your_planning_process_for_big_group_trips)).

**Who suffers:** groups of 5 or more, and trips with nightly or optional activities (Barcelona clubs, Lisbon conference blocks).
**Size:** high. It's the Razzmatazz moment ("Henry's sick"), and no splitter or planner models attendance.

**How Trav does it better**
- **A roster per activity as a first-class object.** Every booking or expense is tied to an `Activity` with its attendees. "Who's in tonight?" becomes a one-tap roll call in chat. The roster drives both the ticket count and the split, so they can never disagree.
- **A drop-out policy set before booking.** When a shared booking is proposed, Trav states the rule in the approval card: "If someone drops after booking: refundable share → refunded and re-split; non-refundable share → they still owe it (group can override)." That way the rule is agreed before money moves, not argued afterward.
- **Re-split on a roster change.** If someone drops out of a refundable booking, Trav cancels that seat (mock) and re-splits. For non-refundable bookings it keeps the drop-out's share unless the group explicitly votes to absorb it. Every change is audit-logged.

## 3. The organizer fronts everything and chases friends for money
**Evidence**
- The maid of honor or best man "typically" puts thousands on a personal card, then spends weeks chasing payments ([payit2 (vendor)](https://payit2.com/use-cases/parties-celebrations/bachelor-bachelorette); [ModernMOH](https://modernmoh.com/bachelorette-party/split-collect-money/) recommends collecting before booking).
- Asking is socially costly. Nearly 90% would never request money from a close friend for under $10, and 47% for under $20 ([Bustle](https://www.bustle.com/life/money-etiquette-friendship-survey)). People prefer low-contact methods for repayment requests ([Kelley School](https://blog.kelley.iu.edu/?p=5192)). A Zelle survey (2018, dated) found 86% of women weren't paid back after covering a shared expense.
- Airbnb dropped split payments around 2018, so one person pays and chases the rest ([Business Insider](https://www.businessinsider.nl/how-to-split-payment-on-airbnb)).
- Splitwise, 2025: "I still haven't gotten my money."

**Who suffers:** the organizer, who is also Trav's most likely first user and the person who adds Trav to the chat.
**Size:** high, and it's a strong reason to adopt: the organizer has the most to gain from adding Trav.

**How Trav does it better**
- **Commit before booking.** For big shared bookings (lodging, the Barça match), Trav posts a commit card: "Reply ✅ to lock your spot: €142 each, refundable until Mar 1." The booking runs only once the required number of people have committed, and each commitment is recorded as owed in the ledger. Trav never pre-charges in v0 (mock).
- **Trav does the asking.** Settle-up reminders come from Trav, worded neutrally and sent to the group ("3 transfers left to close Barcelona"). The debtor gets at most one gentle private nudge per day. No member ever has to send an awkward "can you Venmo me" text.
- **Netting small debts.** Small amounts are netted into the minimal transfer set (M-06). No one gets an €8 request.

## 4. Trust: agents act without asking, or book the wrong thing
**Evidence**
- Instinct sent an email "on my behalf without checking with me first" (Katie Jacobs Stanton). After Claire Vo disconnected Google, Instinct kept summarizing her inbox and later confirmed it stored the emails in plain text. It refused deletion until a tool was added later. Its terms allow it to enter "agreements, commitments, or transactions" on your behalf ([TechCrunch, 2026-08-24](https://techcrunch.com/2026/08/24/instincts-powerful-ai-assistant-is-raising-privacy-and-security-concerns/)). Early group-chat users report "inaccurate explanations of its actions" ([letsdatascience](https://letsdatascience.com/news/instinct-adds-ai-agents-to-group-chats-c41e4ac9)).
- Wrong-booking cases: a bot booked a non-refundable hotel in Naples, Florida for a traveler flying to Rome ([Morgan Lewis, Aug 2026](https://www.morganlewis.com/blogs/sourcingatmorganlewis/2026/08/ai-concierge-services-who-is-liable-when-a-bot-books-the-wrong-vacation)). Morgan Lewis recommends explicit confirmation of **destination, dates, number of travelers, total price, and cancellation terms** before non-refundable purchases, plus a reachable human. American Airlines' automated rebooking changed itineraries with no advance notice ([InsideFlyer](https://www.insideflyer.com/posts/american-airlines-ai-rebooks-passengers-without-consent-3/)). Consumers report AI cancelling non-refundable bookings and charging stored cards without approval ([Stacker](https://stacker.com/stories/travel/ai-wall-how-travel-companies-use-bad-ai-can-ruin-your-travel-experience)).

**Who suffers:** everyone in the group, and the payer most of all. In a group, a wrong booking multiplies by headcount.
**Size:** existential for an agent that spends money. One viral screenshot of a bad booking kills trust.

**How Trav does it better** (beyond M-01, M-02, and M-03)
- **A pre-purchase consistency check against trip context.** Before any approval card, Trav checks the booking against the trip: the city matches the trip city (catches the Naples case), the dates fall within the trip, the headcount equals the activity roster, named attendees are group members, and no minor is included in nightlife or 18+ events. Any mismatch → Trav asks a clarifying question instead of showing a buy button.
- **The approval card always includes Morgan Lewis's five fields**: what and where (city and venue), when, who (names, count), **all-in total and per-person total including fees and FX**, and cancellation terms in plain words.
- **"What did you just do?"** is answered only from the audit log, never paraphrased by the model (extends M-03).

## 5. Cross-border settle-up: the payment rails don't work abroad
**Evidence**
- Venmo requires US residency, a US bank account, and a US phone number, and has location limits ([Business Insider](https://businessinsider.nl/does-venmo-work-internationally); [Wise (vendor)](https://wise.com/us/blog/venmo-alternative)). Apple's iOS 27 bill split runs on Apple Cash, which is US only, and every contact must have Apple Cash ([Engadget](https://engadget.com/2249069/apple-wallet-ios-27-update-how-to-split-bills-customize-passes); [BGR](https://bgr.com/2186203/ios-27-apple-wallet-bill-splitting/)).
- Tricount FX bug: rates "set to 1:1" and "won't convert euro to sterling" ([justuseapp](https://justuseapp.com/en/app/349866256/tricount-ausgaben-teilen/problems), undated). Splitwise puts currency conversion behind Pro (market.md).

**Who suffers:** study-abroad and mixed-nationality groups (a natural Barcelona case: a US student plus EU friends).
**Size:** medium-high for Trav's first market (study-abroad weekends are named in MOTIVATION.md).

**How Trav does it better**
- **Rail-aware settle-up.** Each member sets how they get paid (Venmo, Revolut, Wise, PayPal, Bizum, cash) privately with Trav. Each settle-up line shows a rail both people can use ("Leo → Maya €31 via Revolut"). Where none is shared, Trav says so and suggests cash or a common app. In v0 these are mock deep links; no money moves.
- The FX rate is locked at expense time and shown on request (M-05).

## 6. The group chat is noisy and decisions stall
**Evidence**
- ChatGPT group chats "interrupt constantly" with "paragraph-long replies," and their tone was "too formal, too verbose" ([hyper.ai](https://hyper.ai/en/stories/73eb8c38680717676b505f39b1d7a608)). The feature was later retired (see correction above).
- Users can't remove Meta AI from WhatsApp, only block it per chat, and that draws complaints ([Hola](https://www.hola.com/us/lifestyle/20250826852218/why-you-cant-deactivate-meta-ai-whatsapp/); [heise](https://heise.de/-10538187)).
- Decision stall: "Days pass, but nothing gets booked." The usual advice is no more than 3 options, a 24-hour vote deadline, and decisions moved out of the chat ([Zafigo](https://zafigo.com/lifestyle/group-travel-planning-tips-avoid-decision-fatigue/); [WSJ via To Vima](https://tovima.com/wsj/men-have-group-chat-drama-too-heres-their-advice-for-successful-trip-planning)). A study cited secondhand says 46% of British travellers mute the group chat to dodge planning ([briefglance](https://briefglance.com/articles/the-holiday-hero-economy-how-travel-tech-is-tackling-group-trip-burnout), unverified). Tildes: "a little higher friction than I expected… way too much to choose from" ([Tildes](https://tildes.net/~travel/1897/whats_your_planning_process_for_big_group_trips)).

**Who suffers:** every group, and especially groups of 6 or more.
**Size:** high. A noisy bot gets removed from the chat, and Trav dies with it.

**How Trav does it better**
- **A message budget enforced in code, not just in the prompt.** Trav replies to mentions and direct follow-ups only. It sends at most N proactive messages per group per day (default 2: Morning After and settle-up, plus urgent disruptions). Group replies have a hard length budget (for example 6 lines, with longer content collapsed into a card). Evals fail any reply that exceeds the budget.
- **Polls with a deadline and a default.** "@trav help us pick dinner" → at most 3 options, one-tap votes, and a deadline ("closing at 8pm"). At the deadline Trav announces the winner and offers to book it through the normal approval flow. It never auto-buys because a deadline passed.

## 7. Tools go silent during the trip
**Evidence**
- Market.md: planners (Mindtrip, Layla, Booking, Kayak) stop at booking. Romie, the one in-trip group assistant, never got past alpha (no 2025–26 updates). Even AI-planner vendors admit "most apps cannot adapt live" ([Yolda poster, student project](https://senior.ceng.metu.edu.tr/2026/mainpage/posters/Yolda-poster.pdf)).
- Details get lost in the chat: a hotel guide tells groups to keep "the hotel address and check-in time, meet-up point, payment deadline" in one place ([ibis](https://ibis.accor.com/en/ibis-magazine/hassle-free-stays/how-to-plan-for-a-group-holiday.html)). MOTIVATION.md: Airbnb check-in logistics were a back-and-forth.

**Who suffers:** everyone, every day of the trip. Most of all, whoever holds the tickets or the door code.
**Size:** medium in pain, but very high for Trav's thesis ("during" is the part nobody else does).

**How Trav does it better**
- **Day-of logistics resurfacing.** Trav already holds the bookings, so the right info goes to the right person at the right time: each attendee privately gets their own QR code shortly before doors open ("Razzmatazz doors 00:30. Your ticket ↓"), and the group gets check-in details on arrival day. This is driven by the simulator clock, not polling.
- Disruption nudges are M-15 (market). This gap strengthens the case for it.

## 8. Data overreach: can't revoke, can't delete
**Evidence**
- Instinct: it kept summarizing an inbox after Google was disconnected, stored emails in plain text, refused deletion until a tool was added, and its terms grant a "perpetual and irrevocable" license ([TechCrunch](https://techcrunch.com/2026/08/24/instincts-powerful-ai-assistant-is-raising-privacy-and-security-concerns/); [eesel](https://www.eesel.ai/blog/instinct-ai-review)). You can't unlink a bunq account from Tricount (market.md). Meta AI can't be removed from WhatsApp.

**Who suffers:** members who connect a card, email, or photos, and anyone whose friend connects theirs.
**Size:** medium now, high as a trigger for one bad news story.

**How Trav does it better**
- **Revoke means delete.** "@trav stop reading my card" (M-10) also **purges** that member's raw, unconfirmed card and email items from Trav's store. Confirmed shared ledger items stay, because the group relies on them.
- **Trip-end minimization.** When a trip closes, raw imported data (email bodies, card transaction lists) is deleted and only confirmed ledger entries are kept. `@trav what do you have on me` (sent as a DM to the member) lists exactly what Trav stores about them.

## 9. Memory: photos scattered, nothing carries to the next trip
**Evidence**
- Albums fail when contributing takes an account, an app, or a separate step. iCloud contribution needs an Apple device, Google Photos contribution needs Google Photos, and other people can't add to Facebook albums ([Yogile (vendor)](https://www.yogile.com/blog/best-way-to-share-vacation-photos); [FamilySearch forum](https://community.familysearch.org/fr/discussion/comment/572490)). Market.md: "The problem is behavioral: nobody makes one."
- Polarsteps and Pangea recaps are per person. I found no product that remembers a *group's* tastes and history across trips (market.md; Mindtrip keeps chat history within its own app).

**Who suffers:** every group after the trip. The loss is quiet, but it costs Trav its retention loop.
**Size:** medium pain, high strategic value (MOTIVATION.md defensibility #3).

**How Trav does it better**
- **The album lives in the chat** (T-018). Opted-in members get one private nudge a day: "drop your 3 best from today." There's no new app or account.
- **Cross-trip group memory you can see and edit.** When a new trip starts with the same group, Trav opens with what it remembers ("Last time: Barça match, late dinners, ~€70/day each. Same vibe?"). `@trav what do you remember about us` lists it, and `@trav forget X` removes an item. Group memory holds only group-level facts, never personal data (privacy constraint).

## 10. Multi-origin flight alignment, on both legs (competitors closing)
**Evidence**
- Google Flights takes up to 7 origins but ranks by price only, with no arrival alignment across travelers ([Thrifty Traveler](https://thriftytraveler.com/guides/google-flights/search-multiple-cities/)). Niche tools do it: PanFlights weights "arrival time differences" ([PanFlights](https://panflights.com/post/find-flights-from-different-cities-to-a-common-meetup-destination/)), FlightsMeet takes up to 10 origins ([AlternativeTo](https://alternativeto.net/software/flightsmeet/about)), and MeetPoint finds the cheapest meetup city ([chatgate (vendor)](https://chatgate.ai/post/meetpoint)).
- **Being closed:** Mindtrip Flights tries airport combinations (May 2026) and Holiwise claims "synchronized flights" (market.md). None of them handles different *return* cities, which is MOTIVATION.md's exact case, or per-person fairness.

**How Trav does it better:** strengthen M-11 / T-014. Optimize *both* the arrival spread and the departure spread when return cities differ, add a **fairness constraint** (nobody pays more than X% above the group median unless they opt in), and give a one-line trade-off per option. No new task; see the notes in `tasks/proposed/gaps.md`.

## 11. Hidden fees and drip pricing (mostly closed by regulation)
**Evidence:** a class-action solicitation alleges SeatGeek revealed "substantial fees only at the end of checkout" ([Labaton](https://lantern.labaton.com/Case/SeatGeek)). Since the FTC rule took effect on 2025-05-12, SeatGeek says all-in pricing is the default ([PBS/AP](https://www.pbs.org/newshour/nation/a-biden-era-junk-fee-rule-is-now-in-effect-ticketmaster-says-it-will-display-fees-more-clearly)). EU club sites and FX conversion can still surprise people.
**How Trav does it better:** every proposal shows the **all-in total and all-in per person, in the trip currency**, including fees and FX. This is folded into G-07's acceptance criteria.

---

## Competitors about to close a gap (watch list)
- **Apple Wallet / Visual Intelligence bill split (iOS 27, fall 2026):** receipt photo → item assignment → Apple Cash requests, with tax and tip included ([Engadget](https://engadget.com/2249069/apple-wallet-ios-27-update-how-to-split-bills-customize-passes); [9to5Mac](https://9to5mac.com/2026/06/01/ios-27-to-add-new-wallet-app-feature-for-splitting-bills-report)). This **closes single-receipt itemized splitting for US iPhone groups**. Trav's receipt flow (T-011/M-08) is no longer a differentiator alone. What Apple lacks: a trip ledger across many expenses, attendance-aware splits, non-US and Android members, card and email capture, and settle-up netting. Lead the pitch with the *trip* ledger, not the receipt trick.
- **Instinct (group agent, 2026-10-05):** "buy tickets when they go on sale, split the cost, send one to each person." That is a direct shot at the Razzmatazz moment. Trav's moat has to be the attendance roster, the approval policy, receipts from the audit log, and the ledger that persists after the purchase.
- **AI receipt splitters (FairShare iOS Sept 2026, SplitFlash, SplitMyExpenses)** ([hunted.space](https://www.hunted.space/product/fairshare-ai-bill-splitter)): commoditizing receipt OCR.
- **Mindtrip / Holiwise:** multi-origin flights (gap 10).
- **Not closing:** ChatGPT group chats were retired 2026-07-09. Romie appears dormant.

## Sources (accessed 2026-10-22)
Listed inline above. Fetch failures: lemmy.ndlug.org (TLS error; quoted from search snippet), help.openai.com (403; quoted from search snippet and the eesel update), stuff.tv (403).
