'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const plugin = require('../plugin.cjs');
const view = require('../gui/src/view.js');
const publisher = require('../src/publisher.cjs');

const root = path.resolve(__dirname, '..');
const baseSeed = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/minimal.json'), 'utf8'));
const baseBinding = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/binding.json'), 'utf8'));
const baseAssets = JSON.parse(fs.readFileSync(path.join(root, 'contribution/assets.catalog.json'), 'utf8'));

function fresh(virtual_now = '2026-11-18T12:00:00+00:00') {
  return {
    ctx: { binding: structuredClone(baseBinding), resources: structuredClone(baseAssets), virtual_now },
    data: structuredClone(baseSeed),
  };
}

test('seed validates, all history >= 2026-01-01, search/emergency-note update succeed, and pass expiry is derived on read', () => {
  const { ctx, data } = fresh();
  plugin.validateSeed(ctx, data);
  const before = JSON.stringify(data);

  const minMs = Date.parse('2026-01-01T00:00:00+00:00');
  for (const rec of plugin.records(data)) {
    for (const k of ['created_at', 'updated_at', 'issued_at']) {
      if (rec[k]) assert.ok(Date.parse(rec[k]) >= minMs, `${rec.id}.${k} before 2026-01-01`);
    }
  }

  // Program search success + missing optional asset warning
  const search = plugin.handleTool(ctx, data, 'trailhead-rec.program.search', { category: 'aquatics', open_only: true }).result;
  assert.ok(search.items.some((p) => p.id === 'prg-lap-swim-am'));

  const missingCard = plugin.handleTool(ctx, data, 'trailhead-rec.program.get', { id: 'prg-pickleball-beg' }).result;
  assert.ok(missingCard.asset_warning && missingCard.asset_warning.startsWith('ASSET_MISSING:'));

  // Household read derives expired status for pass-elena-lap without mutating state
  const hh = plugin.handleTool(ctx, data, 'trailhead-rec.household.get', {}).result;
  const passMap = Object.fromEntries(hh.effective_pass_statuses.map((p) => [p.id, p.effective_status]));
  assert.equal(passMap['pass-elena-lap'], 'expired');
  assert.equal(passMap['pass-marcus-gym'], 'active');
  assert.equal(JSON.stringify(data), before);

  // Emergency contact update succeeds (and never touches waivers)
  plugin.handleTool(ctx, data, 'trailhead-rec.household.update_member', {
    person_ref: 'person-leo',
    patch: { emergency_contact: 'Marcus Vargas (555-0199)' },
  });
  const leo = data.members.find((m) => m.person_ref === 'person-leo');
  assert.equal(leo.emergency_contact, 'Marcus Vargas (555-0199)');
});

test('24h waitlist offer accepts before deadline, expires after deadline, and blocks when waiver is withdrawn via Infra event', () => {
  // 1. Accept before offer_expires_at succeeds and deducts resident fee
  const okRun = fresh('2026-11-19T14:59:59+00:00');
  const startCredit = okRun.data.household_credit_cents;
  const accepted = plugin.handleTool(okRun.ctx, okRun.data, 'trailhead-rec.enrollment.accept_offer', { id: 'enr-205' }).result;
  assert.equal(accepted.fee_charged_cents, 6500);
  assert.equal(okRun.data.household_credit_cents, startCredit - 6500);

  // 2. Past offer_expires_at -> read derives offer_expired, accept_offer fails with offer_expired
  const lateRun = fresh('2026-11-19T15:00:01+00:00');
  const readLate = plugin.handleTool(lateRun.ctx, lateRun.data, 'trailhead-rec.enrollment.get', { id: 'enr-205' }).result;
  assert.equal(readLate.effective_status, 'offer_expired');
  assert.throws(
    () => plugin.handleTool(lateRun.ctx, lateRun.data, 'trailhead-rec.enrollment.accept_offer', { id: 'enr-205' }),
    (e) => e.code === 'offer_expired'
  );

  // 3. Infra member.waiver_status_changed withdraws aquatics_allergy -> accept_offer blocked with waiver_consent_required
  const waiverRun = fresh('2026-11-19T10:00:00+00:00');
  plugin.applyEvent(waiverRun.ctx, waiverRun.data, {
    event_id: 'evt-w-1',
    at: '2026-11-19T10:00:00+00:00',
    operation: 'member.waiver_status_changed',
    payload: { person_ref: 'person-leo', waiver_type: 'aquatics_allergy', status: 'withdrawn' },
  });
  assert.throws(
    () => plugin.handleTool(waiverRun.ctx, waiverRun.data, 'trailhead-rec.enrollment.accept_offer', { id: 'enr-205' }),
    (e) => e.code === 'waiver_consent_required'
  );
});

