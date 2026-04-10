const {
  buildLabelValuePairs,
  cleanText,
  dateStamp,
  formatAddress,
  formatCurrency,
  formatDate,
  formatNumber,
  formatPercent,
  slugifySegment,
  truncateText,
  uniqueStrings
} = require('./pdf-helpers');

function formatPerSquareFoot(total, squareFeet) {
  const price = Number(total);
  const area = Number(squareFeet);

  if (!Number.isFinite(price) || !Number.isFinite(area) || area <= 0) {
    return 'Not captured yet';
  }

  return `${formatCurrency(price / area)}/SF`;
}

function buildProposalTemplate(data, context = {}) {
  const property = data.property || {};
  const sellerProfile = data.sellerProfile || {};
  const generatedAt = context.generatedAt || new Date();
  const proposalSummary = uniqueStrings([
    sellerProfile?.situation_summary,
    sellerProfile?.notes,
    data.knowledgeHighlights?.[0]?.summary,
    property.foreclosure ? 'Foreclosure status is active, which raises urgency for broker follow-up.' : null
  ]).slice(0, 3);
  const imageItems = Array.isArray(data.images) && data.images.length > 0
    ? data.images.slice(0, 2).map((image, index) => ({
        title: image.label || `Property asset ${index + 1}`,
        caption: image.caption || image.label || 'Property image',
        image: image.buffer || null
      }))
    : [{
        title: 'Property visuals pending',
        caption: 'Attach photos or plans in property documents to enhance this section.',
        image: null
      }];

  const sitePlanFacts = buildLabelValuePairs([
    { label: 'APN', value: property.apn || 'Unknown' },
    { label: 'Address', value: formatAddress(property) },
    { label: 'Property Type', value: property.property_type || 'Unknown' },
    { label: 'Building Size', value: formatNumber(property.sq_feet, 'Not captured yet') },
    { label: 'Lot Size', value: formatNumber(property.lot_size, 'Not captured yet') },
    { label: 'Units', value: formatNumber(property.units, 'Not captured yet') }
  ]);

  const demographicsFacts = buildLabelValuePairs([
    { label: 'City', value: property.city || 'Unknown' },
    { label: 'Region', value: property.region || 'Unknown' },
    { label: 'Comparable Inventory', value: formatNumber(data.marketSnapshot?.sameTypeInventory, '0') },
    { label: 'Nearby Foreclosures', value: formatNumber(data.marketSnapshot?.nearbyForeclosures, '0') },
    { label: 'Avg Assessed Value', value: formatCurrency(data.marketSnapshot?.averageAssessedValue) },
    { label: 'Trustee', value: cleanText(property.trustee_name, 'Not captured yet') }
  ]);

  const incomeExpenseFacts = buildLabelValuePairs([
    { label: 'Asking Price', value: formatCurrency(sellerProfile.asking_price) },
    { label: 'Minimum Acceptable', value: formatCurrency(sellerProfile.minimum_acceptable) },
    { label: 'Outstanding Debt', value: formatCurrency(sellerProfile.outstanding_debt) },
    { label: 'Estimated Equity', value: formatCurrency(sellerProfile.estimated_equity) },
    { label: 'Assessed / SF', value: formatPerSquareFoot(property.assessed_value, property.sq_feet) },
    { label: 'Ask / SF', value: formatPerSquareFoot(sellerProfile.asking_price, property.sq_feet) }
  ]);

  const valuationRows = [
    {
      label: 'County assessed value',
      value: formatCurrency(property.assessed_value),
      note: formatPerSquareFoot(property.assessed_value, property.sq_feet)
    },
    {
      label: 'Seller asking price',
      value: formatCurrency(sellerProfile.asking_price),
      note: formatPerSquareFoot(sellerProfile.asking_price, property.sq_feet)
    },
    {
      label: 'Seller minimum acceptable',
      value: formatCurrency(sellerProfile.minimum_acceptable),
      note: formatPerSquareFoot(sellerProfile.minimum_acceptable, property.sq_feet)
    },
    {
      label: 'Estimated equity',
      value: formatCurrency(sellerProfile.estimated_equity),
      note: sellerProfile.timeline || 'Timeline not captured'
    }
  ];

  const rentSurveyRows = Array.isArray(data.rentSignals) && data.rentSignals.length > 0
    ? data.rentSignals.slice(0, 5).map((signal) => ({
        source: signal.entity_name,
        strategy: signal.investment_strategy || 'Active buyer',
        pricing: formatCurrency(signal.max_price),
        note: truncateText(signal.notes || signal.sensibilities || 'Buyer demand signal captured from profile.', 90)
      }))
    : [{
        source: 'No rent survey data yet',
        strategy: 'Pipeline gap',
        pricing: 'n/a',
        note: 'The system does not yet have lease comp or rent-roll data for this property type.'
      }];

  const salesCompRows = Array.isArray(data.salesComps) && data.salesComps.length > 0
    ? data.salesComps.slice(0, 5).map((comp) => ({
        property: formatAddress(comp.property || comp),
        close: formatDate(comp.purchase_date || comp.created_at),
        price: formatCurrency(comp.purchase_price || comp.assessed_value),
        type: comp.property?.property_type || comp.property_type || 'Unknown'
      }))
    : [{
        property: 'No sales comps linked yet',
        close: 'n/a',
        price: 'n/a',
        type: 'n/a'
      }];

  const marketingPlan = Array.isArray(data.marketingPlan) && data.marketingPlan.length > 0
    ? data.marketingPlan
    : [
        'Launch targeted outreach to active buyers already hunting this asset type in the same market.',
        'Use a direct broker narrative that leads with urgency, pricing guardrails, and clean execution.',
        'Package title, foreclosure, and portfolio context into a concise buyer-ready brief before blast.',
        'Follow up with top-scoring matches first and widen distribution only if broker feedback supports it.'
      ];

  return {
    title: `${formatAddress(property)} Proposal`,
    eyebrow: 'Lee Associates | Listing Proposal',
    subtitle: `Prepared ${formatDate(generatedAt)} for ${formatAddress(property)}`,
    fileName: `${slugifySegment(property.apn || property.address || property.id)}_${dateStamp(generatedAt)}_proposal.pdf`,
    metrics: [
      { label: 'Assessed Value', value: formatCurrency(property.assessed_value) },
      { label: 'Ask Target', value: formatCurrency(sellerProfile.asking_price) },
      { label: 'Estimated Equity', value: formatCurrency(sellerProfile.estimated_equity) }
    ],
    sections: [
      {
        title: 'Executive Summary',
        type: 'bullets',
        items: proposalSummary.length > 0
          ? proposalSummary
          : [
              'This property is positioned for a concise broker narrative anchored in speed, certainty, and market context.',
              'The data set is strongest around property fundamentals, seller posture, and buyer demand signals already in the brain.'
            ]
      },
      {
        title: 'Property Pictures',
        type: 'imageGallery',
        items: imageItems
      },
      {
        title: 'Site Plan',
        type: 'facts',
        items: sitePlanFacts,
        pageBreakBefore: true
      },
      {
        title: 'Demographics',
        type: 'facts',
        items: demographicsFacts
      },
      {
        title: 'Income / Expenses',
        type: 'facts',
        items: incomeExpenseFacts
      },
      {
        title: 'Valuation',
        type: 'table',
        columns: [
          { key: 'label', label: 'Metric', width: 0.36 },
          { key: 'value', label: 'Value', width: 0.24 },
          { key: 'note', label: 'Note', width: 0.34 }
        ],
        rows: valuationRows,
        pageBreakBefore: true
      },
      {
        title: 'Rent Survey',
        type: 'table',
        columns: [
          { key: 'source', label: 'Signal', width: 0.22 },
          { key: 'strategy', label: 'Strategy', width: 0.2 },
          { key: 'pricing', label: 'Price', width: 0.18 },
          { key: 'note', label: 'Notes', width: 0.34 }
        ],
        rows: rentSurveyRows
      },
      {
        title: 'Sales Comps',
        type: 'table',
        columns: [
          { key: 'property', label: 'Property', width: 0.4 },
          { key: 'close', label: 'Close', width: 0.18 },
          { key: 'price', label: 'Price', width: 0.2 },
          { key: 'type', label: 'Type', width: 0.16 }
        ],
        rows: salesCompRows
      },
      {
        title: 'Marketing Plan',
        type: 'bullets',
        items: marketingPlan
      }
    ],
    footerNote: 'Proposal sections combine property facts, seller posture, internal comps, and buyer demand signals.'
  };
}

module.exports = {
  buildProposalTemplate
};
