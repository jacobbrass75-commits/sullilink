const {
  buildLabelValuePairs,
  dateStamp,
  formatCurrency,
  formatDate,
  formatNumber,
  slugifySegment,
  truncateText,
  uniqueStrings
} = require('./pdf-helpers');

function buildDailyBriefTemplate(data, context = {}) {
  const generatedAt = context.generatedAt || new Date();
  const actionItems = Array.isArray(data.actionItems) ? data.actionItems.slice(0, 6) : [];
  const distressedSellers = Array.isArray(data.distressedSellers) ? data.distressedSellers.slice(0, 4) : [];
  const topMatches = Array.isArray(data.topMatches) ? data.topMatches.slice(0, 4) : [];

  return {
    title: `Daily Brief - ${formatDate(generatedAt)}`,
    eyebrow: 'Lee Associates | Morning Brief',
    subtitle: `Prioritized actions generated ${formatDate(generatedAt)}`,
    fileName: `${slugifySegment(`daily-brief-${dateStamp(generatedAt)}`)}.pdf`,
    metrics: [
      { label: 'Action Items', value: formatNumber(actionItems.length, '0') },
      { label: 'Seller Alerts', value: formatNumber(distressedSellers.length, '0') },
      { label: 'Open Matches', value: formatNumber(topMatches.length, '0') }
    ],
    sections: [
      {
        title: 'Priority Actions',
        type: 'cards',
        items: actionItems.length > 0
          ? actionItems.map((item) => ({
              title: item.action,
              meta: formatDate(item.created_at),
              body: truncateText(item.summary || 'No summary captured.', 120),
              footer: item.knowledge_entry_id || 'knowledge'
            }))
          : [{
              title: 'No action items queued',
              meta: 'Knowledge base',
              body: 'No new AI action items were detected in the last ingest cycle.',
              footer: 'Review new call notes if this feels incomplete.'
            }]
      },
      {
        title: 'Seller Watchlist',
        type: 'table',
        columns: [
          { key: 'seller', label: 'Seller', width: 0.3 },
          { key: 'address', label: 'Property', width: 0.42 },
          { key: 'distress', label: 'Distress', width: 0.14 }
        ],
        rows: distressedSellers.length > 0
          ? distressedSellers.map((seller) => ({
              seller: seller.entity_name,
              address: seller.address,
              distress: seller.distress_level == null ? 'n/a' : String(seller.distress_level)
            }))
          : [{
              seller: 'No high-distress sellers',
              address: 'n/a',
              distress: 'n/a'
            }]
      },
      {
        title: 'Top Matches',
        type: 'cards',
        items: topMatches.length > 0
          ? topMatches.map((match) => ({
              title: match.property_address || 'Match',
              meta: [match.buyer_name, match.seller_name].filter(Boolean).join(' -> '),
              body: `Score ${Math.round(Number(match.score || 0))} | ${truncateText(match.reasoning || 'No narrative captured.', 120)}`,
              footer: match.status || 'suggested'
            }))
          : [{
              title: 'No matches surfaced',
              meta: 'Matching engine',
              body: 'No active matches are currently available for the morning brief.',
              footer: 'Run matching after new ingest if needed.'
            }]
      },
      {
        title: 'Morning Prompts',
        type: 'bullets',
        items: uniqueStrings([
          actionItems[0]?.action ? `Clear the top action first: ${actionItems[0].action}` : null,
          distressedSellers[0]?.entity_name ? `Check in on ${distressedSellers[0].entity_name} before the market gets noisier.` : null,
          topMatches[0]?.buyer_name ? `Decide whether ${topMatches[0].buyer_name} deserves first outreach today.` : null,
          'Use this brief as a triage sheet, then capture the day’s decisions back into the brain.'
        ])
      }
    ],
    footerNote: 'Daily brief combines current action items, seller urgency, and open match signals.'
  };
}

module.exports = {
  buildDailyBriefTemplate
};
