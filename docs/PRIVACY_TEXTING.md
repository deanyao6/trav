# Privacy note: texting members (T-188)

Short and practical. This is not legal advice. Before a real line texts real people, Dean should confirm it with counsel (docs/QUESTIONS.md).

## What Trav texts, and why

Trav sends **conversational** messages, not marketing. It only writes in a group chat it was added to and provisioned for (`TRAV_SERVER_GROUPS`). It only DMs a provisioned member about that member's own trip items: their ticket, a private card charge that looks shared, a settle-up line. It never texts a number that isn't in a provisioned group. Anyone else who writes in a provisioned chat is a **guest**. A guest can chat but can't book, approve or pay, and never gets a DM.

## US texting rules we follow

- **Opt-out keywords (CTIA guidelines; the FCC's 2025 TCPA revocation rule, "any reasonable means").** In a DM, any of `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`, `OPT OUT`, `REVOKE` as the whole message opts that number out. In the group, only the unambiguous ones count (`STOP`, `STOPALL`, `UNSUBSCRIBE`, `OPT OUT`), because "cancel" there declines a booking card and "stop roasting" is a setting.
- **One confirmation, then silence.** An opt-out gets exactly one reply saying so and how to undo it (`START`). After that Trav sends that number no DMs (tickets and private cards included) and ignores what it sends, until it replies `START`. The member stays on the group's tab, so the balances still add up.
- **Opt-outs are remembered.** The list holds a SHA-256 of the number, not the number. It survives restarts and "delete my data": honoring an opt-out means remembering it.
- **Timing.** Morning After and Wrapped are scheduled for 10:00 in the trip's time zone (`RECAP_HOUR`, `WRAPPED_HOUR`). Other jobs, like a booking card expiring or the catch-up pass after downtime, aren't held to quiet hours yet (docs/QUESTIONS.md). These are messages in a chat the group added Trav to, not telemarketing.
- **Carrier SMS.** If a relay vendor falls back from iMessage to SMS, US carriers require A2P 10DLC registration for the sending number. That is the vendor's and Dean's step before going live, not code.

## Your data

- **"@trav delete my data"** (or "forget me"; in a DM no @trav is needed) deletes your private partition in every group you're in: card and email imports, private cards and DMs, payment handles, consents, and Trav's per-member runtime state. It is audited as `data.deleted`, visible to you only. Your share of the group tab (expenses you're split on) stays, so everyone else's balances are still right.
- **Group vs private.** Group context and each member's private data are stored apart (SAFETY §2). Card and email data stays visible only to you until you confirm an item as shared.
- **Logs** hold ids, counts and kinds only. They never hold message text, phone numbers, emails, secrets or env values (`apps/server/src/log.ts` drops unknown fields and redacts anything that isn't id-like).
