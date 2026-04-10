const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEmailBody, sendDailyBrief } = require('../../scripts/send-daily-brief');

test('buildEmailBody includes drive link when one is available', () => {
  const body = buildEmailBody({
    file_name: 'brief.pdf',
    file_path: '/tmp/brief.pdf',
    upload: {
      web_view_link: 'https://drive.example/brief'
    },
    preview: {
      generated_at: '2026-04-10T15:30:00.000Z'
    }
  });

  assert.match(body, /Your ISG daily brief is ready/);
  assert.match(body, /https:\/\/drive\.example\/brief/);
  assert.match(body, /brief\.pdf/);
});

test('sendDailyBrief generates the brief and sends the email', async () => {
  const calls = [];

  const result = await sendDailyBrief({
    recipient: 'broker@example.com',
    fromAlias: 'ISG Ops',
    generateDailyBrief: async () => ({
      file_name: 'brief.pdf',
      file_path: '/tmp/brief.pdf',
      upload: {
        web_view_link: 'https://drive.example/brief'
      },
      preview: {
        generated_at: '2026-04-10T15:30:00.000Z'
      }
    }),
    sendEmail: async (to, subject, body, fromAlias) => {
      calls.push({ to, subject, body, fromAlias });
      return {
        delivery: 'sent',
        message_id: 'msg-1'
      };
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, 'broker@example.com');
  assert.equal(calls[0].fromAlias, 'ISG Ops');
  assert.match(calls[0].subject, /ISG Daily Brief/);
  assert.equal(result.email.delivery, 'sent');
});
