'use strict';

const c = require('./common.cjs');

function findById(list, id, label) {
  const found = list.find((x) => x.id === id);
  if (!found) c.fail('not_found', `${label} not found: ${id}`);
  return found;
}

function findMember(data, personRef) {
  const m = data.members.find((x) => x.person_ref === personRef);
  if (!m) c.fail('not_found', `Household member not found: ${personRef}`);
  return m;
}

function assetWarning(ctx, assetId) {
  if (!assetId) return null;
  const catalog = ctx && ctx.resources && Array.isArray(ctx.resources.assets) ? ctx.resources.assets : null;
  if (!catalog) return null;
  const desc = catalog.find((a) => a.asset_id === assetId);
  if (!desc || (desc.availability && desc.availability.status !== 'ready')) {
    return `ASSET_MISSING: optional facility/program card ${assetId} is not materialized`;
  }
  return null;
}

function handleTool(ctx, data, name, args) {
  const now = c.nowOf(ctx);

  // --- Programs ---
  if (name === 'trailhead-rec.program.search') {
    const q = (args.query || '').trim().toLowerCase();
    const items = data.programs.filter((p) => {
      if (args.category && p.category !== args.category) return false;
      if (args.facility_id && p.facility_id !== args.facility_id) return false;
      if (args.open_only && p.enrolled_count >= p.capacity) return false;
      if (q) {
        const hay = `${p.id} ${p.title} ${p.category} ${p.schedule_text} ${p.season}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    return { data, result: { items: c.copy(items) } };
  }

  if (name === 'trailhead-rec.program.get') {
    const item = findById(data.programs, args.id, 'Program');
    return {
      data,
      result: {
        item: c.copy(item),
        seats_open: Math.max(0, item.capacity - item.enrolled_count),
        asset_warning: assetWarning(ctx, item.card_asset_id),
      },
    };
  }

  // --- Household (waivers are strictly read-only for Agents) ---
  if (name === 'trailhead-rec.household.get') {
    const effective_pass_statuses = data.passes.map((p) => ({
      id: p.id,
      effective_status: c.effectivePassStatus(p, now),
    }));
    return {
      data,
      result: {
        household_credit_cents: data.household_credit_cents,
        members: c.copy(data.members),
        passes: c.copy(data.passes),
        effective_pass_statuses,
      },
    };
  }

  if (name === 'trailhead-rec.household.update_member') {
    c.syncVirtualExpirations(data, now);
    const member = findMember(data, args.person_ref);
    const patch = args.patch || {};
    if (!Object.keys(patch).length) c.fail('validation_error', 'Patch cannot be empty.');
    if (patch.preferred_facility_id) findById(data.facilities, patch.preferred_facility_id, 'Facility');
    for (const k of ['emergency_contact', 'medical_notes', 'preferred_facility_id']) {
      if (patch[k] !== undefined) member[k] = patch[k];
    }
    return { data, result: { id: member.person_ref } };
  }

  // --- Enrollments & 24h Waitlist Offers ---
  if (name === 'trailhead-rec.enrollment.list') {
    const items = data.enrollments.filter((e) => {
      if (args.person_ref && e.person_ref !== args.person_ref) return false;
      if (args.program_id && e.program_id !== args.program_id) return false;
      return true;
    });
    const effective_statuses = items.map((e) => ({
      id: e.id,
      effective_status: c.effectiveEnrollmentStatus(e, now),
    }));
    return { data, result: { items: c.copy(items), effective_statuses } };
  }

  if (name === 'trailhead-rec.enrollment.get') {
    const item = findById(data.enrollments, args.id, 'Enrollment');
    return {
      data,
      result: { item: c.copy(item), effective_status: c.effectiveEnrollmentStatus(item, now) },
    };
  }

  if (name === 'trailhead-rec.enrollment.preview') {
    const program = findById(data.programs, args.program_id, 'Program');
    const member = findMember(data, args.person_ref);
    return { data, result: c.evaluateEnrollment(data, { program, member, virtualNow: now }) };
  }

  if (name === 'trailhead-rec.enrollment.enroll') {
    c.syncVirtualExpirations(data, now);
    const program = findById(data.programs, args.program_id, 'Program');
    const member = findMember(data, args.person_ref);
    const check = c.evaluateEnrollment(data, { program, member, virtualNow: now });
    if (!check.eligible) {
      c.fail(check.reasons[0].toLowerCase(), `Enrollment blocked: ${check.reasons.join(', ')}`);
    }
    const id = c.nextId('enr', data.enrollments, args.id);
    const confirmation_code = `TH-${id.toUpperCase()}`;
    const isEnrolled = check.outcome_if_submitted === 'enrolled';
    let fee_charged_cents = 0;
    let waitlist_position = null;
    if (isEnrolled) {
      fee_charged_cents = check.fee_cents;
      data.household_credit_cents -= fee_charged_cents;
      program.enrolled_count += 1;
    } else {
      waitlist_position =
        data.enrollments.filter((e) => e.program_id === program.id && e.status === 'waitlisted').length + 1;
    }
    const enr = {
      id,
      account_id: data.account_id,
      program_id: program.id,
      person_ref: member.person_ref,
      status: check.outcome_if_submitted,
      waitlist_position,
      offer_expires_at: null,
      fee_paid_cents: fee_charged_cents,
      refunded_cents: 0,
      confirmation_code,
      notes: args.notes || '',
      created_at: now,
      updated_at: now,
      history: [{ at: now, action: check.outcome_if_submitted }],
    };
    data.enrollments.push(enr);
    return {
      data,
      result: { id, enrollment_status: enr.status, fee_charged_cents, confirmation_code },
    };
  }

  if (name === 'trailhead-rec.enrollment.accept_offer') {
    const enr = findById(data.enrollments, args.id, 'Enrollment');
    if (enr.status !== 'offer_pending') {
      c.fail('invalid_state_transition', `Enrollment ${enr.id} is not offer_pending (current: ${enr.status}).`);
    }
    if (enr.offer_expires_at && c.parseMs(now) > c.parseMs(enr.offer_expires_at)) {
      c.fail('offer_expired', `Waitlist offer ${enr.id} expired at ${enr.offer_expires_at}.`);
    }
    c.syncVirtualExpirations(data, now);
    const program = findById(data.programs, enr.program_id, 'Program');
    const member = findMember(data, enr.person_ref);
    const check = c.evaluateEnrollment(data, { program, member, virtualNow: now, forOfferAcceptance: true });
    if (!check.eligible) {
      c.fail(check.reasons[0].toLowerCase(), `Cannot accept offer: ${check.reasons.join(', ')}`);
    }
    data.household_credit_cents -= check.fee_cents;
    enr.status = 'enrolled';
    enr.waitlist_position = null;
    enr.offer_expires_at = null;
    enr.fee_paid_cents = check.fee_cents;
    if (program.enrolled_count < program.capacity) program.enrolled_count += 1;
    c.stamp(enr, now, 'offer_accepted');
    return { data, result: { id: enr.id, fee_charged_cents: check.fee_cents } };
  }

  if (name === 'trailhead-rec.enrollment.decline_offer') {
    c.syncVirtualExpirations(data, now);
    const enr = findById(data.enrollments, args.id, 'Enrollment');
    if (enr.status !== 'offer_pending') {
      c.fail('invalid_state_transition', `Cannot decline enrollment in status: ${enr.status}`);
    }
    enr.status = 'declined';
    enr.waitlist_position = null;
    enr.offer_expires_at = null;
    c.stamp(enr, now, 'offer_declined', args.reason || undefined);
    return { data, result: { id: enr.id } };
  }

  if (name === 'trailhead-rec.enrollment.withdraw') {
    c.syncVirtualExpirations(data, now);
    const enr = findById(data.enrollments, args.id, 'Enrollment');
    if (!['enrolled', 'waitlisted', 'offer_pending'].includes(enr.status)) {
      c.fail('invalid_state_transition', `Cannot withdraw enrollment in status: ${enr.status}`);
    }
    const program = findById(data.programs, enr.program_id, 'Program');
    const nowMs = c.parseMs(now);
    let refunded_cents = 0;
    if (enr.status === 'enrolled') {
      if (program.enrolled_count > 0) program.enrolled_count -= 1;
      const penaltyFree = program.penalty_free_until && nowMs <= c.parseMs(program.penalty_free_until);
      if (penaltyFree || nowMs <= c.parseMs(program.full_refund_cutoff_at)) {
        refunded_cents = enr.fee_paid_cents;
      } else if (nowMs <= c.parseMs(program.partial_refund_cutoff_at)) {
        refunded_cents = Math.floor(enr.fee_paid_cents / 2);
      }
      data.household_credit_cents += refunded_cents;
    }
    enr.status = 'withdrawn';
    enr.waitlist_position = null;
    enr.offer_expires_at = null;
    enr.refunded_cents = refunded_cents;
    c.stamp(enr, now, 'withdrawn', args.reason || `Refunded ${refunded_cents} cents`);
    return { data, result: { id: enr.id, refunded_cents } };
  }

  // --- Athletic Court Bookings ---
  if (name === 'trailhead-rec.court.search') {
    const items = data.court_slots.filter((s) => {
      if (s.status !== 'open') return false;
      if (args.facility_id && s.facility_id !== args.facility_id) return false;
      if (args.sport && s.sport !== args.sport) return false;
      if (args.indoor !== undefined && s.indoor !== args.indoor) return false;
      return true;
    });
    return { data, result: { items: c.copy(items) } };
  }

  if (name === 'trailhead-rec.court.list_bookings') {
    const items = data.court_bookings.filter((b) => {
      if (args.person_ref && b.person_ref !== args.person_ref) return false;
      if (args.status && b.status !== args.status) return false;
      return true;
    });
    return { data, result: { items: c.copy(items) } };
  }

  if (name === 'trailhead-rec.court.book') {
    c.syncVirtualExpirations(data, now);
    const slot = findById(data.court_slots, args.slot_id, 'Court slot');
    const fac = findById(data.facilities, slot.facility_id, 'Facility');
    const member = findMember(data, args.person_ref);
    if (fac.status === 'closed_weather' || slot.status === 'closed_weather') {
      c.fail('facility_closed', `Court ${slot.id} is closed due to weather.`);
    }
    if (slot.status !== 'open') c.fail('slot_conflict', `Court slot ${slot.id} is not open.`);
    if (data.household_credit_cents < slot.resident_fee_cents) {
      c.fail('insufficient_credit', 'Insufficient household credit for court booking.');
    }
    const id = c.nextId('bkg', data.court_bookings, args.id);
    const confirmation_code = `TH-${id.toUpperCase()}`;
    slot.status = 'booked';
    data.household_credit_cents -= slot.resident_fee_cents;
    const booking = {
      id,
      account_id: data.account_id,
      slot_id: slot.id,
      facility_id: slot.facility_id,
      person_ref: member.person_ref,
      sport: slot.sport,
      starts_at: slot.starts_at,
      ends_at: slot.ends_at,
      free_cancel_cutoff_at: slot.free_cancel_cutoff_at,
      fee_paid_cents: slot.resident_fee_cents,
      refunded_cents: 0,
      status: 'confirmed',
      confirmation_code,
      created_at: now,
      updated_at: now,
      history: [{ at: now, action: 'booked' }],
    };
    data.court_bookings.push(booking);
    return { data, result: { id, confirmation_code, fee_charged_cents: slot.resident_fee_cents } };
  }

  if (name === 'trailhead-rec.court.cancel') {
    c.syncVirtualExpirations(data, now);
    const bkg = findById(data.court_bookings, args.id, 'Court booking');
    if (bkg.status !== 'confirmed') {
      c.fail('invalid_state_transition', `Cannot cancel booking in status: ${bkg.status}`);
    }
    const refunded_cents = c.parseMs(now) <= c.parseMs(bkg.free_cancel_cutoff_at) ? bkg.fee_paid_cents : 0;
    data.household_credit_cents += refunded_cents;
    const slot = data.court_slots.find((s) => s.id === bkg.slot_id);
    if (slot && slot.status === 'booked') slot.status = 'open';
    bkg.status = 'cancelled';
    bkg.refunded_cents = refunded_cents;
    c.stamp(bkg, now, 'cancelled', args.reason || `Refunded ${refunded_cents} cents`);
    return { data, result: { id: bkg.id, refunded_cents } };
  }

  c.fail('unknown_tool', `Unknown Trailhead operation: ${name}`);
}

module.exports = { handleTool };
