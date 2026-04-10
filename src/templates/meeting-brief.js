const {
  buildLabelValuePairs,
  cleanText,
  dateStamp,
  formatAddress,
  formatCurrency,
  formatDate,
  formatNumber,
  slugifySegment,
  truncateText,
  uniqueStrings
} = require('./pdf-helpers');

function buildMeetingBriefTemplate(data, context = {}) {
  const entity = data.entity || {};
  const generatedAt = context.generatedAt || new Date();
  const portfolioProperties = Array.isArray(data.portfolio?.properties) ? data.portfolio.properties.slice(0, 4) : [];
  const recentConversations = Array.isArray(data.recentConversations) ? data.recentConversations.slice(0, 3) : [];
  const activeOpportunities = Array.isArray(data.activeOpportunities) ? data.activeOpportunities.slice(0, 3) : [];
  const companies = Array.isArray(data.companies) ? data.companies.slice(0, 3) : [];
  const talkingPoints = Array.isArray(data.talkingPoints) ? data.talkingPoints.slice(0, 5) : [];
  const buyerProfile = data.buyerProfile || null;
  const sellerHighlight = Array.isArray(data.sellerProfiles) ? data.sellerProfiles[0] || null : null;

  const personFacts = buildLabelValuePairs([
    { label: 'Entity Type', value: entity.type || 'unknown' },
    { label: 'Source', value: entity.source || 'system' },
    { label: 'Phone', value: cleanText(entity.phone, 'Not captured yet') },
    { label: 'Email', value: cleanText(entity.email, 'Not captured yet') },
    { label: 'Buyer Intent', value: buyerProfile?.investment_strategy || buyerProfile?.urgency || 'Not captured yet' },
    { label: 'Seller Temperature', value: sellerHighlight?.motivation || sellerHighlight?.timeline || 'Not captured yet' }
  ]);

  const companyCards = companies.length > 0
    ? companies.map((company) => ({
        title: company.name,
        meta: [company.type, company.relationship].filter(Boolean).join(' | '),
        body: truncateText(company.notes || company.summary || 'Relationship discovered through entity graph.', 120)
      }))
    : [{
        title: 'No linked companies yet',
        meta: 'Entity graph',
        body: 'This entity does not yet have linked LLC or related-company records in the graph.'
      }];

  const portfolioRows = portfolioProperties.length > 0
    ? portfolioProperties.map((property) => ({
        property: formatAddress(property),
        type: property.property_type || 'unknown',
        value: formatCurrency(property.assessed_value),
        foreclosure: property.foreclosure ? 'Yes' : 'No'
      }))
    : [{
        property: 'No owned properties linked yet',
        type: 'n/a',
        value: 'n/a',
        foreclosure: 'n/a'
      }];

  const conversationCards = recentConversations.length > 0
    ? recentConversations.map((entry) => ({
        title: cleanText(entry.title, 'Knowledge entry'),
        meta: formatDate(entry.occurred_at || entry.created_at),
        body: truncateText(entry.summary || entry.content || 'No AI summary captured.', 160),
        footer: uniqueStrings(entry.action_items || []).slice(0, 2).join(' | ') || 'No action items extracted'
      }))
    : [{
        title: 'No recent conversations',
        meta: 'Knowledge base',
        body: 'There are no recent linked call notes, meeting notes, or emails for this entity.',
        footer: 'Talk track will improve as new notes are ingested.'
      }];

  const opportunityCards = activeOpportunities.length > 0
    ? activeOpportunities.map((item) => ({
        title: item.property_address || item.property_apn || 'Opportunity',
        meta: [item.kind, item.status].filter(Boolean).join(' | '),
        body: truncateText(item.summary || item.reasoning || 'No narrative captured yet.', 140),
        footer: item.counterparty_name || (item.score != null ? `Score ${Math.round(item.score)}` : 'Open')
      }))
    : [{
        title: 'No active opportunities',
        meta: 'Deals and matches',
        body: 'There are no open deals or high-priority matches linked to this entity right now.',
        footer: 'Use this meeting to uncover timing and portfolio changes.'
      }];

  const suggestionItems = talkingPoints.length > 0
    ? talkingPoints
    : [
        'Confirm whether priorities have changed since the last conversation.',
        'Ask what would make a new opportunity worth reviewing this week.',
        'Capture timeline, pricing guardrails, and any fresh portfolio movement.'
      ];

  return {
    title: `${entity.name || 'Entity'} Meeting Brief`,
    eyebrow: 'Lee Associates | ISG Second Brain',
    subtitle: `Prepared ${formatDate(generatedAt)} for ${entity.name || 'meeting prep'}`,
    fileName: `${slugifySegment(entity.name || entity.id || 'entity')}_${dateStamp(generatedAt)}_meeting-brief.pdf`,
    metrics: [
      {
        label: 'Portfolio',
        value: formatNumber(data.portfolio?.properties?.length || 0, '0 assets')
      },
      {
        label: 'Assessed Value',
        value: formatCurrency(data.portfolio?.total_assessed_value || 0, '$0')
      },
      {
        label: 'Open Opportunities',
        value: formatNumber(activeOpportunities.length, '0')
      }
    ],
    sections: [
      {
        title: 'Person',
        type: 'facts',
        items: personFacts
      },
      {
        title: 'Companies',
        type: 'cards',
        items: companyCards
      },
      {
        title: 'Portfolio',
        type: 'table',
        columns: [
          { key: 'property', label: 'Property', width: 0.46 },
          { key: 'type', label: 'Type', width: 0.16 },
          { key: 'value', label: 'Assessed', width: 0.2 },
          { key: 'foreclosure', label: 'FC', width: 0.12 }
        ],
        rows: portfolioRows
      },
      {
        title: 'Recent Conversations',
        type: 'cards',
        items: conversationCards
      },
      {
        title: 'Active Deals',
        type: 'cards',
        items: opportunityCards
      },
      {
        title: 'Suggested Talking Points',
        type: 'bullets',
        items: suggestionItems
      }
    ],
    footerNote: 'Generated from entity, knowledge, portfolio, and match data.'
  };
}

module.exports = {
  buildMeetingBriefTemplate
};