test('situation (b) lap-swim enrollment uses household credit, prerequisite checks enforce eligibility, and schedule_changed waives withdrawal penalty', () => {
  const { ctx, data } = fresh();
  // Elena enrolls in Adult Morning Lap Swim Series paid with household credit
  const beforeCredit = data.household_credit_cents;
  const lap = plugin.handleTool(ctx, data, 'trailhead-rec.enrollment.enroll', {
    id: 'enr-elena-lap',
    program_id: 'prg-lap-swim-am',
    person_ref: 'person-elena',
  }).result;
  assert.equal(lap.enrollment_status, 'enrolled');
  assert.equal(lap.fee_charged_cents, 4500);
  assert.equal(data.household_credit_cents, beforeCredit - 4500);

  // Leo lacks swim_level_3 prerequisite for Level 4 -> eligibility_failed
  assert.throws(
    () =>
      plugin.handleTool(ctx, data, 'trailhead-rec.enrollment.enroll', {
        program_id: 'prg-swim-l4-sat',
        person_ref: 'person-leo',
      }),
    (e) => e.code === 'eligibility_failed'
  );

  // Schedule change opens penalty-free withdrawal window even after full_refund_cutoff_at
  const lateCtx = { binding: baseBinding, virtual_now: '2026-11-30T10:00:00+00:00' };
  plugin.applyEvent(lateCtx, data, {
    event_id: 'evt-sched-1',
    at: '2026-11-30T10:00:00+00:00',
    operation: 'program.schedule_changed',
    payload: {
      program_id: 'prg-lap-swim-am',
      new_time_slot: 'Tue/Thu 06:30-07:30',
      penalty_free_until: '2026-12-02T23:59:59+00:00',
    },
  });
  const wd = plugin.handleTool(lateCtx, data, 'trailhead-rec.enrollment.withdraw', { id: 'enr-elena-lap' }).result;
  assert.equal(wd.refunded_cents, 4500);
});

test('weather closure credits outdoor court booking, court book/cancel enforce cutoffs, and publisher/view work cleanly', () => {
  const { ctx, data } = fresh();
  const booked = plugin.handleTool(ctx, data, 'trailhead-rec.court.book', {
    id: 'bkg-indoor-new',
    slot_id: 'crt-fh-01',
    person_ref: 'person-elena',
  }).result;
  assert.equal(booked.fee_charged_cents, 2800);

  const cancelled = plugin.handleTool(ctx, data, 'trailhead-rec.court.cancel', { id: 'bkg-indoor-new' }).result;
  assert.equal(cancelled.refunded_cents, 2800);

  const wire = publisher.enrollmentNotification(data.enrollments[1], {
    sourceAccount: 'acct-elena',
    recipient: { kind: 'person_ref', id: 'person-elena' },
  });
  assert.equal(wire.specversion, '1.0');
  assert.ok(wire.id.length <= 100);
  assert.deepEqual(wire.data.content.asset_ids, []);
  assert.deepEqual(wire.data.extensions, []);

  const html = view.render([{ id: 'xss', title: '<script>bad()</script>' }]);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});
