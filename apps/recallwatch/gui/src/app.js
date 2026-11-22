import { mount, el, time, human, tag, textBlock, metadata } from '/shared/client.js';

// App-owned Web GUI backed exclusively by Agent MCP tools (no Infra/admin controls).
export const config = {
  id: 'recallwatch',
  title: 'RecallWatch',
  symbol: '!',
  description: 'Product safety recalls, household lot-level exposure matching, watchlists, and remedy claims.',
  searchLabel: 'Search recalls by brand, UPC, hazard or lot',
  list: 'recallwatch.recall.search',
  collection: 'items',
  queryField: 'query',
  listArgs: {},
  get: 'recallwatch.recall.get',
  item: 'item',
  initialSection: 'active',
  heading: (r) => `${r.brand} — ${r.product_name}`,
  subtitle: (r) => `${r.id} · ${r.severity.toUpperCase()} · ${r.status}`,
  labels: {
    id: 'Record ID',
    recall_id: 'Recall ID',
    item_id: 'Household item ID',
    lot_code: 'Lot / batch code',
    remedy_type: 'Remedy option',
    shipping_address: 'Shipping address',
    recipient_name: 'Recipient name',
    recipient_person_ref: 'Recipient person ref',
    payout_method: 'Payout method',
    holder_person_ref: 'Holder person ref',
    location_note: 'Location note',
  },
  sections: () => [
    { id: 'active', label: 'Active & Expanded', symbol: '!', filter: (r) => ['active', 'expanded'].includes(r.status) },
    { id: 'class_i', label: 'Class I Urgent', symbol: '▲', filter: (r) => r.severity === 'class_i' },
    { id: 'amended', label: 'Amended / Closed', symbol: '≡', filter: (r) => ['amended', 'closed'].includes(r.status) },
    { id: 'all', label: 'All Advisories', symbol: '☷', filter: () => true },
  ],
  actions: [
    { label: 'Register household item', tool: 'recallwatch.inventory.register', primary: true },
    { label: 'Check exposure', tool: 'recallwatch.inventory.check_exposure' },
    { label: 'Preview claim', tool: 'recallwatch.claim.preview', selected: true, prefill: (r) => ({ recall_id: r.id, remedy_type: r.remedy_types[0] }) },
    { label: 'New claim draft', tool: 'recallwatch.claim.create_draft', selected: true, prefill: (r) => ({ recall_id: r.id, remedy_type: r.remedy_types[0] }) },
    { label: 'Amend claim', tool: 'recallwatch.claim.amend' },
    { label: 'Submit claim', tool: 'recallwatch.claim.submit' },
    { label: 'Withdraw claim', tool: 'recallwatch.claim.withdraw' },
    { label: 'New watchlist rule', tool: 'recallwatch.watchlist.create' },
  ],
  row: (r, ui) => el(
    'div',
    { class: 'recall-row ' + r.severity },
    ui.record(
      r,
      el('span', { class: 'record-title' }, `${r.brand} ${r.product_name}`),
      el('span', { class: 'record-subtitle' }, `${r.id} · ${r.severity.toUpperCase()} · Lots: ${r.affected_lots.join(', ')}`)
    )
  ),
  view: (r) => el(
    'article',
    { class: 'recall-reader' },
    el('span', { class: 'kicker' }, `${r.id} · ${human(r.category)}`),
    el('h2', {}, `${r.brand} — ${r.product_name}`),
    el('div', { class: 'tags' }, tag(r.severity.toUpperCase()), tag(human(r.status)), tag(human(r.hazard))),
    textBlock(r.summary),
    metadata('UPC', r.upc),
    metadata('Affected lots', r.affected_lots.join(', ')),
    metadata('Excluded lots', r.excluded_lots.length ? r.excluded_lots.join(', ') : 'None'),
    metadata('Remedy options', r.remedy_types.map(human).join(', ')),
    metadata('Proof required', r.proof_required ? 'Yes' : 'No'),
    metadata('Claim deadline', time(r.remedy_deadline_at))
  ),
};

mount(config);
