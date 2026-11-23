'use strict';

// End-to-end integration test: Trailhead Parks & Rec -> Messaging Router -> real Mail (examples/apps/mail).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const publisher = require('../src/publisher.cjs');

const repoRoot = path.resolve(__dirname, '../../..');
const { Client } = require(path.join(repoRoot, 'runtime/client.cjs'));
const { prepare } = require(path.join(repoRoot, 'runtime/prepare.cjs'));

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pale-trailhead-mail-'));
  const prepared = prepare(path.join(repoRoot, 'apps/trailhead-rec'), []);
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
              app_id: 'trailhead-rec',
              account_id: 'acct-elena',
              owner_person_id: 'person-elena',
              package_root: 'apps/trailhead-rec',
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

    const thState = path.join(dir, 'th-state');
    const mailState = path.join(dir, 'mail-state');
    const thInfra = new Client('trailhead-rec', 'infra', 'th-mail-run', thState, 'th-infra', { registry: prepared.registry });
    const thAgent = new Client('trailhead-rec', 'agent', 'th-mail-run', thState, 'th-agent', { registry: prepared.registry, profile: 'sandbox' });
    const mailAgent = new Client('mail', 'agent', 'th-mail-run', mailState, 'mail-reader', { registry: path.join(repoRoot, 'examples/registry.mail.json') });
    const router = new Client(null, null, null, null, 'th-mail-run', {
      commandArgs: [
        path.join(repoRoot, 'runtime/messaging/service.cjs'),
        '--config', routerConfigPath,
        '--publisher', 'trailhead-rec',
        '--run', 'th-mail-run',
        '--state-dir', mailState,
      ],
    });
    clients.push(thInfra, thAgent, mailAgent, router);
    await Promise.all(clients.map((c) => c.initialize()));

    const initSnap = await thInfra.call('env.snapshot', {});
    assert.equal((await thInfra.call('env.reset', { expected_version: initSnap.version, profile: 'sandbox' })).status, 'ready');

    // 1. Accept Leo's pending waitlist offer enr-205 before 2026-11-19T15:00:00+00:00
    const before = await thAgent.call('trailhead-rec.enrollment.get', { id: 'enr-205' });
    assert.equal(before.effective_status, 'offer_pending');
    const accepted = await thAgent.call('trailhead-rec.enrollment.accept_offer', {
      id: 'enr-205',
      expected_version: before.version,
      request_id: 'req-accept-205',
    });
    assert.equal(accepted.status, 'committed');
    assert.equal(accepted.fee_charged_cents, 6500);

    // 2. Explicit post-commit Mail notification + mail.get verification (including thread_id === wire.id)
    const delivered = await publisher.publishEnrollmentNotice({
      agent: thAgent,
      router,
      enrollmentId: 'enr-205',
      requestId: 'req-pub-th-1',
      sourceAccount: 'acct-elena',
      recipient: { kind: 'app_account_ref', app_id: 'mail', id: 'mail-maya' },
    });
    assert.equal(delivered.stage, 'delivered');
    const mailMsg = await mailAgent.call('mail.get', { id: delivered.receipt.event_id });
    assert.equal(mailMsg.status, 'ok');
    assert.equal(mailMsg.message.thread_id, delivered.message.id);
    assert.ok(mailMsg.message.body.includes('enr-205'));

    // 3. Idempotent retry
    const retry = await router.call('router.publish', { request_id: 'req-pub-th-retry', message: delivered.message });
    assert.equal(retry.duplicate, true);
    assert.equal(retry.event_id, delivered.receipt.event_id);

    // 4. Ungranted recipient refusal does not roll back local enrollment
    const refused = await publisher.publishEnrollmentNotice({
      agent: thAgent,
      router,
      enrollmentId: 'enr-205',
      requestId: 'req-pub-th-denied',
      sourceAccount: 'acct-elena',
      recipient: { kind: 'app_account_ref', app_id: 'mail', id: 'mail-ungranted' },
      noticeTag: 'denied',
    });
    assert.equal(refused.stage, 'router_rejected');
    assert.equal((await thAgent.call('trailhead-rec.enrollment.get', { id: 'enr-205' })).item.status, 'enrolled');

    // 5. Resetting Trailhead does not clear Mail inbox
    const preReset = await thInfra.call('env.snapshot', {});
    assert.equal((await thInfra.call('env.reset', { expected_version: preReset.version, profile: 'sandbox' })).status, 'ready');
    assert.equal((await mailAgent.call('mail.get', { id: delivered.receipt.event_id })).status, 'ok');

    return { passed: true, enrollment_id: 'enr-205', mail_event_id: delivered.receipt.event_id, thread_id: mailMsg.message.thread_id };
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
      console.log('PASS: 5 Trailhead-to-Mail real MCP integration checks.');
    })
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    });
}
