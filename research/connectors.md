# Trav connectors: feasibility, cost, terms-of-service risk

Owner: connector-scout. Researched 2026-10-22 from public docs only (no sign-ups, no credentials, no live calls).
"Verified" means I read it on the vendor's own docs page on 2026-10-22. "Secondary" means it came from press or third-party pages, so check it before relying on it. Prices change, so re-check before any commercial decision.

## TL;DR

- **The flagship UX (Trav inside an existing iMessage group) is only reachable through unofficial relays** (Sendblue, Linq, LoopMessage, and similar) that run Apple IDs on Mac hardware. Apple has no official API for consumer group chats, and Apple Messages for Business explicitly does not support groups. This is the biggest platform risk. Plan for it, don't treat it as solved.
- **WhatsApp now has an official Groups API**, but it caps groups at 8 participants, is invite-link only, and doesn't support interactive messages (no buttons) in groups. That's enough for a 6-person Barcelona group, but approvals have to be text replies.
- **The Razzmatazz moment can't be done for real through a public API.** The club sells through Xceed and its own site, and neither Xceed nor DICE has a public purchase API. Ticketmaster purchase is partner-only, and SeatGeek and Fever are search plus affiliate links. Real "buy and post QR codes" for nightlife needs a direct deal with Xceed or the venue. v0 stays mock.
- **Flights are the most viable real booking integration:** Duffel has self-serve test mode with real booking semantics. Amadeus Self-Service shut down on 2026-07-17.
- **Airbnb is closed.** There's no public API for guest booking or host messaging. Use hotel and apartment wholesalers (Hotelbeds, Expedia Rapid, Duffel Stays), or deep-link to Airbnb.
- **Settle-up has to be "request + deep link + mark paid", not Trav moving money.** Venmo's API has been closed to new developers since 2016. Moving money between friends would make Trav a money transmitter.
- **Card data (Plaid) and email (Gmail API) are feasible but heavy on compliance.** Gmail read scopes are "restricted" and need an annual CASA security assessment. A per-member **forwarding address** avoids that entirely.

## Main table

Access model: **open** = self-serve key; **partner** = approval, contract, or certification; **closed** = no access for new developers.
Verdict: **mock now** = build the mock against this shape in v0; **integrate later** = real adapter is viable after v0; **avoid** = don't build on it.

