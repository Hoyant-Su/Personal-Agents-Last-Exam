'use strict';

// Explicit App-owned post-commit outbound publisher for channel.email.
// Uses unique CloudEvents IDs (<= 100 chars), which Mail preserves as thread_id for mail.get correlation.

function buildCloudEvent({ id, sourceAccount, time, subject, recipient, sourceObject, title, text }) {
  if (id.length > 100) throw new Error('CloudEvents id must be <= 100 characters.');
  return {
    specversion: '1.0',
    id,
    source: `urn:pale:app:clovervet:account:${sourceAccount}`,
    type: 'org.pale.mail.notification.v1',
    datacontenttype: 'application/json',
    dataschema: 'urn:pale:email-payload:1',
    time,
    subject,
    data: {
      channel: 'channel.email',
      recipient,
      source_object: sourceObject,
      content: {
        title,
        body: { format: 'text/plain', text },
        asset_ids: [],
      },
      extensions: [],
    },
  };
}

function appointmentNotification(appt, { sourceAccount, recipient, noticeTag = 'v1' }) {
  if (!appt || appt.account_id !== sourceAccount) {
    throw new Error('Appointment does not belong to bound sourceAccount.');
  }
  const msgId = `cv-appt-${appt.id}-${appt.status}-${noticeTag}`.slice(0, 100);
  return buildCloudEvent({
    id: msgId,
    sourceAccount,
    time: appt.updated_at,
    subject: appt.id,
    recipient,
    sourceObject: {
      app_id: 'clovervet',
      account_id: sourceAccount,
      object_type: 'appointment',
      object_id: appt.id,
    },
    title: `CloverVet Appointment ${appt.status}: ${appt.visit_type} (${appt.confirmation_code})`,
    text: `Appointment ${appt.id} (${appt.visit_type}) for pet ${appt.pet_id} at ${appt.branch_id} on ${appt.starts_at} is ${appt.status}. Confirmation: ${appt.confirmation_code}.`,
  });
}

async function publishAppointmentConfirmation({ agent, router, appointmentId, requestId, sourceAccount, recipient, noticeTag = 'v1' }) {
  const fetched = await agent.call('clovervet.appointment.get', { id: appointmentId });
  if (fetched.status !== 'ok') {
    return { stage: 'source_read', result: fetched, correlation: null };
  }
  const message = appointmentNotification(fetched.item, { sourceAccount, recipient, noticeTag });
  const receipt = await router.call('router.publish', { request_id: requestId, message });

  const correlation = {
    message_id: message.id,
    event_id: receipt.event_id || null,
    source_object: message.data.source_object,
    recipient: message.data.recipient,
    router_status: receipt.status,
  };

  if (receipt.status === 'committed') {
    return { stage: 'delivered', source: fetched.item, message, receipt, correlation, stop_run: false };
  }
  if (receipt.status === 'unknown' || receipt.status === 'unknown_outcome') {
    return { stage: 'unknown_outcome', source: fetched.item, message, receipt, correlation, stop_run: true };
  }
  return { stage: 'router_rejected', source: fetched.item, message, receipt, correlation, stop_run: false };
}

module.exports = {
  buildCloudEvent,
  appointmentNotification,
  publishAppointmentConfirmation,
};
