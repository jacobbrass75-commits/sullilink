function cleanText(value, fallback = null) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed === '' ? fallback : trimmed;
}

function formatCurrency(value, fallback = 'Not captured yet') {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0
  }).format(parsed);
}

function formatNumber(value, fallback = 'Not captured yet') {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 0
  }).format(parsed);
}

function formatPercent(value, fallback = 'Not captured yet') {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  const normalized = Math.abs(parsed) <= 1 ? parsed * 100 : parsed;
  return `${normalized.toFixed(1)}%`;
}

function formatDate(value, fallback = 'Unknown date') {
  if (!value) {
    return fallback;
  }

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return fallback;
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date);
}

function dateStamp(value) {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString().slice(0, 10);
  }

  return date.toISOString().slice(0, 10);
}

function truncateText(value, maxLength = 180) {
  const text = cleanText(value, '');

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function slugifySegment(value, fallback = 'document') {
  const text = cleanText(value, fallback) || fallback;

  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || fallback;
}

function formatAddress(property = {}) {
  const pieces = [
    cleanText(property.address, null),
    cleanText(property.city, null),
    cleanText(property.state, null),
    cleanText(property.zip, null)
  ].filter(Boolean);

  if (pieces.length > 0) {
    return pieces.join(', ');
  }

  return cleanText(property.apn, 'Unknown property');
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const output = [];

  for (const value of values) {
    const text = cleanText(value, null);

    if (!text) {
      continue;
    }

    const key = text.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(text);
  }

  return output;
}

function buildLabelValuePairs(pairs = []) {
  return pairs.filter((pair) => cleanText(pair?.label, null) && pair.value !== undefined);
}

module.exports = {
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
};