| # | Service | What it enables for Trav | Access | Cost (as found) | ToS / legal risks | Sandbox | Verdict |
|---|---|---|---|---|---|---|---|
| **Messaging** | | | | | | | |
| 1 | **Sendblue** (iMessage relay) | Trav as a real participant in an iMessage group: send/receive, media, add members, rename group, inline replies | partner (group API is beta, "select plans only, contact sales"; outbound group creation needs the "Blue Ocean" plan; AI Agent plan can only reply in groups it was added to) | AI Agent plan listed at **$100/line/month** on the pricing page (Sendblue's own blog says ~$29, a conflict); outbound/enterprise pricing is custom | Relies on Apple IDs on Apple hardware, which Apple does not sanction. Lines can be flagged or rate-limited by Apple. Removing members needs 4 or more people (an Apple rule). `504 outcome_unknown` on group changes. Spam/consent rules (TCPA) for outbound. | No public sandbox; free shared-line plan needs participant verification | **integrate later** (best iMessage option, but beta); design the channel interface so it fits |
| 2 | LoopMessage, Linq, Blooio, Project Blue (iMessage relays) | Same category as Sendblue | partner/paid | Not verified | Same Apple risk. I couldn't find LoopMessage's official group-chat docs (secondary pages only). | Unknown | **integrate later** as alternatives; don't lock in to one vendor |
| 3 | Apple Messages for Business | Official Apple business chat | partner (Apple registration + messaging service provider) | MSP fees | **Group chat with a business is not supported** (Apple FAQ). The user has to start the conversation. | Via MSPs | **avoid** for group use; possibly 1:1 DMs later |
| 4 | **WhatsApp Cloud API: Groups API** | Official group bot: create group, invite link, send text/media/templates in group, receive webhooks | open to businesses with an **Official Business Account (OBA)** (verified on Meta docs) | Per-message pricing for groups (Meta's Groups pricing page) | **Max 8 participants**, invite-link join only (can't add people directly), **no interactive messages** (no buttons/lists) in groups, no edit/delete, 10k groups per number. Getting an OBA (green badge) is itself a review. | Meta test numbers for 1:1; group testing needs OBA | **integrate later**, the most legitimate group channel; mock button approvals as text replies ("reply YES") |
| 5 | Telegram Bot API | Bot in group chats with inline keyboards (approval buttons), DMs | open | Free | Bots run in **privacy mode** by default (see only commands, @mentions, and replies), which matches @trav mention behaviour. Low ToS risk. Smaller user base in the US. | Free (test bots) | **integrate later**, the cheapest real channel for a pilot |
| 6 | SMS/MMS group (Twilio etc.) | Fallback for Android/mixed groups | open | Per message | Group MMS via A2P is unreliable; 10DLC registration in the US; TCPA | Twilio test creds | **avoid** for groups; use for 1:1 private DMs only |
| 7 | RCS for Business (formerly RBM) | Rich 1:1 messaging on Android | partner (carrier/agent approval) | Varies | Secondary sources say it's **one-to-one only; a business can't join a group** | Test devices | **avoid** for groups |
| 8 | How competitors reach iMessage | Instinct (group chats announced ~2026-10-05, early access) shows read receipts, tapbacks, and threaded replies in iMessage. That suggests a relay-style or own-hardware setup, but **not confirmed**. Continua (GV-backed, $8M seed, 2025) runs agents in SMS/iMessage/Discord groups. I couldn't identify "Flip" as a group-chat agent (the only match is an unrelated voice-AI company). | n/a | n/a | They carry the same Apple platform risk as Trav | n/a | Learn from features only |
| **Flights** | | | | | | | |
| 9 | **Duffel** (Flights) | Real multi-airline search, offer re-price, order creation, cancellation quotes, ancillaries; feeds the multi-origin optimizer | open (self-serve signup, test mode) | **$3/order + 1% of order value (managed content) + $2/paid ancillary; $0.005/search above a 1500:1 search-to-book ratio; 2% FX fee** (verified, duffel.com/pricing) | Merchant-of-record and ticketing liability; airline fare rules; you can't book for others without their passenger details; storing passport data is PII | **Yes**: test mode with "Duffel Airways" (ZZ), free of real charges; test schedules and prices aren't realistic | **mock now** using the Duffel offer shape; **integrate later** (first real booking adapter) |
| 10 | Amadeus for Developers (Self-Service) | Was free-tier flight search | **closed**: self-service portal **decommissioned 2026-07-17**; registrations paused since Feb 2026; Enterprise only (secondary: PhocusWire) | Enterprise contract | n/a | None now | **avoid** |
| 11 | Kiwi.com Tequila | Virtual interlining (self-transfer combos are good for cheap multi-origin trips) | partner (I couldn't confirm the current onboarding status; Duffel's own comparison says docs and support are limited) | Revenue share | Self-transfer risk for travellers (missed connections aren't protected) | Unclear | **integrate later** at most; not for v0 |
| **Lodging** | | | | | | | |
| 12 | **Hotelbeds (HBX) APItude** | Hotel and apartment availability, rate recheck, booking, cancellation; also Activities and Transfers suites | open evaluation key on signup; production after certification | Net rates (Trav adds markup or earns commission) | Merchant of record for the stay; rate parity and display rules; "RECHECK" rates must be re-priced before booking | **Yes**: `api.test.hotelbeds.com`, **50 requests/day**, test bookings aren't real (secondary + HBX docs) | **integrate later**, the best self-serve lodging sandbox |
| 13 | Expedia Rapid (EPS) | Huge hotel and vacation-rental inventory | partner (apply; key stays in restricted dev mode until a site/launch review) | Commission/merchant models | Launch requirements include UI obligations | Restricted dev mode / test requests | **integrate later** (needs a business relationship) |
| 14 | Duffel Stays | Hotels via the same vendor as flights | open-ish (contact sales for profit share) | Commission share after checkout | Same MoR concerns | Test mode | **integrate later** (one vendor for flights and stays is attractive) |
| 15 | Airbnb | 6-person apartments, host messaging | **closed**: no public API; partner API only for large property-management/channel-manager software (host side). No third-party guest booking or guest-to-host messaging API | n/a | Scraping or automating airbnb.com violates its ToS | None | **avoid** API work; Trav can **deep-link** to listings, and the group pastes host messages into chat for Trav to summarize |
| **Events, tickets, attractions** | | | | | | | |
| 16 | Ticketmaster Discovery + Commerce API | Event search (Barça-type sports, concerts), venues, price ranges/offers | open (5000 calls/day, 5 req/s default) | Free | Branding guide and data-representation rules; higher quota needs a compliance check | Live keys only (read-only) | **integrate later** for discovery |
| 17 | Ticketmaster Partner API | Reserve, cart, purchase, order management | **partner only** | Contract | Distributor agreement | Partner sandbox | **avoid** for now (long sales cycle) |
| 18 | SeatGeek Platform API | Event/performer/venue search, price stats, affiliate referral | open (client_id) | Free; affiliate payouts on referred sales | Discovery + redirect only; **no purchase via API** (secondary sources) | n/a | **integrate later** for discovery + "buy here" link |
| 19 | Xceed | Barcelona nightlife (Razzmatazz sells presale/fast-line here) | **no public API found**; B2B product (Xceed Pro) is for organizers | n/a | Automating checkout on the site violates ToS | None | **mock now** (Razzmatazz demo); real version needs a **business partnership** |
| 20 | DICE | Concerts/club nights | partner-only GraphQL (MIO tokens) for partner data (events, ticket holders); **no purchase API found** | n/a | Tickets are bound to the app and non-transferable by design | None | **avoid** API; deep-link |
| 21 | Fever | Experiences (Candlelight etc.) | affiliate/distribution program (links, feeds, "custom integrations") | Commission (6.4–8% reported by affiliate networks, unverified) | Booking happens on Fever's site | None found | **integrate later** as affiliate links |
| 22 | Venue sites (Sagrada Família, Park Güell, FC Barcelona) | Timed-entry tickets | **closed** (consumer websites) | n/a | No APIs; automating checkout violates ToS and anti-bot rules | None | **avoid**; use Viator/GetYourGuide resale instead |
| 23 | **Viator Partner API** | Tours and attractions (incl. Sagrada Família/Park Güell tours), availability, booking | open Basic affiliate (self-serve, redirect to viator.com); **Full + Booking** and **Merchant** need approval + API certification | Affiliate commission; merchant is invoiced | Merchant takes customer-support and payment liability | Sandbox not confirmed in docs I read | **integrate later** (affiliate first, then booking) |
| 24 | GetYourGuide Partner API | Same category; carts and bookings | partner (registration + multi-phase certification, secondary) | Commission | Same | OpenAPI spec is public on GitHub (Apache-2.0) | **integrate later** |
| **Payments and settling up** | | | | | | | |
| 25 | Stripe (test mode) | Charge the card of the member who approved a booking (Trav as merchant); Payment Links; refunds | open | Test mode free; live ~2.9% + 30¢ (US card standard) | Real P2P transfers between friends via Connect = **money transmission** questions and Stripe restricted-business rules; Trav as MoR for tickets/flights brings chargeback liability | **Yes**: full test mode, test cards | **mock now** (Stripe-shaped PaymentIntent); integrate test mode later |
| 26 | Venmo | Friends' default settle-up app (US) | **closed**: Developer/Payouts APIs retired, no access for new businesses (Venmo developer page) | n/a | Unofficial deep links (`venmo://paycharge?...`) are undocumented and can break | None | **avoid** API; use a **prefilled link if it works, otherwise show the handle and amount** |
| 27 | PayPal | Payment request links; Payouts | open (business account; Payouts needs approval) | Fees per transaction | P2P via Payouts is a business-to-consumer flow | Yes (PayPal sandbox) | **integrate later** (PayPal.me links only) |
| 28 | Splitwise API | Export the trip ledger to Splitwise for groups that already use it | open (OAuth 2 app registration) | Free | Commercial-use terms not found; Splitwise is a competitor, so treat as a nice-to-have export | No sandbox | **integrate later** (one-way export at most) |
| 29 | Revolut / Bizum / Wise / Monzo | EU friends' settle-up | Revolut and Monzo have shareable pay links; Bizum has no consumer API | n/a | Deep links only | n/a | **mock now** as link-style methods |
| **Card transactions** | | | | | | | |
| 30 | **Plaid Transactions** | Auto-import each member's card charges; `/transactions/sync` with cursor, enriched `merchant_name`, `personal_finance_category`, `location`, `counterparties` | open sandbox; production needs approval/use-case review | Sandbox free; production is pay-per-Item/month (not public, contact sales) | GLBA-style data handling; Plaid's end-user privacy disclosure; **owner-only visibility is mandatory** (matches CLAUDE.md §2) | **Yes**: Sandbox with test institutions (`user_good`/`pass_good`) | **mock now** with the Plaid sync shape; integrate sandbox later |
| 31 | Alternatives: Teller, MX, TrueLayer / GoCardless Bank Account Data (EU), Tink | Same, with better EU coverage for European members | open/partner | Varies | PSD2 AISP licensing in the EU (via provider) | Most have sandboxes | **integrate later** (EU students on study abroad) |
| **Email receipts** | | | | | | | |
| 32 | Gmail API (read) | Auto-find Uber/Lyft/restaurant receipts in the member's inbox | open, but `gmail.readonly` is a **restricted scope**: Google verification + **annual CASA security assessment** if data touches a server (secondary: few hundred to few thousand $/yr) | Free API; assessment cost | Heavy privacy surface; Google user data policy | Test users (100 max) while unverified | **avoid for v0**; maybe later |
| 33 | **Per-member forwarding address** (e.g. `dean.k3x9@receipts.trav…`) via an inbound email service (SES/Postmark/SendGrid inbound parse) | Member forwards or auto-forwards receipts; Trav parses; items stay private to that member until confirmed | open | Cents per thousand emails | Must authenticate the forwarder (SPF/DKIM of the original sender is lost on forward); spoofing risk; prompt injection inside email bodies | Local fixtures | **mock now**, the recommended real path |
| **Rides** | | | | | | | |
| 34 | Uber Riders API | `history` scope (general) can list a rider's trips; `request_receipt` is **privileged and restricted** (only for apps that request rides; **aggregating receipt data is not allowed**); privileged scopes need Full Access review | partner for anything useful | Free | Using ride history to build expense ledgers is close to the "no aggregation" restriction | Limited Access (own dev accounts) | **avoid**; rely on emailed receipts |
| 35 | Lyft API | Ride history | **closed** to new developers (my understanding; not re-verified today) | n/a | n/a | n/a | **avoid**; emailed receipts |
| **Photos** | | | | | | | |
| 36 | Google Photos Library API | Was: read shared albums | Since **2025-03-31**, the Library API only accesses **app-created media**; `photoslibrary.readonly`/`.sharing` scopes removed (verified via Google release notes) | Free | Photos API User Data and Developer Policy | n/a | **avoid** for reading existing albums |
| 37 | Google Photos **Picker API** | Each member picks the photos they want to share with Trav | open (OAuth) | Free | Per-session picking only, so consent is explicit (good) | Test users | **integrate later** (fits opt-in consent) |
| 38 | Apple iCloud Shared Albums | Most iPhone groups already make one | **closed** (no public API; public-website share links are undocumented) | n/a | Scraping undocumented endpoints | None | **avoid** |
| 39 | **Trav upload link** (own storage; or photos sent into the group chat via the channel adapter) | Members upload or AirDrop-then-upload; photos sent in chat can be added if the sender opted in | open (ours) | Storage only | We become the photo processor: consent, deletion, minors' images | Local | **mock now**, the recommended path |
| **Context** | | | | | | | |
| 40 | Google Maps Platform (Places API New, Routes) | Venue lookup, walking time, "near the Airbnb" | open (billing account) | Since 2025-03-01: per-SKU free monthly thresholds instead of a $200 credit (~10k Essentials / 5k Pro / 1k Enterprise calls per SKU, secondary) | Display and caching limits on Places content | No sandbox; free tier | **integrate later**; mock with fixtures |
| 41 | OpenStreetMap / Nominatim / Overpass | Free geocoding, POIs | open | Free (strict usage policy, 1 req/s on public Nominatim) | Attribution; no heavy bulk use | n/a | **integrate later** (cheap fallback) |
| 42 | Open-Meteo | Weather forecast for recaps and plans | open; **free tier is non-commercial only** (<10k calls/day), commercial needs a paid key | Free / paid commercial plans | CC-BY 4.0 attribution | n/a | **mock now**; paid plan when commercial |
| 43 | Frankfurter (ECB reference rates) | FX conversion for multi-currency ledgers (€ dinners, $ flights) | open, no key | Free | Daily ECB rates (~16:00 CET), weekends return the previous business day; ~30 currencies; I couldn't confirm the base URL (`api.frankfurter.app` vs `api.frankfurter.dev/v1`) | n/a | **integrate later** (easy); mock with fixed rates in v0 |
| 44 | Google Calendar API / ICS files | Put flights, bookings, Dad's conference blocks on calendars; read busy blocks | Calendar API: sensitive scope (OAuth verification). ICS export/import: open | Free | Sensitive-scope verification | Test users | **mock now** via ICS import/export; Calendar API later |

## Hard blockers (plain)

1. **No official way into consumer iMessage group chats.** Every option (Sendblue, LoopMessage, Linq, and so on) is an unofficial relay on Apple hardware. Apple can break it at any time, and Sendblue's group API is itself beta and plan-gated. Apple Messages for Business doesn't support groups. *Mitigation:* the channel interface is platform-neutral, so ship WhatsApp Groups (official, max 8) and Telegram as a hedge, and keep iMessage behind a relay adapter.
2. **WhatsApp groups don't support buttons and cap groups at 8.** Approvals must work as plain-text replies, and larger groups (bachelor trips of 10+) won't fit.
3. **No public purchase API for nightlife or venue tickets** (Xceed, DICE, Razzmatazz, Sagrada Família, Park Güell). Ticketmaster purchase is partner-only, and SeatGeek and Fever only offer referral links. **The in-chat "buy + QR per person" moment is only real after a business deal** with Xceed, Fever, or a venue. Until then, Trav can only hand out deep links.
4. **Airbnb has no guest booking or host messaging API.** Trav can't book or message hosts for real. Wholesale hotels and apartments are the only bookable lodging.
5. **Amadeus Self-Service is gone (2026-07-17).** Duffel is the only self-serve flight booking API with a real sandbox.
6. **Trav must not move money between friends.** Venmo's API is closed. P2P via Stripe/PayPal raises money-transmitter licensing questions. Settle-up = computed transfers + payment links + "mark paid" confirmations.
7. **Merchant-of-record liability** for anything Trav actually books (chargebacks, refunds, customer support, airline/hotel rules). That needs an entity, insurance, and probably a host agency or IATA arrangement before going live.
8. **Reading Gmail needs a restricted-scope review plus an annual CASA assessment.** Forwarding addresses avoid this.
9. **Ride-history APIs are effectively closed** (Uber receipt scope is restricted with no aggregation allowed; Lyft is closed). Ride costs come from emailed receipts or card transactions.
10. **Apple shared albums have no API, and Google Photos no longer lets apps read existing albums.** Photos must come through explicit picks (Picker API), uploads, or photos posted in chat by opted-in members.

## Recommended v0 mock shapes (so mocks match real APIs later)

The TypeScript interfaces in `packages/adapters/src/interfaces/` already encode these. Notes for whoever builds the mocks and fixtures:

- **Money everywhere:** `{ amountMinor: integer, currency: "EUR" }`. Real APIs differ, so convert at the adapter edge:
  - Duffel amounts are **decimal strings** (`total_amount: "45.00"`, `total_currency: "GBP"`).
  - Plaid `amount` is a **double**, and **positive means money left the account** (purchases positive, refunds negative). Convert it to `amountMinor` and keep a `direction: "debit" | "credit"`.
  - Hotelbeds/Expedia return decimal strings or numbers per rate. Always convert to minor units, using the currency's exponent (JPY has 0 decimals).
- **Flights (Duffel offer shape):** `offerId`, `totalAmount`, `baseAmount`, `taxAmount`, `expiresAt`, `owner` (airline IATA), `slices[]` → `{origin, destination, duration (ISO-8601 "PT2H26M"), segments[] → {departingAt, arrivingAt (local wall-clock ISO strings + IANA tz), marketingCarrier, flightNumber, operatingCarrier}}`, `conditions.refundBeforeDeparture {allowed, penalty}` and `changeBeforeDeparture`, `paymentRequirements {requiresInstantPayment, priceGuaranteeExpiresAt, paymentRequiredBy}`. Offers **expire** (mocks should expire offers after ~20–30 min of simulated time) and must be **re-priced** before ordering. Multi-origin search = one search per origin; the optimizer combines them.
- **Lodging (Hotelbeds/Expedia shape):** search returns properties with `rates[]`. Each rate has `rateId` (HBX `rateKey`), `needsRecheck` (HBX `RECHECK` vs `BOOKABLE`), `totalAmount`, `payAtProperty` (city taxes are often paid locally in Barcelona), and a `refundPolicy` with a `refundableUntil` deadline. Booking flow: search → recheck → book.
- **Tickets (Ticketmaster Partner-style reserve → purchase):** `searchEvents` → `getOffers(eventId, qty)` → `hold(offerId, qty)` returns `{holdId, expiresAt, total}` → `purchase(holdId, holders[], approval)` → order with **one `IssuedTicket` per holder**, each with its own `barcode {format: "qr", payload}`. Include `purchaseMode: "api" | "redirect_only"` so SeatGeek/Fever/DICE-style providers return a checkout link instead. Include `minimumAge` and `contentFlags` (`nightlife`, `alcohol`) so the minors rule can filter events.
- **Card transactions (Plaid `/transactions/sync` shape):** `added[] / modified[] / removed[] / nextCursor / hasMore`. Transaction fields: `transactionId`, `accountId`, `amount`, `isoCurrencyCode`, `date`, `authorizedDate`, `datetime?`, `merchantName`, `merchantEntityId?`, `rawName` (Plaid's deprecated `name`), `pending`, `pendingTransactionId?`, `paymentChannel ("online" | "in store" | "other")`, `personalFinanceCategory {primary, detailed, confidenceLevel}` (PFCv2 is the default for new Plaid customers after 2025-12-03; e.g. `FOOD_AND_DRINK` / `FOOD_AND_DRINK_RESTAURANT`, `TRANSPORTATION` / `TRANSPORTATION_TAXIS_AND_RIDE_SHARES`), `location {address, city, region, postalCode, country, lat, lon}`, `counterparties[]`, `logoUrl`. Fixtures should include **pending → posted** transitions (a pending Uber charge later posts with a different amount after tip). That's a real edge case for the "looks shared" flow.
- **Email receipts:** fixtures as raw `{from, subject, receivedAt, textBody, htmlBody}`, forwarded to a per-member address. The parser outputs `ParsedReceipt {source, merchantName, total, subtotal, tax, tip, fees, occurredAt, ride? {pickup, dropoff}, lineItems?}`. Use fictional brand-like senders only (never copy real Uber/Lyft templates). Include one email that contains injection text ("ignore previous instructions…") to test that the parser treats it as data.
- **Payments:** split into (a) `BookingPaymentsAdapter`, a Stripe PaymentIntent-like `{intentId, amount, status, idempotencyKey}` used only after an approval, and (b) `SettleUpAdapter`, which creates `PaymentRequest`s with payment **links** (Venmo/PayPal/Revolut/Bizum-style URLs, or "cash"). Status moves `pending → marked_paid (payer) → confirmed (payee)`. Trav never moves money itself.
- **Channel:** inbound events are a union of `message | reaction | button_tap | member_joined | member_left`. Every rich card **must carry `fallbackText`** with reply keywords (e.g. "Reply YES to buy"), because WhatsApp groups and SMS can't render buttons. Capabilities are exposed per channel (`buttons`, `reactions`, `privateDm`, `maxGroupSize`).
- **Album:** consent is per member per group and checked **inside** the adapter: `listPhotos` never returns photos from members without consent, and revoking consent hides their photos immediately.
- **Approval proof:** every money-moving method (`createOrder`, `book`, `purchase`, `charge`) takes an `ApprovalProof` (approval id, approver ids, max amount, expiry). The type makes it impossible to call a booking method without passing through `ApprovalPolicy`.

## Sources (read 2026-10-22)

- Sendblue groups docs: https://docs.sendblue.com/getting-started/groups/ ; pricing: https://sendblue.com/pricing
- WhatsApp Groups API: https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/
- Apple Messages for Business FAQ: https://register.apple.com/resources/messages/messaging-documentation/faq ; Business Chat FAQ: https://register.apple.com/resources/business-chat/faq/business-chat-faqs.html
- RCS (secondary): https://getkanal.com/blog/rcs-business-messaging
- Instinct group chats (secondary): https://techcrunch.com/?p=3173877 , https://aiweekly.co/alerts/instinct-opens-its-ai-agent-to-group-chats-with-non-users ; Continua: https://techcrunch.com/2025/08/12/google-vet-raises-8m-for-continua-to-bring-ai-agents-to-group-chats
- Duffel pricing: https://duffel.com/pricing ; test mode: https://duffel.com/docs/api/overview/test-mode ; offer schema: https://duffel.com/docs/api/v2/offers/schema ; Tequila comparison: https://duffel.com/why-duffel/tequila-by-kiwi-vs-duffel
- Amadeus self-service shutdown (secondary): https://www.phocuswire.com/amadeus-shut-down-self-service-apis-portal-developers
- Hotelbeds: https://developer.hotelbeds.com/documentation/ ; Expedia Rapid: https://developers.expediagroup.com/docs/products/rapid/setup/getting-started
- Airbnb API status (secondary): https://www.smoobu.com/en/blog/airbnb-api/ , https://blog.apify.com/what-you-should-know-about-the-airbnb-api-and-free-alternatives/
- Ticketmaster: https://developer.ticketmaster.com/products-and-docs/apis/getting-started/
- SeatGeek (secondary): https://www.educative.io/courses/live-event-seatgeek-api-python/get-started-with-the-seatgeek-api
- Xceed Razzmatazz page: https://xceed.me/de/barcelona/venue/razzmatazz ; DICE (secondary): https://apis.io/providers/dice-fm/
- Fever partner programs: https://business.feverup.com/en/partner-programs/affiliate-program/
- Viator: https://partnerresources.viator.com/travel-commerce/technical-guide/ ; GetYourGuide spec: https://github.com/getyourguide/partner-api-spec
- Venmo developer status: https://venmo.com/docs/sdks , https://www.fintechfutures.com/digital-banking/in-resource-shift-venmo-closes-api-to-new-developers
- Splitwise SDK docs (unofficial): https://splitwise.readthedocs.io/en/latest/api.html
- Plaid Transactions: https://plaid.com/docs/api/products/transactions/ , PFCv2: https://plaid.com/docs/transactions/pfc-migration/
- Gmail restricted scopes / CASA (secondary): https://developer.nylas.com/docs/cookbook/use-cases/build/google-oauth-scopes/
- Uber scopes: https://developer.uber.com/docs/riders/guides/scopes
- Google Photos API updates: https://developers.google.com/photos/support/updates
- Google Maps pricing changes: https://developers.google.com/maps/billing-and-pricing/march-2025
- Open-Meteo terms: https://open-meteo.com/en/terms ; Frankfurter: https://frankfurter.app/docs

No prompt-injection text was encountered in pages read during this pass.

---

## iMessage group access (2026-11-04)

Follow-up to row 8 above. Everything here was read from public pages on 2026-11-04. Vendor claims are marked "(vendor-stated)". Nothing was signed up for or called.

### Bottom line

- **No company is in consumer iMessage groups through an official Apple path.** Apple Messages for Business is still 1:1 and user-initiated. Poke's June 2026 approval is for 1:1 business chat only. Every agent that sits in a friend group does it with a **phone-number or Apple-ID identity on Apple hardware**: a managed relay (Photon, Linq, Sendblue, ...) or the company's own Macs.
- **Flip (Flip Labs, fliptexts.com) runs on Photon.** Confidence is high: both Photon's own case study and TechCrunch's Photon funding coverage say so. Users add Flip's number to a group like any contact and address it with "@Flip". It splits bills in the thread, which overlaps with Trav's ledger.
- **Instinct's method is not disclosed.** Confidence is low. It is added to a group "like a contact" on iMessage and does read receipts, emoji reactions and threaded replies. Its privacy policy names no messaging vendor, and no relay vendor lists it as a customer. My inference is a dedicated iMessage identity on Apple hardware, either its own fleet or an unnamed relay. This is **not confirmed**.
- **For Trav's pilot, the realistic picks are (1) Photon Business and (2) Linq.** Sendblue's AI Agent plan is the cheaper fallback if its beta group API is enabled for that plan. Self-hosting on our own Mac is fine for a developer prototype but is the riskiest path for real friends.

### 1. Instinct

| Item | Finding | Status |
|---|---|---|
| What it is | Invite-only personal AI agent from Spear Street Technology, Inc. (San Francisco), founded by Noah Shinn. Reached by text (iMessage, WhatsApp) and voice. Reported $1B Series C at a $10B valuation. | confirmed (TechCrunch, messagingagents.com) |
| Group chats | Early access 2026-10-05. Shinn's X post says it opened "to everyone on iMessage" (runtimewire dates this 2026-10-27). "Add Instinct to a group chat, and it works for the whole group, including for friends who don't use Instinct yet." The group gets its own Instinct that "only knows what's in the chat". Personal Instincts ask their owner before sharing anything into a group, and pending replies are held when new members join. | confirmed (founder post via search snippet and runtimewire; the X page itself returned 402) |
| How it's added | "Add Instinct to a group chat", meaning you add its iMessage contact. No public phone number is published. An Instinct member gives invites (5 each). Each agent also has its own email address, but that is used for outbound tasks, not as the iMessage handle. Phone number vs Apple-ID email: **unknown**. | partly confirmed |
| Observed iMessage features | "Instinct shows read receipts, reacts with emoji, and replies in threads" (user blog, 2026-09-12). Threaded replies and tapbacks need private-API-level control of Messages, which managed relays (Photon, Linq) and BlueBubbles with Private API provide. | confirmed (1 user report) |
| Tech / vendor | Privacy policy (revised 2026-08-26) names no messaging subprocessor, only "vendors and other service providers". Not on Linq's, Photon's or Sendblue's named-customer lists. A Mac app was leaked in beta on 2026-08-29: it reads recent iMessage conversations and sends from the **user's own Mac**, plus runs a local browser. That is a personal-agent feature, not the group bot. Shinn says it is "actively bringing up more compute". No job posts about messaging infrastructure turned up. | confirmed: absence of disclosure. **inferred:** own Apple-hardware fleet or an unnamed relay |
| Android / green bubble | Not addressed anywhere I found. GA is described as "on iMessage". | unknown |

**Confidence: low on the mechanism, high on the user-facing behaviour.**

### 2. Flip / Flip Labs

| Item | Finding | Status |
|---|---|---|
| Identity | **Flip Labs**, product "Flip" at fliptexts.com, an "AI money manager in iMessage". $1.4M pre-seed led by The House Fund; a16z speedrun. Photon also lists Pear VC and Z Fellows as backers. (The voice-AI "Flip" named in row 8 is unrelated.) | confirmed |
| How users reach it | Text **+1 (628) 264-7696**. Buttons on the site open an `sms:` link with a pre-filled opener. No app, no account needed to start. Beta, waitlist. | confirmed (fliptexts.com) |
| Groups | Photon's case study: Flip is added to a group "like any contact". You address it with "@Flip" (e.g. split an Airbnb and car rental). It reads the thread, does the math, and sends each person their share with one-tap settle. A testimonial on fliptexts.com says it "splits dinner in the gc". | vendor-stated (Photon, 2026-10-01) + site testimonial |
| Messaging vendor | **Photon**, on a "Photon-managed iMessage line". Photon's write-up says bridging from a personal Mac is wrong for a money product. Photon also mentions tappable confirmation cards, typing indicators, receipt images, voice notes and RCS/SMS fallback. TechCrunch's Photon seed coverage lists "finance AI assistant Fliptexts" as a customer. Flip's own privacy policy (updated 2026-09-09) names Dwolla, Natural, Plaid, Spinwheel, OpenAI, Anthropic, PostHog and Meta, but **not Photon**. Messaging falls under generic "third-party service providers". | confirmed by two independent sources |
| Money movement | ACH through Dwolla and Natural; bank data through Plaid. "No trade ever executes without an explicit yes." | confirmed (privacy policy, Photon) |

**Confidence: high on the vendor (Photon), medium on group behaviour details (vendor marketing).** Product note: Flip already does @-mention bill splitting in iMessage groups, so it is the closest competitor to Trav's ledger. Trav's edge has to be the trip context: bookings, approval policy, recaps and the album.

### 3. Other consumer agents in iMessage groups

| Agent | Groups? | How | Source quality |
|---|---|---|---|
| **Poke** (Interaction Co.) | Yes, since ~2025-12-06: "you can now add the Poke.com number to your iMessage group chats" | Number-based relay. **Linq lists Poke as a customer** (vendor-stated). Separately, Apple approved Poke on **Messages for Business** (2026-06-04) for 1:1. That required live-support capability, labelling the agent as an AI, Apple's button style and a couple of months of review. Poke pays its messaging service provider, not Apple. | X post (snippet), TechCrunch, 9to5Mac |
| **Lindy** | 1:1 focus | Swift daemon on a Mac mini, then BlueBubbles, then **banned by Apple within ~12 h of launch (≈10K messages)** with no appeal, then Linq (8 numbers load-balanced, daily per-number cap, text-first onboarding, contact cards). | Lindy engineering blog, 2026-03-16 (first-hand) |
| **Tomo** | Yes ("can become part of group conversations") | Linq lists Tomo as a customer (vendor-stated) | TechCrunch 2026-10-24 + messagingagents.com |
| **Boardy, Ditto, Slashy, Rho** | various | Photon customers (TechCrunch; Slashy's security page names Photon) | secondary |
| **Continua** | Yes (SMS / iMessage / Discord groups) | Not disclosed | TechCrunch 2025 |
| Maverick, Wajo | Groups mentioned | Not disclosed | TechCrunch 2026-10-24 |

The pattern: the funded consumer group agents that disclose a vendor use **Linq or Photon**. None uses Apple's official program for groups, because that program doesn't support them.

### 4. Options for a small startup, Nov 2026

| Option | Group support | Cost (as found) | Apple-ban / ToS risk | 5-friend-group pilot |
|---|---|---|---|---|
| **Photon Business** (photon.codes) | "Full group messaging iMessage API access" on Business and Enterprise. Free and Pro (shared lines) show group API as "Limited". Docs list group rename, avatar, membership add/remove/list/leave, inbound group events, tapbacks, read receipts (inbound), polls, contact-card sharing, effects. Typing and RCS/SMS fallback are claimed in marketing. Open-source local mode can run on your own Mac for development. | Free (shared, up to 10 users), Pro $25/mo (shared, up to 100 users), **Business $250/line/mo dedicated**, Enterprise custom. Cold outreach capped at 50 new contacts/day. | Same underlying risk as any relay. The vendor absorbs the hardware and line management. | 1 dedicated line, $250/mo. Friends add the number to their group. No setup fee published. |
| **Linq** (linqapp.com) | v3 API: groups of 2+ recipients, max 31 handles, "requires iMessage or RCS". MMS groups are mentioned in the guide. Add/remove participants via API. For **cross-service changes (adding an Android user to an iMessage group) you must create a new chat**. The older v2 FAQ said you can't add participants to existing groups. Tapbacks, typing, read receipts, media up to 100 MB, participant-change webhooks. | Flat per-line monthly, **not published**. 7-day trial; sandbox capped at 100 msgs/day. Sendblue's (competitor) blog claims ~$250/mo + $1,000+ setup. Guidance is 7,000 msgs/line/day ("lines that go past it do occasionally get flagged"); burst limit 30 msgs/60 s per sender-recipient pair. | Same. SOC 2 Type II (vendor-stated). Largest named customer list (Poke, Lindy, Tomo). | Trial, then a quote. Likely the most battle-tested for groups. |
| **Sendblue** | Group API is **beta, "select plans only"**. The **AI Agent (inbound) plan "can only respond to group chats that the number has been added to"**, which is exactly Trav's case. Creating outbound groups needs Blue Ocean. iMessage groups only (no SMS/MMS groups). Removing someone needs 4+ members. Inline replies on V2 lines. Media in groups is supported. | Free sandbox (shared, 10 verified contacts, no webhooks). **AI Agent $100/line/mo** (dedicated, 1,000 inbound contacts/day, typing, reactions, media). Enterprise custom. | Same | Cheapest dedicated line, but **confirm with sales that group beta is enabled on AI Agent** before relying on it. |
| LoopMessage, Blooio, Tuco, Claw Messenger, Chert, Inkbox | Mixed / "not stated". LoopMessage is reported to support groups (secondary). | LoopMessage $0 sandbox / $20 shared / $59.99 / $99.99. Blooio $289/line dedicated. Tuco $149+/mo + $335 setup per line (dedicated Mac mini + Apple ID). (All from messagingagents.com comparison, checked 2026-09/10; not verified on vendor pages.) | Same | Backups only |
| **Self-hosted** (Mac mini + Apple ID + phone number, BlueBubbles server or AppleScript + chat.db) | Full participant once the identity is in the group. **Private API (requires disabling SIP)** gives tapbacks, typing, read marking, group rename and add/remove. AppleScript alone gives text and attachments only. | Hardware (~one Mac mini) + a phone line + ops time; software free | **Highest.** Uses a consumer Apple ID for a commercial bot. Lindy's account was permanently banned within half a day at launch volume, with no appeal. Apple's spam signals (new account, low recipient diversity, high send:receive ratio) are opaque. One person must keep the Mac awake and patched. | OK for a **developer-only prototype**. Not recommended for real friends' groups (single point of failure, and a ban kills every group at once). |
| **Apple Messages for Business** | **No groups** (Apple FAQ, row 3). 1:1, user-initiated. | MSP fees | Sanctioned | Not usable for groups. Possible future 1:1 DM channel (Poke precedent: about 2 months of review, live support required, AI disclosure). |
| Apple iOS 27 / anything new | Found **nothing** shipped for third-party agents in consumer groups | n/a | n/a | n/a |

**Behaviour Trav must design for, whatever the vendor:**

1. **Being added to an existing group.** A relay or self-hosted line is just another iMessage participant, so any member can add Trav's contact to an existing iMessage group. Sendblue's AI Agent plan only works this way. Apple only allows adding people to groups that already have 3+ members.
2. **It sees every message.** iMessage has no bot "privacy mode" like Telegram. The relay webhook delivers every group message (Sendblue includes a `group_id`). Mention filtering is Trav's job, and the group must be told up front that Trav can read the thread. This is inferred from how all the vendors' webhooks are described; no vendor offers a mention-only filter.
3. **Media and tapbacks** are supported by Photon, Linq and Sendblue (dedicated plans), and by self-hosted only with the Private API.
4. **Rate and ratio.** Keep sends low relative to receives. Lindy's rough rule is no more than ~10 outbound per inbound. Trav's mention-only replies, tapback acknowledgements (T-042) and batched digests (T-038) already help. Debounce bursts (Lindy used 3 s).
5. **Private DMs.** Card, email and QR-code DMs work best once each member has texted Trav's number 1:1 first. That doubles as consent and keeps the line "inbound-first" for the vendor plans.

### 5. Blue vs green bubbles

- If **any member is on Android**, the thread isn't an iMessage group. It becomes RCS (iOS 18+, carrier-dependent) or MMS. MMS groups lose naming, member management and reactions (Apple Community, secondary). Users on iOS 26 report mixed groups falling back to SMS unpredictably.
- **Sendblue can't modify SMS/MMS groups at all.** Linq's groups "require iMessage or RCS", and adding an Android user to an iMessage group means creating a new chat. Photon claims RCS/SMS fallback but documents no group detail for it.
- **Pilot implication:** recruit **all-iPhone friend groups** for the iMessage pilot. For mixed groups, Trav should say so once and offer WhatsApp (official Groups API, max 8, row 4) or Telegram.

### What a 5-group pilot takes (estimate)

- 1 dedicated line: Photon Business $250/mo, Sendblue AI Agent $100/mo (if group beta is enabled), or Linq on quote. About 25–40 people and a few hundred messages a day, far under every vendor's per-line guidance.
- A contact card (vCard) for Trav's number. Each member texts Trav once 1:1 (consent and DM channel), then someone adds Trav to the existing all-iPhone group.
- An intro and consent message on join, mention-only replies, and "@trav leave" to remove it.
- Kill switch and fallback: if the line is flagged, Trav must fail visibly (and the group can move to WhatsApp/Telegram), not silently.

### Hard blockers (plain)

1. **No sanctioned way into consumer iMessage groups exists.** Every option is a relay on Apple hardware that Apple can shut off with no appeal (Lindy). This is the same blocker as above, now confirmed across vendors and competitors.
2. **Android members break the iMessage path.** Mixed groups become RCS or MMS, which most relays don't support for groups.
3. **Group API is plan-gated at every vendor:** Photon Business, Sendblue beta "select plans", Linq on quote. Pricing for the cheapest group-capable dedicated line ranges from $100 to $250+/mo.

### Sources (read 2026-11-04)

- Instinct: https://techcrunch.com/2026/10/05/instinct-brings-its-ai-agent-to-group-chats-even-for-friends-without-an-account/ ; https://x.com/noahrshinn/status/2115143830924341534 (text via search snippet; page returned 402) ; https://runtimewire.com/article/instinct-group-ai-agent-imessage ; https://runtimewire.com/article/instinct-mac-app-imessage-local-browser-whoop ; https://instinct.com/privacy-policy ; https://messagingagents.com/agents/instinct ; https://mager.co/blog/2026-09-12-instinct/ ; https://www.eesel.ai/blog/instinct-ai-review
- Flip: https://fliptexts.com/ ; https://fliptexts.com/privacy ; https://photon.codes/blog/flip-brings-ai-powered-finance-into-imessage-with-photon ; https://cryptorank.io/insights/deals/flip-labs-pre-seed-led-by-the-house-fund ; Photon seed coverage (customer list): https://techcrunch.com/?p=3169890 , https://runtimewire.com/article/photon-raises-4-5m-messaging-agents
- Poke / Apple MfB: https://x.com/yuris/status/1997372676080603624 ; https://techcrunch.com/2026/06/04/apple-approves-poke-as-the-first-ai-agent-on-its-messages-for-business-platform/ ; https://9to5mac.com/2026/06/04/apples-messages-app-on-iphone-now-has-a-third-party-ai-agent/
- Agent roundup: https://techcrunch.com/2026/10/24/all-the-ai-agents-that-can-live-in-your-text-messages/
- Lindy: https://www.lindy.ai/blog/imessage-api-three-rewrites-one-apple-ban-and-what-actually-works
- Provider comparison (secondary): https://messagingagents.com/tools/imessage-api
- Photon: https://photon.codes/pricing ; https://photon.codes/docs/spectrum-ts/providers/imessage/messaging-features.md
- Linq: https://linqapp.com/blog/imessage-for-agents ; https://v3-api-docs.pages.dev/getting-started/key-concepts/index.md ; https://docs.linqapp.com/v2/faqs/general/
- Sendblue: https://docs.sendblue.com/getting-started/groups/ ; https://www.sendblue.com/pricing ; https://www.sendblue.com/blog/imessage-api-pricing-comparison (vendor blog)
- BlueBubbles Private API: https://docs.bluebubbles.app/private-api/
- Mixed groups (secondary): https://bgr.com/2227111/can-android-phone-users-participate-imessage-group-chat/ ; https://discussions.apple.com/thread/256150676

Injection-like text seen in this pass is logged in `research/INJECTION_LOG.md` (Photon docs "Agent Instructions" block, Inkbox self-signup prompt, Linq "For AI assistants" page). None of it was acted on.
