# CloverVet (`apps/clovervet`)

CloverVet is a standalone, resettable synthetic PALE Environment package for veterinary care, multi-pet vaccination compliance, boarding/interstate travel health clearances, clinic appointments, and veterinary prescription refills.

## Local setup & verification

Requires Node.js >= 18 and no external runtime services or paid APIs.

```bash
# 1. Standalone unit tests and local event example
cd apps/clovervet
npm test
npm run example

# 2. Official PALE runtime verification (from repo root)
cd ../..
npm run app:verify -- --app apps/clovervet

# 3. Real Messaging + Mail integration test
node apps/clovervet/examples/mail-integration.cjs

# 4. Launch Web GUI via PALE web host
npm run web
```

## Design-review follow-through notes (PR #184)

- **Visit outcomes & exam recency:** Added the `vet.visit_outcome_logged` Infra event (`checked_in`, `completed`, `no_show`), which updates `pet.last_exam_at` and `pet.exam_valid_until` on completed wellness/travel exams so exams completed during a run count toward clearance checks. `prescription.decision` supports `vet_review` before final approval/denial.
- **Certificate validity & derived expiry:** Every clearance certificate stores `valid_until`; `clovervet.clearance.list` derives `effective_status: "expired"` from `ctx.virtual_now` without mutating state, and subsequent writes/events commit expired records cleanly.
- **Seeded compliance rules:** Boarding and interstate vaccine/waiting-period/exam rules live in `fixtures/minimal.json` under `clearance_rules[]` (per species and clearance type), while `requirement_ref` validates structured `{kind, id, version?}` references without importing Files.
- **Mail integration:** Uses an unchanged copy of Mail's `router-message.schema.json` and unique CloudEvents IDs (`<= 100` chars) verified end-to-end via `mail.get` (`thread_id === wire.id`) in `examples/mail-integration.cjs`.
- **Fixture dates:** All seeded historical records are dated `2026-01-01` onward.
