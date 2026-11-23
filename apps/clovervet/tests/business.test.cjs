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

test('seed validates, all history >= 2026-01-01, and reads are side-effect free with missing-asset warning', () => {
  const { ctx, data } = fresh();
  plugin.validateSeed(ctx, data);
  const before = JSON.stringify(data);

  // Verify every seeded timestamp is >= 2026-01-01
  const minMs = Date.parse('2026-01-01T00:00:00+00:00');
  for (const rec of plugin.records(data)) {
    for (const k of ['created_at', 'updated_at', 'administered_at', 'collected_at', 'last_exam_at', 'issued_at']) {
      if (rec[k]) assert.ok(Date.parse(rec[k]) >= minMs, `${rec.id}.${k} before 2026-01-01`);
    }
  }

  const cleo = plugin.handleTool(ctx, data, 'clovervet.pet.get', { id: 'pet-cleopatra' }).result;
  assert.ok(cleo.asset_warning && cleo.asset_warning.startsWith('ASSET_MISSING:'));

  // Derived expired clearance on read without mutating stored state
  const clrList = plugin.handleTool(ctx, data, 'clovervet.clearance.list', { pet_id: 'pet-mochi' }).result;
  assert.equal(clrList.effective_statuses[0].effective_status, 'expired');
  assert.equal(JSON.stringify(data), before);
});

test('boarding and interstate clearance rules enforce mid-stay expiry, waiting periods, 10-day window and requirement_ref', () => {
  const { ctx, data } = fresh('2026-11-18T12:00:00+00:00');
  // Mid-stay Bordetella expiry fails
  const midStay = plugin.handleTool(ctx, data, 'clovervet.clearance.check', {
    pet_id: 'pet-mochi',
    clearance_type: 'boarding_stay',
    stay_start_at: '2026-11-26T12:00:00+00:00',
    stay_end_at: '2026-12-01T12:00:00+00:00',
  }).result;
  assert.equal(midStay.eligible, false);
  assert.ok(midStay.reasons.includes('VACCINE_EXPIRES_BEFORE_END'));

  // Malformed requirement_ref rejected
  const badRef = plugin.handleTool(ctx, data, 'clovervet.clearance.check', {
    pet_id: 'pet-biscuit',
    clearance_type: 'boarding_stay',
    stay_start_at: '2026-11-26T12:00:00+00:00',
    stay_end_at: '2026-12-01T12:00:00+00:00',
    requirement_ref: { kind: 'file_ref', id: 'bad id' },
  }).result;
  assert.equal(badRef.eligible, false);
  assert.ok(badRef.reasons.includes('REFERENCE_INVALID'));

  // Log Bordetella booster on Nov 18 14:45 -> 7-day wait fails for Nov 22 check-in, passes for Nov 26 check-in
  plugin.applyEvent(ctx, data, {
    event_id: 'evt-vax-1',
    at: '2026-11-18T15:00:00+00:00',
    operation: 'vet.vaccination_logged',
    payload: {
      pet_id: 'pet-mochi',
      vaccine_type: 'bordetella',
      administered_at: '2026-11-18T14:45:00+00:00',
      expires_at: '2027-11-18T23:59:59+00:00',
      waiting_period_days: 7,
      clinic_branch_id: 'br-oakwood',
    },
  });
  const tooSoon = plugin.handleTool(ctx, data, 'clovervet.clearance.check', {
    pet_id: 'pet-mochi',
    clearance_type: 'boarding_stay',
    stay_start_at: '2026-11-22T12:00:00+00:00',
    stay_end_at: '2026-11-24T12:00:00+00:00',
  }).result;
  assert.equal(tooSoon.eligible, false);
  assert.ok(tooSoon.reasons.includes('WAITING_PERIOD_UNMET'));

  const okBoard = plugin.handleTool(ctx, data, 'clovervet.clearance.issue', {
    id: 'cert-mochi-nov',
    pet_id: 'pet-mochi',
    clearance_type: 'boarding_stay',
    stay_start_at: '2026-11-26T12:00:00+00:00',
    stay_end_at: '2026-12-01T12:00:00+00:00',
  }).result;
  assert.equal(okBoard.certificate_id, 'cert-mochi-nov');

  // Interstate travel > 10 days out rejected, and visit outcome updates exam date for 30-day interstate rule
  const tooFar = plugin.handleTool(ctx, data, 'clovervet.clearance.check', {
    pet_id: 'pet-biscuit',
    clearance_type: 'interstate_travel',
    stay_start_at: '2026-12-05T12:00:00+00:00',
  }).result;
  assert.equal(tooFar.eligible, false);
  assert.ok(tooFar.reasons.includes('CERTIFICATE_WINDOW_EXCEEDED'));
});

