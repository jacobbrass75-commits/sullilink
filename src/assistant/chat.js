const { complete } = require('../inference/provider');
const { classifyMessage } = require('../ingestion/classifier');
const { routeClassifiedMessage } = require('../ingestion/router');
const { hybridSearch } = require('../knowledge/search');
const {
  lookupIdentifier,
  runMatchingForBuyer,
  runMatchingForProperty
} = require('../matching/runner');
const { lookupEntityOrProperty } = require('../entities/lookup');
const { getDailyOverview } = require('../daily/overview');
const { getTodaysAgenda, createEvent } = require('../integrations/calendar');
const { sendEmail, draftEmail } = require('../integrations/gmail');
const {
  syncNewProperties,
  syncReviewDecisions,
  triggerMatchingForNewProperties
} = require('../integrations/realestatetool-sync');
const { pullDealUpdates, pushDailyActions } = require('../integrations/monday-sync');
const { generateDailyBrief } = require('../integrations/pdf-generator');
const { createDefaultSessionStore, createInMemorySessionStore } = require('./session-store');

const SIDE_EFFECT_TOOLS = new Set([
  'send_email',
  'create_calendar_event',
  'run_property_sync',
  'run_monday_sync',
  'generate_daily_brief_pdf'
]);
const YES_PATTERN = /^(?:yes|yep|yeah|send it|do it|go ahead|confirm|ship it|run it|ok|okay)\b/i;
const NO_PATTERN = /^(?:no|cancel|stop|never mind|dont|don't)\b/i;

const defaultDependencies = {
  complete,
  classifyMessage,
  routeClassifiedMessage,
  hybridSearch,
  lookupIdentifier,
  runMatchingForBuyer,
  runMatchingForProperty,
  lookupEntityOrProperty,
  getDailyOverview,
  getTodaysAgenda,
  createEvent,
  sendEmail,
  draftEmail,
  syncNewProperties,
  syncReviewDecisions,
  triggerMatchingForNewProperties,
  pullDealUpdates,
  pushDailyActions,
  generateDailyBrief,
  sessionStore: createDefaultSessionStore()
};

let dependencies = { ...defaultDependencies };

function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function limitText(value, maxLength = 280) {
  const text = cleanText(value, '');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function toJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function extractJsonObject(value) {
  const direct = toJson(value, null);

  if (direct) {
    return direct;
  }

  const cleaned = String(value || '').replace(/```json|```/gi, '').trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  return toJson(cleaned.slice(firstBrace, lastBrace + 1), null);
}

function buildPlannerPrompt(message, session) {
  const recentHistory = (session.history || [])
    .slice(-6)
    .map((entry) => `${entry.role.toUpperCase()}: ${entry.text}`)
    .join('\n');
  const pendingAction = session.pending_action
    ? `Pending action: ${JSON.stringify(session.pending_action)}`
    : 'Pending action: none';

  return `You are a Telegram chat planner for a commercial real estate AI assistant.

The user should be able to talk normally, without slash commands.

Pick exactly one tool from this list:
- answer_only: casual reply or clarifying question, no tool call
- store_note: save broker intel or notes into the brain
- search_brain: semantic knowledge search
- lookup_brain: look up a person, company, or property
- run_match: run buyer/property matching
- daily_overview: summarize today's agenda and urgent action items
- draft_email: create a Gmail draft
- send_email: send an email
- create_calendar_event: schedule an event
- run_property_sync: sync RealEstateTool properties and review decisions
- run_monday_sync: pull Monday deal updates and push overdue action updates
- generate_daily_brief_pdf: generate the broker daily brief PDF

Rules:
- Use store_note for new broker observations that should be remembered.
- Use lookup_brain for "what do we know about X", "who owns Y", "tell me about X".
- Use search_brain for broad knowledge search across notes.
- Use run_match for "who fits", "who should buy this", "run matches for".
- Use daily_overview for today's agenda, today's priorities, or "what should I do today".
- Use draft_email when the user asks to draft or prepare an email.
- Use send_email only when the user clearly wants to send.
- Use create_calendar_event only when the user is scheduling something.
- If a required field is missing, ask a short clarifying question in reply and list missing_fields.
- Prefer requires_confirmation=true for send_email and create_calendar_event unless the user explicitly says to send/create now.

Return only JSON with this shape:
{
  "tool_name": "store_note",
  "tool_args": {},
  "reply": null,
  "missing_fields": [],
  "requires_confirmation": false
}

Conversation history:
${recentHistory || 'None'}
${pendingAction}

User message:
${message}`;
}

function buildDefaultPlannerResult(message) {
  const trimmed = cleanText(message, '') || '';
  const normalized = trimmed.toLowerCase();

  if (/(what(?:'s| is) on my day|agenda|today's schedule|todays schedule|what should i do today)/i.test(trimmed)) {
    return { tool_name: 'daily_overview', tool_args: {}, reply: null, missing_fields: [], requires_confirmation: false };
  }

  if (/(sync .*monday|pull monday|refresh monday)/i.test(trimmed)) {
    return { tool_name: 'run_monday_sync', tool_args: {}, reply: null, missing_fields: [], requires_confirmation: false };
  }

  if (/(sync .*propert|refresh .*propert|run .*property sync|realestatetool sync)/i.test(trimmed)) {
    return { tool_name: 'run_property_sync', tool_args: {}, reply: null, missing_fields: [], requires_confirmation: false };
  }

  if (/(daily brief pdf|generate .*daily brief|make .*daily brief)/i.test(trimmed)) {
    return { tool_name: 'generate_daily_brief_pdf', tool_args: {}, reply: null, missing_fields: [], requires_confirmation: false };
  }

  if (/(run match|match this|who fits|who should buy|matches for|buyers for)/i.test(trimmed)) {
    return {
      tool_name: 'run_match',
      tool_args: {
        identifier: extractSubject(trimmed)
      },
      reply: null,
      missing_fields: [],
      requires_confirmation: false
    };
  }

  if (/(what do we know about|tell me about|who owns|lookup|look up)/i.test(trimmed)) {
    return {
      tool_name: 'lookup_brain',
      tool_args: {
        identifier: extractSubject(trimmed)
      },
      reply: null,
      missing_fields: [],
      requires_confirmation: false
    };
  }

  if (/(search|find notes|search the brain|notes on)/i.test(trimmed)) {
    return {
      tool_name: 'search_brain',
      tool_args: {
        query: extractSubject(trimmed)
      },
      reply: null,
      missing_fields: [],
      requires_confirmation: false
    };
  }

  if (/(draft an? email|draft email|prepare an? email)/i.test(normalized)) {
    return {
      tool_name: 'draft_email',
      tool_args: {},
      reply: 'I can draft that. Tell me who it should go to, the subject, and the body if you want a precise draft.',
      missing_fields: ['to', 'subject', 'body'],
      requires_confirmation: false
    };
  }

  if (/(send an? email|email .* and tell|reply to .* and say|send .*email)/i.test(normalized)) {
    return {
      tool_name: 'send_email',
      tool_args: {},
      reply: 'I can send that, but I still need the recipient, subject, and body in a form I can use reliably.',
      missing_fields: ['to', 'subject', 'body'],
      requires_confirmation: true
    };
  }

  if (/(schedule|book|set up).*(meeting|appointment|call)/i.test(normalized)) {
    return {
      tool_name: 'create_calendar_event',
      tool_args: {},
      reply: 'I can put that on the calendar. I need the title and start time at minimum.',
      missing_fields: ['title', 'start'],
      requires_confirmation: true
    };
  }

  return {
    tool_name: 'store_note',
    tool_args: {},
    reply: null,
    missing_fields: [],
    requires_confirmation: false
  };
}

function extractSubject(message) {
  return cleanText(
    String(message || '')
      .replace(/^(what do we know about|tell me about|who owns|lookup|look up|search|find notes on|search the brain for|notes on|run match(?:es)? for|buyers for|who fits|who should buy)\s+/i, '')
      .replace(/[?.!]+$/g, ''),
    String(message || '')
  );
}

async function planMessage(message, session) {
  try {
    const raw = await dependencies.complete(buildPlannerPrompt(message, session), {
      maxTokens: 700
    });
    const parsed = extractJsonObject(raw);

    if (parsed?.tool_name) {
      return {
        tool_name: cleanText(parsed.tool_name, 'answer_only'),
        tool_args: parsed.tool_args && typeof parsed.tool_args === 'object' ? parsed.tool_args : {},
        reply: cleanText(parsed.reply, null),
        missing_fields: Array.isArray(parsed.missing_fields) ? parsed.missing_fields : [],
        requires_confirmation: Boolean(parsed.requires_confirmation)
      };
    }
  } catch (_error) {
    // Fall back to deterministic routing if the planner model is unavailable.
  }

  return buildDefaultPlannerResult(message);
}

function isConfirmation(message) {
  return YES_PATTERN.test(String(message || '').trim());
}

function isCancellation(message) {
  return NO_PATTERN.test(String(message || '').trim());
}

function validatePlannedAction(plan, originalMessage) {
  const args = plan.tool_args || {};

  switch (plan.tool_name) {
    case 'search_brain':
      if (!cleanText(args.query, null)) {
        return { ...plan, reply: 'Tell me what you want me to search for.', missing_fields: ['query'] };
      }
      return plan;
    case 'lookup_brain':
    case 'run_match':
      if (!cleanText(args.identifier, null)) {
        return { ...plan, tool_args: { identifier: extractSubject(originalMessage) } };
      }
      return plan;
    case 'send_email':
    case 'draft_email': {
      const missing = ['to', 'subject', 'body'].filter((field) => !cleanText(args[field], null));
      return missing.length > 0
        ? {
            ...plan,
            reply:
              plan.reply ||
              `I can ${plan.tool_name === 'send_email' ? 'send' : 'draft'} that email, but I still need ${missing.join(', ')}.`,
            missing_fields: missing
          }
        : plan;
    }
    case 'create_calendar_event': {
      const missing = ['title', 'start'].filter((field) => !cleanText(args[field], null));
      return missing.length > 0
        ? {
            ...plan,
            reply: plan.reply || `I can schedule that, but I still need ${missing.join(', ')}.`,
            missing_fields: missing
          }
        : plan;
    }
    default:
      return plan;
  }
}

async function executeTool(plan, request) {
  switch (plan.tool_name) {
    case 'answer_only':
      return {
        reply:
          plan.reply ||
          'I can help with notes, search, lookup, matches, email, calendar, syncs, and the daily brief. Tell me what you want me to do.',
        tool_name: plan.tool_name,
        result: null
      };
    case 'store_note': {
      const classified = await dependencies.classifyMessage(request.message);
      const result = await dependencies.routeClassifiedMessage(classified, request.message, {
        source: cleanText(request.source, 'telegram')
      });

      return {
        tool_name: plan.tool_name,
        result,
        reply: formatStoredNote(result)
      };
    }
    case 'search_brain': {
      const result = await dependencies.hybridSearch(plan.tool_args.query, {
        limit: Number(plan.tool_args.limit) || 5
      });
      return {
        tool_name: plan.tool_name,
        result,
        reply: formatSearchResults(plan.tool_args.query, result)
      };
    }
    case 'lookup_brain': {
      const result = await dependencies.lookupEntityOrProperty(plan.tool_args.identifier);
      return {
        tool_name: plan.tool_name,
        result,
        reply: formatLookup(plan.tool_args.identifier, result)
      };
    }
    case 'run_match': {
      const target = await dependencies.lookupIdentifier(plan.tool_args.identifier);

      if (!target) {
        return {
          tool_name: plan.tool_name,
          result: null,
          reply: `I couldn't find a buyer or property for "${plan.tool_args.identifier}".`
        };
      }

      const matches =
        target.kind === 'buyer'
          ? await dependencies.runMatchingForBuyer(target.entity_id, {
              dryRun: false,
              minScore: plan.tool_args.minScore
            })
          : await dependencies.runMatchingForProperty(target.property_id, {
              dryRun: false,
              minScore: plan.tool_args.minScore
            });

      return {
        tool_name: plan.tool_name,
        result: { target, matches },
        reply: formatMatches(plan.tool_args.identifier, target, matches)
      };
    }
    case 'daily_overview': {
      const [daily, agendaResult] = await Promise.allSettled([
        dependencies.getDailyOverview(),
        dependencies.getTodaysAgenda()
      ]);
      const result = {
        daily: daily.status === 'fulfilled' ? daily.value : { action_items: [], distressed_sellers: [] },
        agenda: agendaResult.status === 'fulfilled' ? agendaResult.value : [],
        agenda_error: agendaResult.status === 'rejected' ? agendaResult.reason?.message || 'Agenda unavailable' : null
      };

      return {
        tool_name: plan.tool_name,
        result,
        reply: formatDailyOverview(result)
      };
    }
    case 'draft_email': {
      const draftId = await dependencies.draftEmail(
        plan.tool_args.to,
        plan.tool_args.subject,
        plan.tool_args.body
      );
      return {
        tool_name: plan.tool_name,
        result: { draft_id: draftId },
        reply: `Drafted the email to ${plan.tool_args.to} with subject "${plan.tool_args.subject}". Draft ID: ${draftId}.`
      };
    }
    case 'send_email': {
      const result = await dependencies.sendEmail(
        plan.tool_args.to,
        plan.tool_args.subject,
        plan.tool_args.body,
        plan.tool_args.fromAlias
      );
      return {
        tool_name: plan.tool_name,
        result,
        reply:
          result.delivery === 'sent'
            ? `Sent the email to ${plan.tool_args.to}. Message ID: ${result.message_id}.`
            : `Gmail is still in draft mode, so I created a draft for ${plan.tool_args.to}. Draft ID: ${result.draft_id}.`
      };
    }
    case 'create_calendar_event': {
      const result = await dependencies.createEvent(plan.tool_args);
      return {
        tool_name: plan.tool_name,
        result,
        reply: `Created "${plan.tool_args.title}" on the calendar. Event ID: ${result.event_id}.`
      };
    }
    case 'run_property_sync': {
      const imported = await dependencies.syncNewProperties();
      const decisions = await dependencies.syncReviewDecisions();
      const matching = await dependencies.triggerMatchingForNewProperties();
      const result = { imported, decisions, matching };

      return {
        tool_name: plan.tool_name,
        result,
        reply: formatPropertySync(result)
      };
    }
    case 'run_monday_sync': {
      const pull = await dependencies.pullDealUpdates();
      const push = await dependencies.pushDailyActions();
      const result = { pull, push };

      return {
        tool_name: plan.tool_name,
        result,
        reply: formatMondaySync(result)
      };
    }
    case 'generate_daily_brief_pdf': {
      const result = await dependencies.generateDailyBrief();
      return {
        tool_name: plan.tool_name,
        result,
        reply: `Generated the daily brief PDF${result?.drive_url ? ` and uploaded it to Drive: ${result.drive_url}` : '.'}`
      };
    }
    default:
      return {
        tool_name: 'answer_only',
        result: null,
        reply: 'I understood the message, but I do not have a tool wired for that action yet.'
      };
  }
}

function formatStoredNote(result) {
  const parts = [result.summary || 'Saved that to the brain.'];

  if (result.created?.length) {
    parts.push(`Created: ${result.created.slice(0, 3).join('; ')}`);
  }

  if (result.updated?.length) {
    parts.push(`Updated: ${result.updated.slice(0, 3).join('; ')}`);
  }

  if (result.action_items?.length) {
    parts.push(`Action items: ${result.action_items.slice(0, 3).join('; ')}`);
  }

  return parts.join('\n');
}

function formatSearchResults(query, results) {
  if (!Array.isArray(results) || results.length === 0) {
    return `I didn't find anything relevant for "${query}".`;
  }

  return [
    `Top brain results for "${query}":`,
    ...results.slice(0, 5).map((item, index) => {
      const title =
        cleanText(item.knowledge_entry?.title, null) ||
        cleanText(item.knowledge_entry?.id, 'Untitled entry');
      const summary =
        cleanText(item.knowledge_entry?.content, null) ||
        cleanText(item.knowledge_entry?.ai_summary, null) ||
        '';

      return `${index + 1}. ${title} — ${limitText(summary, 120)}`;
    })
  ].join('\n');
}

function formatLookup(identifier, result) {
  if (!result) {
    return `I couldn't find anything for "${identifier}".`;
  }

  if (result.kind === 'entity') {
    return [
      `${result.entity.name} (${result.entity.type})`,
      result.properties?.length ? `Properties: ${result.properties.slice(0, 3).map((item) => item.address || item.apn).join('; ')}` : 'Properties: none linked yet',
      result.knowledge_entries?.length ? `Recent notes: ${result.knowledge_entries.slice(0, 3).map((item) => item.ai_summary || item.title).join('; ')}` : 'Recent notes: none yet'
    ].join('\n');
  }

  return [
    `${result.property.address || result.property.apn}`,
    result.linked_entities?.length ? `Linked entities: ${result.linked_entities.map((item) => item.name).join('; ')}` : 'Linked entities: none',
    result.seller_profile ? `Seller profile: distress ${result.seller_profile.distress_level || 'n/a'}, motivation ${result.seller_profile.motivation || 'n/a'}` : 'Seller profile: none yet'
  ].join('\n');
}

function formatMatches(identifier, target, matches) {
  if (!Array.isArray(matches) || matches.length === 0) {
    return `I ran matching for "${identifier}" but didn't find any current matches.`;
  }

  return [
    `Top matches for "${identifier}" (${target.kind}):`,
    ...matches.slice(0, 5).map((match, index) => {
      const counterpart =
        cleanText(match.buyer_name, null) ||
        cleanText(match.entity_name, null) ||
        cleanText(match.address, null) ||
        cleanText(match.property_address, null) ||
        'Unknown counterpart';
      return `${index + 1}. ${counterpart} — score ${match.score}`;
    })
  ].join('\n');
}

function formatDailyOverview(result) {
  const agenda = Array.isArray(result.agenda) ? result.agenda : [];
  const actions = Array.isArray(result.daily?.action_items) ? result.daily.action_items : [];
  const sellers = Array.isArray(result.daily?.distressed_sellers) ? result.daily.distressed_sellers : [];
  const lines = [];

  lines.push("Today's agenda:");
  if (agenda.length > 0) {
    lines.push(...agenda.slice(0, 5).map((item) => `- ${item.title || '(untitled)'} at ${item.start || 'unknown time'}`));
  } else {
    lines.push('- No calendar events found.');
  }

  if (actions.length > 0) {
    lines.push('');
    lines.push('Top action items:');
    lines.push(...actions.slice(0, 5).map((item) => `- ${typeof item.action === 'string' ? item.action : item.action?.title || JSON.stringify(item.action)}`));
  }

  if (sellers.length > 0) {
    lines.push('');
    lines.push('Highest distress sellers:');
    lines.push(...sellers.slice(0, 3).map((item) => `- ${item.entity_name} at ${item.address} (distress ${item.distress_level || 'n/a'})`));
  }

  if (result.agenda_error) {
    lines.push('');
    lines.push(`Calendar note: ${result.agenda_error}`);
  }

  return lines.join('\n');
}

function formatPropertySync(result) {
  const importedCount =
    Number(result.imported?.inserted || 0) + Number(result.imported?.updated || 0) || Number(result.imported?.processed || 0);
  const reviewedCount =
    Number(result.decisions?.activated || 0) + Number(result.decisions?.deactivated || 0) || Number(result.decisions?.processed || 0);
  const matchedCount = Number(result.matching?.processed || result.matching?.matched || 0);

  return `Property sync finished. Imported/updated: ${importedCount}. Review changes: ${reviewedCount}. Matching runs: ${matchedCount}.`;
}

function formatMondaySync(result) {
  const pulled = Number(result.pull?.updated || result.pull?.processed || 0);
  const pushed = Number(result.push?.posted || result.push?.processed || 0);
  return `Monday sync finished. Deal updates pulled: ${pulled}. Action updates pushed: ${pushed}.`;
}

function summarizePendingAction(plan) {
  switch (plan.tool_name) {
    case 'send_email':
      return `Ready to send an email to ${plan.tool_args.to} with subject "${plan.tool_args.subject}". Reply yes to send or no to cancel.`;
    case 'create_calendar_event':
      return `Ready to create "${plan.tool_args.title}" on the calendar at ${plan.tool_args.start}. Reply yes to confirm or no to cancel.`;
    default:
      return `Ready to run ${plan.tool_name}. Reply yes to continue or no to cancel.`;
  }
}

async function handleAssistantMessage(request = {}) {
  const message = cleanText(request.message, null);

  if (!message) {
    throw new Error('message is required');
  }

  let session = dependencies.sessionStore.getSession(request);
  session = dependencies.sessionStore.appendMessage(session, 'user', message);

  if (session.pending_action) {
    if (isConfirmation(message)) {
      const pending = session.pending_action;
      session.pending_action = null;
      dependencies.sessionStore.saveSession(session);
      const executed = await executeTool(pending, request);
      session = dependencies.sessionStore.appendMessage(session, 'assistant', executed.reply, {
        tool_name: executed.tool_name
      });
      return {
        session_id: session.session_id,
        reply: executed.reply,
        tool_name: executed.tool_name,
        result: executed.result,
        confirmed: true,
        pending_action: null
      };
    }

    if (isCancellation(message)) {
      session.pending_action = null;
      dependencies.sessionStore.saveSession(session);
      const reply = 'Canceled that pending action.';
      session = dependencies.sessionStore.appendMessage(session, 'assistant', reply);
      return {
        session_id: session.session_id,
        reply,
        tool_name: 'answer_only',
        result: null,
        confirmed: false,
        pending_action: null
      };
    }
  }

  let plan = await planMessage(message, session);
  plan = validatePlannedAction(plan, message);

  if (plan.missing_fields?.length > 0) {
    const reply =
      plan.reply ||
      `I need ${plan.missing_fields.join(', ')} before I can do that.`;
    session = dependencies.sessionStore.appendMessage(session, 'assistant', reply, {
      tool_name: plan.tool_name,
      missing_fields: plan.missing_fields
    });
    return {
      session_id: session.session_id,
      reply,
      tool_name: plan.tool_name,
      result: null,
      pending_action: null,
      missing_fields: plan.missing_fields
    };
  }

  const autoExecute = Boolean(request.auto_execute);
  const requiresConfirmation = Boolean(plan.requires_confirmation) || (SIDE_EFFECT_TOOLS.has(plan.tool_name) && autoExecute !== true);

  if (requiresConfirmation && SIDE_EFFECT_TOOLS.has(plan.tool_name) && autoExecute !== true) {
    session.pending_action = {
      tool_name: plan.tool_name,
      tool_args: plan.tool_args,
      created_at: new Date().toISOString()
    };
    dependencies.sessionStore.saveSession(session);
    const reply = summarizePendingAction(plan);
    session = dependencies.sessionStore.appendMessage(session, 'assistant', reply, {
      tool_name: plan.tool_name,
      pending: true
    });
    return {
      session_id: session.session_id,
      reply,
      tool_name: plan.tool_name,
      result: null,
      pending_action: session.pending_action,
      requires_confirmation: true
    };
  }

  const executed = await executeTool(plan, request);
  session = dependencies.sessionStore.appendMessage(session, 'assistant', executed.reply, {
    tool_name: executed.tool_name
  });

  return {
    session_id: session.session_id,
    reply: executed.reply,
    tool_name: executed.tool_name,
    result: executed.result,
    pending_action: null,
    requires_confirmation: false
  };
}

function __setDependencies(overrides = {}) {
  dependencies = {
    ...dependencies,
    ...overrides
  };
}

function __resetDependencies() {
  dependencies = { ...defaultDependencies, sessionStore: createInMemorySessionStore() };
}

module.exports = {
  handleAssistantMessage,
  __setDependencies,
  __resetDependencies
};
