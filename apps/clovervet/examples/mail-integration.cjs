'use strict';

// End-to-end integration test: CloverVet -> Messaging Router -> real Mail (examples/apps/mail).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const publisher = require('../src/publisher.cjs');

const repoRoot = path.resolve(__dirname, '../../..');
const { Client } = require(path.join(repoRoot, 'runtime/client.cjs'));
const { prepare } = require(path.join(repoRoot, 'runtime/prepare.cjs'));

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pale-clovervet-mail-'));
  const prepared = prepare(path.join(repoRoot, 'apps/clovervet'), []);
  const clients = [];
  try {
    const routerConfigPath = path.join(dir, 'router-config.json');
    fs.writeFileSync(
      routerConfigPath,
      JSON.stringify(
        {
          schema_version: 2,
          registry: 'examples/registry.mail.json',
          publishers: [
            {
              app_id: 'clovervet',
              account_id: 'acct-hannah',
              owner_person_id: 'person-hannah',
              package_root: 'apps/clovervet',
              contribution_ref: 'contribution/contribution.json',
              allowed_recipients: [
                { app_id: 'mail', account_id: 'mail-maya', channel: 'channel.email' },
              ],
            },
          ],
          authentication: { mode: 'trusted-stdio' },
        },
        null,
        2
      )
    );

    const cvState = path.join(dir, 'cv-state');
    const mailState = path.join(dir, 'mail-state');
    const cvInfra = new Client('clovervet', 'infra', 'cv-mail-run', cvState, 'cv-infra', { registry: prepared.registry });
    const cvAgent = new Client('clovervet', 'agent', 'cv-mail-run', cvState, 'cv-agent', { registry: prepared.registry, profile: 'sandbox' });
    const mailAgent = new Client('mail', 'agent', 'cv-mail-run', mailState, 'mail-reader', { registry: path.join(repoRoot, 'examples/registry.mail.json') });
    const router = new Client(null, null, null, null, 'cv-mail-run', {
      commandArgs: [
        path.join(repoRoot, 'runtime/messaging/service.cjs'),
        '--config', routerConfigPath,
        '--publisher', 'clovervet',
        '--run', 'cv-mail-run',
        '--state-dir', mailState,
      ],
    });
    clients.push(cvInfra, cvAgent, mailAgent, router);
    await Promise.all(clients.map((c) => c.initialize()));

    const initSnap = await cvInfra.call('env.snapshot', {});
    assert.equal((await cvInfra.call('env.reset', { expected_version: initSnap.version, profile: 'sandbox' })).status, 'ready');

    // 1. Book a Fear-Free booster slot for Mochi
    const snap = await cvInfra.call('env.snapshot', {});
    const booked = await cvAgent.call('clovervet.appointment.book', {
      id: 'appt-mochi-vax',
      pet_id: 'pet-mochi',
      slot_id: 'slot-oak-01',
      visit_type: 'vaccine_booster',
      expected_version: snap.version,
      request_id: 'req-book-mochi-1',
    });
    assert.equal(booked.status, 'committed');
    assert.equal(booked.confirmation_code, 'CV-APPT-MOCHI-VAX');

    // 2. Explicit post-commit Mail notification + mail.get verification (including thread_id === wire.id)
    const delivered = await publisher.publishAppointmentConfirmation({
      agent: cvAgent,
      router,
      appointmentId: 'appt-mochi-vax',
      requestId: 'req-pub-cv-1',
      sourceAccount: 'acct-hannah',
      recipient: { kind: 'app_account_ref', app_id: 'mail', id: 'mail-maya' },
    });
    assert.equal(delivered.stage, 'delivered');
    assert.equal(delivered.receipt.status, 'committed');

    const mailMsg = await mailAgent.call('mail.get', { id: delivered.receipt.event_id });
    assert.equal(mailMsg.status, 'ok');
    assert.equal(mailMsg.message.thread_id, delivered.message.id);
    assert.ok(mailMsg.message.body.includes('CV-APPT-MOCHI-VAX'));

    // 3. Idempotent retry
    const retry = await router.call('router.publish', { request_id: 'req-pub-cv-retry', message: delivered.message });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.event_id, delivered.receipt.event_id);

    // 4. Ungranted recipient refusal does not roll back CloverVet appointment
    const refused = await publisher.publishAppointmentConfirmation({
      agent: cvAgent,
      router,
      appointmentId: 'appt-mochi-vax',
      requestId: 'req-pub-cv-denied',
      sourceAccount: 'acct-hannah',
      recipient: { kind: 'app_account_ref', app_id: 'mail', id: 'mail-ungranted' },
      noticeTag: 'denied',
    });
    assert.equal(refused.stage, 'router_rejected');
    const stillBooked = await cvAgent.call('clovervet.appointment.get', { id: 'appt-mochi-vax' });
    assert.equal(stillBooked.item.status, 'scheduled');

    // 5. Resetting CloverVet does not clear Mail inbox
    const preReset = await cvInfra.call('env.snapshot', {});
    assert.equal((await cvInfra.call('env.reset', { expected_version: preReset.version, profile: 'sandbox' })).status, 'ready');
    assert.equal((await mailAgent.call('mail.get', { id: delivered.receipt.event_id })).status, 'ok');

    return { passed: true, confirmation_code: booked.confirmation_code, mail_event_id: delivered.receipt.event_id, thread_id: mailMsg.message.thread_id };
  } finally {
    await Promise.allSettled(clients.map((c) => c.close()));
    prepared.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { run };
if (require.main === module) {
  run()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      console.log('PASS: 5 CloverVet-to-Mail real MCP integration checks.');
    })
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
}
