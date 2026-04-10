const {
  buildLabelValuePairs,
  dateStamp,
  formatAddress,
  formatCurrency,
  formatDate,
  formatNumber,
  slugifySegment,
  uniqueStrings
} = require('./pdf-helpers');

function buildPropertyFlyerTemplate(data, context = {}) {
  const property = data.property || {};
  const sellerProfile = data.sellerProfile || {};
  const generatedAt = context.generatedAt || new Date();
  const opportunityBullets = uniqueStrings([
    property.foreclosure ? 'Foreclosure activity creates urgency and a clearer call to action.' : null,
    sellerProfile.timeline ? `Seller timeline: ${sellerProfile.timeline}.` : null,
    sellerProfile.motivation ? `Motivation signal: ${sellerProfile.motivation}.` : null,
    sellerProfile.lender_status ? `Lender posture: ${sellerProfile.lender_status}.` : null,
    data.matchHeadline || null
  ]);

  return {
    title: `${formatAddress(property)} Property Flyer`,
    eyebrow: 'Lee Associates | Property Flyer',
    subtitle: `Prepared ${formatDate(generatedAt)} for broker outreach`,
    fileName: `${slugifySegment(property.apn || property.address || property.id)}_${dateStamp(generatedAt)}_flyer.pdf`,
    heroImage: data.heroImage || null,
    metrics: [
      { label: 'Building', value: formatNumber(property.sq_feet, 'Not captured') },
      { label: 'Lot', value: formatNumber(property.lot_size, 'Not captured') },
      { label: 'Value', value: formatCurrency(property.assessed_value) }
    ],
    sections: [
      {
        title: 'Property Snapshot',
        type: 'facts',
        items: buildLabelValuePairs([
          { label: 'Address', value: formatAddress(property) },
          { label: 'APN', value: property.apn || 'Unknown' },
          { label: 'Property Type', value: property.property_type || 'Unknown' },
          { label: 'Units', value: formatNumber(property.units, 'Not captured') },
          { label: 'Foreclosure', value: property.foreclosure ? 'Yes' : 'No' },
          { label: 'Seller Ask', value: formatCurrency(sellerProfile.asking_price) }
        ])
      },
      {
        title: 'Opportunity',
        type: 'bullets',
        items: opportunityBullets.length > 0
          ? opportunityBullets
          : [
              'Use this flyer as a clean first-touch summary for buyers already aligned with the asset type.',
              'Add photos and site-plan documents in the property record to make the next version richer.'
            ]
      },
      {
        title: 'Broker Contact',
        type: 'facts',
        items: buildLabelValuePairs([
          { label: 'Broker', value: data.contact?.name || 'ISG Brokerage' },
          { label: 'Email', value: data.contact?.email || 'broker@lee-associates.com' },
          { label: 'Phone', value: data.contact?.phone || 'Available on request' },
          { label: 'Prepared', value: formatDate(generatedAt) }
        ])
      }
    ],
    footerNote: 'Flyer generated from property, seller, and match intelligence already stored in the brain.'
  };
}

module.exports = {
  buildPropertyFlyerTemplate
};
