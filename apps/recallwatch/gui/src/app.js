import { connect, el } from '/shared/client.js';

// App-owned 4-view interactive Web GUI backed exclusively by Agent MCP tools (no Infra/admin controls).
const root = document.getElementById('app');
const state = {
  tab: 'recalls',
  version: null,
  query: '',
  recalls: [],
  inventory: [],
  exposures: [],
  watchlists: [],
  claims: [],
  statusMessage: '',
};

let client = null;
let reqSeq = 1;
const nextReq = (tag) => `web-rw-${tag}-${Date.now()}-${reqSeq++}`;

async function callTool(name, args = {}) {
  const res = await client.call(name, args);
  if (res.version) state.version = res.version;
  return res;
}

async function refreshAll() {
  const [recalls, inv, watchlists, claims] = await Promise.all([
    callTool('recallwatch.recall.search', state.query ? { query: state.query } : {}),
    callTool('recallwatch.inventory.list', { include_archived: true }),
    callTool('recallwatch.watchlist.list', {}),
    callTool('recallwatch.claim.list', {}),
  ]);
  state.recalls = recalls.items || [];
  state.inventory = inv.items || [];
  state.exposures = inv.exposures || [];
  state.watchlists = watchlists.items || [];
  state.claims = claims.items || [];
  render();
}

async function runWrite(label, tool, args) {
  try {
    const res = await callTool(tool, {
      ...args,
      expected_version: state.version,
      request_id: nextReq(label),
    });
    if (res.status === 'committed') {
      state.statusMessage = `${label}: committed (v${res.version.epoch}.${res.version.revision})`;
    } else {
      state.statusMessage = `${label}: ${res.error ? `${res.error.code} - ${res.error.message}` : res.status}`;
    }
    await refreshAll();
  } catch (err) {
    state.statusMessage = `${label}: ${err.message}`;
    render();
  }
}

function renderRecalls() {
  const input = el('input', { type: 'search', placeholder: 'Search brand, UPC, hazard, or lot...', value: state.query });
  const btn = el('button', { type: 'button' }, 'Search');
  btn.addEventListener('click', () => {
    state.query = input.value.trim();
    refreshAll();
  });
  const list = el('div', { class: 'list' });
  for (const r of state.recalls) {
    list.appendChild(
      el(
        'article',
        { class: 'card' },
        el('h3', {}, `${r.brand} — ${r.product_name}`),
        el('p', {}, `${r.id} · ${r.severity.toUpperCase()} · ${r.status} · Hazard: ${r.hazard}`),
        el('p', {}, `Lots: ${(r.affected_lots || []).join(', ')} · Deadline: ${r.remedy_deadline_at}`)
      )
    );
  }
  return el('section', { 'data-view': 'recalls' }, el('div', { class: 'toolbar' }, input, btn), list);
}

function renderInventory() {
  const expById = new Map((state.exposures || []).map((e) => [e.item_id, e]));
  const list = el('div', { class: 'list' });
  for (const it of state.inventory) {
    const exp = expById.get(it.id);
    const actions = [];
    if (it.status !== 'archived') {
      const archBtn = el('button', { type: 'button', 'data-action': 'archive-item', 'data-id': it.id }, 'Archive Item');
      archBtn.addEventListener('click', () =>
        runWrite('inventory.archive', 'recallwatch.inventory.archive', { id: it.id, disposal_note: 'Disposed via RecallWatch web portal' })
      );
      actions.push(archBtn);
    }
    list.appendChild(
      el(
        'article',
        { class: 'card' },
        el('h4', {}, `${it.brand} ${it.product_name} (${it.status})`),
        el('p', {}, `ID: ${it.id} · Lot: ${it.lot_code} · Holder: ${it.holder_person_ref} · Exposure: ${exp ? exp.exposure_status : 'unknown'}`),
        ...actions
      )
    );
  }
  return el('section', { 'data-view': 'inventory' }, el('h2', {}, 'Household Inventory & Exposure'), list);
}

function renderWatchlists() {
  const list = el('div', { class: 'list' });
  for (const w of state.watchlists) {
    const delBtn = el('button', { type: 'button', 'data-action': 'delete-watchlist', 'data-id': w.id }, 'Remove Watchlist');
    delBtn.addEventListener('click', () =>
      runWrite('watchlist.delete', 'recallwatch.watchlist.delete', { id: w.id })
    );
    list.appendChild(
      el(
        'article',
        { class: 'card' },
        el('h4', {}, `${w.id} · ${w.name || w.label || w.category || 'Watchlist'}`),
        el('p', {}, `Enabled: ${w.enabled !== false} · Min severity: ${w.min_severity || 'any'}`),
        delBtn
      )
    );
  }
  return el('section', { 'data-view': 'watchlists' }, el('h2', {}, 'Watchlists'), list);
}

function renderClaims() {
  const list = el('div', { class: 'list' });
  for (const c of state.claims) {
    const actions = [];
    if (c.status === 'draft') {
      const subBtn = el('button', { type: 'button', 'data-action': 'submit-claim', 'data-id': c.id }, 'Submit Claim');
      subBtn.addEventListener('click', () => runWrite('claim.submit', 'recallwatch.claim.submit', { id: c.id }));
      actions.push(subBtn);
    }
    if (['draft', 'submitted'].includes(c.status)) {
      const wdBtn = el('button', { type: 'button', 'data-action': 'withdraw-claim', 'data-id': c.id }, 'Withdraw Claim');
      wdBtn.addEventListener('click', () => runWrite('claim.withdraw', 'recallwatch.claim.withdraw', { id: c.id, reason: 'Withdrawn by household' }));
      actions.push(wdBtn);
    }
    list.appendChild(
      el(
        'article',
        { class: 'card' },
        el('h4', {}, `${c.id} · ${c.recall_id} · ${c.status}`),
        el('p', {}, `Item: ${c.item_id} · Lot: ${c.lot_code} · Remedy: ${c.remedy_type}`),
        ...actions
      )
    );
  }
  return el('section', { 'data-view': 'claims' }, el('h2', {}, 'Remedy Claims'), list);
}

function render() {
  root.textContent = '';
  const tabs = [
    ['recalls', 'Recalls'],
    ['inventory', 'Household Inventory'],
    ['watchlists', 'Watchlists'],
    ['claims', 'Remedy Claims'],
  ];
  const nav = el('nav', { class: 'tabs' });
  for (const [id, label] of tabs) {
    const btn = el('button', { type: 'button', class: state.tab === id ? 'active' : '' }, label);
    btn.addEventListener('click', () => {
      state.tab = id;
      render();
    });
    nav.appendChild(btn);
  }
  const header = el(
    'header',
    {},
    el('h1', {}, 'RecallWatch'),
    el('p', {}, `State version: v${state.version ? `${state.version.epoch}.${state.version.revision}` : '0.0'}`),
    state.statusMessage ? el('p', { class: 'status' }, state.statusMessage) : el('span', {}),
    nav
  );
  let body;
  if (state.tab === 'recalls') body = renderRecalls();
  else if (state.tab === 'inventory') body = renderInventory();
  else if (state.tab === 'watchlists') body = renderWatchlists();
  else body = renderClaims();
  root.appendChild(el('main', {}, header, body));
}

connect().then((c) => {
  client = c;
  return refreshAll();
});
