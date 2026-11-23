# Trailhead Parks & Rec (`apps/trailhead-rec`)

Trailhead Parks & Rec is a standalone, resettable synthetic PALE Environment package for municipal parks and recreation program registration, 24-hour waitlist offers, household roster/pass management, and athletic court reservations.

## Local setup & verification

Requires Node.js >= 18 and no external runtime services or paid APIs.

```bash
# 1. Standalone unit tests and local event example
cd apps/trailhead-rec
npm test
npm run example

# 2. Official PALE runtime verification (from repo root)
cd ../..
npm run app:verify -- --app apps/trailhead-rec

# 3. Real Messaging + Mail integration test
node apps/trailhead-rec/examples/mail-integration.cjs

# 4. Launch Web GUI via PALE web host
npm run web
```

## Design-review follow-through notes (PR #145)

- **Infra-only waivers:** Waiver statuses change exclusively via `member.waiver_status_changed`. No Agent tool can sign, restore, or modify a waiver; `trailhead-rec.household.update_member` edits only emergency contact, medical notes, and preferred facility.
- **Lap-swim household-credit flow (Situation b):** `trailhead-rec.enrollment.enroll` enrolls eligible adult members into open lap-swim sessions paid directly from `household_credit_cents` (no separate pass-purchase tool required).
- **Prefixed tool names & Core concurrency:** All 15 Agent tools use the `trailhead-rec.*` prefix and Core's native `{status: "committed", version: {epoch, revision}}` / `stale_version` contract.
- **Derived virtual-time expirations:** `offer_expired` and expired passes are derived on read from `ctx.virtual_now` without mutating state, and committed on the next write or event.
- **Mail integration:** Uses an unchanged copy of Mail's `router-message.schema.json` and tests real delivery, `thread_id` correlation, duplicate retry, ungranted refusal, and `env.reset` isolation through `runtime/messaging/service.cjs` in `examples/mail-integration.cjs`.
- **Fixture dates:** All seeded historical records are dated `2026-01-01` onward (asserted in `tests/business.test.cjs`).
