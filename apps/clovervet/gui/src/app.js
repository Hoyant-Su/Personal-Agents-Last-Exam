import { mount, el, time, human, tag, textBlock, metadata } from '/shared/client.js';

// App-owned Web GUI backed exclusively by Agent MCP tools (no Infra/admin controls).
export const config = {
  id: 'clovervet',
  title: 'CloverVet',
  symbol: '+',
  description: 'Household pet profiles, vaccination & boarding/travel clearances, clinic appointments, and veterinary prescription refills.',
  searchLabel: 'Filter pets',
  list: 'clovervet.pet.list',
  collection: 'items',
  listArgs: {},
  get: 'clovervet.pet.get',
  item: 'item',
  initialSection: 'all',
  heading: (p) => `${p.name} (${p.breed})`,
  subtitle: (p) => `${human(p.species)} · ${p.weight_kg} kg · Microchip ${p.microchip_id}`,
  labels: {
    pet_id: 'Pet ID',
    slot_id: 'Clinic slot ID',
    visit_type: 'Visit type',
    caretaker_person_ref: 'Caretaker person ref',
    clearance_type: 'Clearance type',
    stay_start_at: 'Stay / departure start',
    stay_end_at: 'Stay end',
    prescription_id: 'Prescription ID',
    fulfillment_mode: 'Fulfillment mode',
    shipping_address: 'Shipping address',
  },
  sections: () => [
    { id: 'all', label: 'All Pets', symbol: '☷', filter: () => true },
    { id: 'dogs', label: 'Dogs', symbol: 'D', filter: (p) => p.species === 'dog' },
    { id: 'cats', label: 'Cats', symbol: 'C', filter: (p) => p.species === 'cat' },
    { id: 'fear_free', label: 'Fear-Free Required', symbol: '!', filter: (p) => (p.handling_flags || []).includes('fear_free_room') },
  ],
  actions: [
    { label: 'Check boarding/travel clearance', tool: 'clovervet.clearance.check', primary: true, selected: true, prefill: (p) => ({ pet_id: p.id, clearance_type: 'boarding_stay' }) },
    { label: 'Issue clearance certificate', tool: 'clovervet.clearance.issue', selected: true, prefill: (p) => ({ pet_id: p.id, clearance_type: 'boarding_stay' }) },
    { label: 'Search clinic slots', tool: 'clovervet.slot.search' },
    { label: 'Book appointment', tool: 'clovervet.appointment.book', selected: true, prefill: (p) => ({ pet_id: p.id, visit_type: 'vaccine_booster' }) },
    { label: 'Reschedule appointment', tool: 'clovervet.appointment.reschedule' },
    { label: 'Cancel appointment', tool: 'clovervet.appointment.cancel' },
    { label: 'Request prescription refill', tool: 'clovervet.prescription.request_refill' },
    { label: 'Amend refill', tool: 'clovervet.prescription.amend_refill' },
  ],
  row: (p, ui) => el(
    'div',
    { class: 'pet-row ' + p.species },
    ui.record(
      p,
      el('span', { class: 'record-title' }, `${p.name} — ${p.breed}`),
      el('span', { class: 'record-subtitle' }, `${human(p.species)} · ${p.weight_kg} kg · Allergies: ${p.allergies.length ? p.allergies.join(', ') : 'None'}`)
    )
  ),
  view: (p) => el(
    'article',
    { class: 'pet-reader' },
    el('span', { class: 'kicker' }, `${p.id} · ${human(p.species)}`),
    el('h2', {}, `${p.name} — ${p.breed}`),
    el('div', { class: 'tags' }, ...(p.handling_flags || []).map((f) => tag(human(f))), ...(p.allergies || []).map((a) => tag('Allergy: ' + human(a)))),
    textBlock(p.notes || 'No clinic notes.'),
    metadata('Weight', `${p.weight_kg} kg`),
    metadata('Microchip', p.microchip_id),
    metadata('Primary clinic / vet', `${p.primary_branch_id} / ${p.primary_vet_id}`),
    metadata('Last exam', p.last_exam_at ? time(p.last_exam_at) : 'None'),
    metadata('Exam valid until', p.exam_valid_until ? time(p.exam_valid_until) : 'None'),
    metadata('Authorized caretakers', (p.authorized_caretakers || []).map((c) => `${c.person_ref} (${c.scope})`).join(', ') || 'Owner only')
  ),
};

mount(config);
