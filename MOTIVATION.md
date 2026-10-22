# Trav — Motivation

> **Trav is an AI group-chat agent that stays with a group before, during, and after a trip, keeping the group's expenses, experiences, and memories in one place.**

## The problem (a real story)

Six college friends, ages 20–22, took a trip to Barcelona. Each person flew in from a different city and flew home to a different city. Planning it went like this:

- **Flights:** hours of cross-checking to find flights from six origins that landed and left at similar times.
- **Lodging:** finding a 6-person Airbnb, then messaging the host back and forth about check-in logistics.
- **Tickets:** buying a Barça match on SeatGeek, Sagrada Família and Park Güell on their own sites, and club tickets (e.g. Razzmatazz) every night, usually decided after dinner, on each club's own website.
- **Money:** shared costs (Ubers, Lyfts, taxis, dinners, tickets) got dumped into a shared note, and everyone forgot about them after the trip. Nobody was ever squared up.
- **Memories:** spread across six camera rolls that nobody ever merged.

Everything was scattered across a million emails, texts, apps, and notes. The group chat was the real "operating system" of the trip, but it couldn't *do* anything.

## The insight

Existing travel products (Expedia, Mindtrip, Layla, Booking's AI planner) are mostly **solo** and mostly **before the trip**. General agents like Instinct can now join group chats, but they are horizontal: they do a little of everything for any group task.

Trav's bet is **depth in one vertical: group travel**, living where the group already is, which is the group chat:

1. **Before:** learns each member and the group as a whole. Finds flights that work for people leaving from different cities, lodging, and tickets matched to the group's tastes (e.g. "they're soccer fans, get Barça tickets").
2. **During:** "@trav get the 5 of us Razzmatazz tickets, Henry's sick." Trav knows it's 5 tonight, not 6. It buys, posts the receipt, sends each person their own QR code, and charges only those 5.
3. **After (and every morning):** a shared ledger that fills itself in from Trav's own bookings, email receipts (Uber/Lyft), card transactions, and receipt photos. A "Morning After" recap every morning after a night out, a daily settle-up, and a **Trip Wrapped** at the end.

## Why the group-chat form factor

- No app to download. Friends who never signed up can still use it.
- It spreads on its own: every trip brings 3–8 new people.
- Personality is part of the product. Trav can roast the group about a bad spending day. Screenshots are free marketing.

## Who it's for first

College students and young adults planning group trips (spring break, study-abroad weekends, bachelor/ette trips, friend reunions). Later: families (e.g. a trip with parents and a 14-year-old sibling) and small work offsites.

## What makes it defensible (what we must be great at)

1. **Multi-origin group flight optimization:** a real search and optimization problem general agents handle poorly.
2. **The group trip ledger:** automatic capture of expenses, smart detection of what's shared, low-friction confirmation, daily settle-up.
3. **Group memory:** each group's history, tastes, budgets, and inside jokes, carried across trips.
4. **Trustworthy spending:** spending caps, one-tap confirmations, refundable-first defaults, and an audit log. Competitors have shipped agents that took actions without asking, and we must never do that.

## Business notes (keep in mind while building)

- Revenue options: commissions on bookings (thin on flights, better on lodging and tours), a per-trip pass, or a subscription. Make it possible to add any of them later; don't build billing now.
- Biggest risks: (a) platform access (no official iMessage bot API for consumer group chats), (b) booking for real (APIs, terms of service, merchant-of-record liability), (c) horizontal agents (Instinct, ChatGPT, Meta) adding travel depth.
- We may pitch a16z (e.g. speedrun). The demo has to make the in-chat moment feel magical.

## Three reference trips (use these as test scenarios everywhere)

1. **Lisbon: Dean + Dad.** Dean likes cities. Dad likes remote, scenic places and history. No clubbing, but chill bars are in. Both are huge soccer fans and want to see Sporting, Benfica, or Porto play. Lodging: safe and central, no luxury needed. Dean wants things you can't find anywhere else. Dad has a business conference with blocked times, so suggest Dean-only activities during those blocks. Daily budget matters.
2. **Turks and Caicos: Dean, Mom, Dad, and his 14-year-old sister.** A family trip with a minor: the content must be age-appropriate, with no nightlife suggestions that include her, and the group dynamics are different.
3. **Barcelona: 6 college friends (ages 20–22).** Different origin and return cities, a 6-person Airbnb, Barça tickets, Sagrada Família and Park Güell, clubs at night, lots of shared Ubers and dinners. **This is the flagship demo.**