test('appointments enforce fear-free, cat-only, dental bloodwork, caretaker scope, disruption fee waiver, and visit outcome', () => {
  const { ctx, data } = fresh();
  // Mochi requires fear_free_room -> standard slot-oak-02 rejected
  assert.throws(
    () =>
      plugin.handleTool(ctx, data, 'clovervet.appointment.book', {
        pet_id: 'pet-mochi',
        slot_id: 'slot-oak-02',
        visit_type: 'vaccine_booster',
      }),
    (e) => e.code === 'handling_constraint_mismatch'
  );

  // Mochi dental_cleaning without 30-day bloodwork rejected
  assert.throws(
    () =>
      plugin.handleTool(ctx, data, 'clovervet.appointment.book', {
        pet_id: 'pet-mochi',
        slot_id: 'slot-oak-03',
        visit_type: 'dental_cleaning',
      }),
    (e) => e.code === 'lab_prerequisite_missing'
  );

  // Pickup-only caretaker Claire cannot attend routine visit for Mochi
  assert.throws(
    () =>
      plugin.handleTool(ctx, data, 'clovervet.appointment.book', {
        pet_id: 'pet-mochi',
        slot_id: 'slot-oak-01',
        visit_type: 'vaccine_booster',
        caretaker_person_ref: 'person-claire',
      }),
    (e) => e.code === 'validation_error'
  );

  // Visit outcome event records completed exam and updates Mochi's last_exam_at
  plugin.applyEvent(ctx, data, {
    event_id: 'evt-outcome-1',
    at: '2026-11-20T14:45:00+00:00',
    operation: 'vet.visit_outcome_logged',
    payload: {
      appointment_id: 'appt-201',
      outcome: 'completed',
      recorded_weight_kg: 11.8,
      note: 'Wellness exam normal.',
    },
  });
  const mochiAfter = plugin.handleTool(ctx, data, 'clovervet.pet.get', { id: 'pet-mochi' }).result.item;
  assert.equal(mochiAfter.last_exam_at, '2026-11-20T14:45:00+00:00');
  assert.equal(mochiAfter.weight_kg, 11.8);

  // Clinic disruption waives 24-hour late-cancel fee on appt-202
  const lateCtx = { binding: baseBinding, virtual_now: '2026-11-22T06:00:00+00:00' };
  plugin.applyEvent(lateCtx, data, {
    event_id: 'evt-disrupt-1',
    at: '2026-11-22T06:00:00+00:00',
    operation: 'clinic.schedule_disruption',
    payload: {
      branch_id: 'br-harbor',
      vet_id: 'vet-morales',
      affected_from: '2026-11-22T12:00:00+00:00',
      affected_until: '2026-11-22T18:00:00+00:00',
      penalty_free_until: '2026-11-24T23:59:59+00:00',
      reason: 'Emergency surgery',
    },
  });
  const cancelled = plugin.handleTool(lateCtx, data, 'clovervet.appointment.cancel', { id: 'appt-202' }).result;
  assert.equal(cancelled.cancellation_fee_cents, 0);
});

