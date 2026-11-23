import { mount, el, time, human, tag, textBlock, metadata } from '/shared/client.js';

// App-owned Web GUI backed exclusively by Agent MCP tools (no Infra/admin or waiver-signing controls).
export const config = {
  id: 'trailhead-rec',
  title: 'Trailhead Parks & Rec',
  symbol: '▲',
  description: 'Municipal parks & recreation program registration, 24-hour waitlist offers, household roster, and athletic court reservations.',
  searchLabel: 'Search programs by title, category or schedule',
  list: 'trailhead-rec.program.search',
  collection: 'items',
  queryField: 'query',
  listArgs: {},
  get: 'trailhead-rec.program.get',
  item: 'item',
  initialSection: 'all',
  heading: (p) => p.title,
  subtitle: (p) => `${human(p.category)} · ${p.schedule_text} · ${p.enrolled_count}/${p.capacity} seats`,
  labels: {
    program_id: 'Program ID',
    person_ref: 'Household member ref',
    slot_id: 'Court slot ID',
    emergency_contact: 'Emergency contact',
    medical_notes: 'Medical notes',
    preferred_facility_id: 'Preferred facility ID',
  },
  sections: () => [
    { id: 'all', label: 'All Programs', symbol: '☷', filter: () => true },
    { id: 'open', label: 'Open Seats', symbol: '✓', filter: (p) => p.enrolled_count < p.capacity },
    { id: 'aquatics', label: 'Aquatics', symbol: '~', filter: (p) => p.category === 'aquatics' },
    { id: 'racquet', label: 'Racquet Sports', symbol: '◎', filter: (p) => p.category === 'racquet_sports' },
    { id: 'waitlist', label: 'Full / Waitlist', symbol: '…', filter: (p) => p.enrolled_count >= p.capacity },
  ],
  actions: [
    { label: 'Preview eligibility', tool: 'trailhead-rec.enrollment.preview', primary: true, selected: true, prefill: (p) => ({ program_id: p.id }) },
    { label: 'Enroll / join waitlist', tool: 'trailhead-rec.enrollment.enroll', selected: true, prefill: (p) => ({ program_id: p.id }) },
    { label: 'Accept waitlist offer', tool: 'trailhead-rec.enrollment.accept_offer' },
    { label: 'Decline waitlist offer', tool: 'trailhead-rec.enrollment.decline_offer' },
    { label: 'Withdraw enrollment', tool: 'trailhead-rec.enrollment.withdraw' },
    { label: 'Update emergency/medical note', tool: 'trailhead-rec.household.update_member' },
    { label: 'Search courts', tool: 'trailhead-rec.court.search' },
    { label: 'Book court', tool: 'trailhead-rec.court.book' },
    { label: 'Cancel court', tool: 'trailhead-rec.court.cancel' },
  ],
  row: (p, ui) => el(
    'div',
    { class: 'program-row ' + p.category },
    ui.record(
      p,
      el('span', { class: 'record-title' }, p.title),
      el('span', { class: 'record-subtitle' }, `${p.schedule_text} · Ages ${p.min_age}-${p.max_age} · ${p.enrolled_count}/${p.capacity}`)
    )
  ),
  view: (p) => el(
    'article',
    { class: 'program-reader' },
    el('span', { class: 'kicker' }, `${p.id} · ${human(p.category)}`),
    el('h2', {}, p.title),
    el('div', { class: 'tags' }, tag(p.season), tag(`Ages ${p.min_age}-${p.max_age}`), tag(p.enrolled_count < p.capacity ? 'Open' : 'Waitlist')),
    textBlock(`Schedule: ${p.schedule_text} at ${p.facility_id}.`),
    metadata('Resident / Non-resident fee', `$${(p.resident_fee_cents / 100).toFixed(2)} / $${(p.non_resident_fee_cents / 100).toFixed(2)}`),
    metadata('Prerequisite skill', p.prerequisite_skill ? human(p.prerequisite_skill) : 'None'),
    metadata('Required waiver', p.required_waiver ? human(p.required_waiver) : 'None'),
    metadata('Starts at', time(p.starts_at)),
    metadata('Full refund cutoff', time(p.full_refund_cutoff_at)),
    metadata('Partial refund cutoff', time(p.partial_refund_cutoff_at))
  ),
};

mount(config);