test('prescriptions enforce allergen conflict, weight band, heartworm prerequisite, refill amendment and vet decision', () => {
  const { ctx, data } = fresh();
  // Beef allergen conflict
  assert.throws(
    () =>
      plugin.handleTool(ctx, data, 'clovervet.prescription.request_refill', {
        prescription_id: 'rx-mochi-hw-beef',
        fulfillment_mode: 'clinic_pickup',
      }),
    (e) => e.code === 'allergen_conflict'
  );
  // Overdue heartworm test blocks allergen-safe topical
  assert.throws(
    () =>
      plugin.handleTool(ctx, data, 'clovervet.prescription.request_refill', {
        prescription_id: 'rx-mochi-hw-topical',
        fulfillment_mode: 'clinic_pickup',
      }),
    (e) => e.code === 'heartworm_test_overdue'
  );
  // Weight band mismatch on Biscuit's old rx
  assert.throws(
    () =>
      plugin.handleTool(ctx, data, 'clovervet.prescription.request_refill', {
        prescription_id: 'rx-biscuit-oldband',
        fulfillment_mode: 'clinic_pickup',
      }),
    (e) => e.code === 'weight_band_mismatch'
  );
  // 0 refills remaining on Cleopatra's renal diet
  assert.throws(
    () =>
      plugin.handleTool(ctx, data, 'clovervet.prescription.request_refill', {
        prescription_id: 'rx-cleo-renal',
        fulfillment_mode: 'clinic_pickup',
      }),
    (e) => e.code === 'no_refills_remaining'
  );

  // Post negative heartworm lab -> topical refill succeeds, can be amended in vet_review, then approved
  plugin.applyEvent(ctx, data, {
    event_id: 'evt-lab-hw',
    at: '2026-11-18T16:00:00+00:00',
    operation: 'vet.lab_result_posted',
    payload: {
      pet_id: 'pet-mochi',
      panel_type: 'heartworm_antigen',
      status: 'negative',
      valid_until: '2027-11-18T23:59:59+00:00',
      note: 'Negative antigen test.',
    },
  });
  const req = plugin.handleTool(ctx, data, 'clovervet.prescription.request_refill', {
    id: 'rfl-mochi-hw',
    prescription_id: 'rx-mochi-hw-topical',
    fulfillment_mode: 'clinic_pickup',
  }).result;
  assert.equal(req.refill_receipt_id, 'rcpt-rfl-mochi-hw');

  plugin.applyEvent(ctx, data, {
    event_id: 'evt-rx-rev',
    at: '2026-11-18T16:30:00+00:00',
    operation: 'prescription.decision',
    payload: { refill_id: 'rfl-mochi-hw', decision: 'vet_review', note: 'Checking weight band.' },
  });
  plugin.handleTool(ctx, data, 'clovervet.prescription.amend_refill', {
    id: 'rfl-mochi-hw',
    patch: { fulfillment_mode: 'home_delivery', shipping_address: '18 Cedar Ln, Exampleton, MA 02100' },
  });
  plugin.applyEvent(ctx, data, {
    event_id: 'evt-rx-app',
    at: '2026-11-18T17:00:00+00:00',
    operation: 'prescription.decision',
    payload: { refill_id: 'rfl-mochi-hw', decision: 'approved_delivery', note: 'Dispatched.' },
  });
  const rxAfter = plugin.handleTool(ctx, data, 'clovervet.prescription.get', { id: 'rx-mochi-hw-topical' }).result.prescription;
  assert.equal(rxAfter.refills_remaining, 3);
});

test('publisher builds valid CloudEvents envelope and reviewer renderer escapes HTML', () => {
  const { data } = fresh();
  const wire = publisher.appointmentNotification(data.appointments[0], {
    sourceAccount: 'acct-hannah',
    recipient: { kind: 'person_ref', id: 'person-hannah' },
  });
  assert.equal(wire.specversion, '1.0');
  assert.ok(wire.id.length <= 100);
  assert.deepEqual(wire.data.content.asset_ids, []);
  assert.deepEqual(wire.data.extensions, []);

  const html = view.render([{ id: 'xss-1', name: '<img src=x onerror=alert(1)>' }]);
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;img'));
});
