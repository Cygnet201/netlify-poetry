const SHEET_CSV_URL =
  'https://docs.google.com/spreadsheets/d/1jCj3eUp7a5jlgEdPjHaLtaWhfPRFRPi03438_Pg8EHw/gviz/tq?tqx=out:csv';

// Simple CSV line parser (handles quoted fields)
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// Cache: { data, timestamp }
let cache = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchRatings() {
  if (cache && Date.now() - cache.timestamp < CACHE_TTL) {
    return cache.data;
  }

  const res = await fetch(SHEET_CSV_URL);
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);

  const text = await res.text();
  const lines = text.split('\n').filter((l) => l.trim());

  // Skip header row, aggregate by poem
  const agg = {};
  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    // columns: 0=timestamp, 1=poem, 2=rating
    const poem = (fields[1] || '').trim();
    const rating = parseInt(fields[2], 10);
    if (!poem || isNaN(rating)) continue;

    if (!agg[poem]) agg[poem] = { total: 0, count: 0 };
    agg[poem].total += rating;
    agg[poem].count += 1;
  }

  // Build result: { poem: { count, avg } }
  const result = {};
  for (const [poem, data] of Object.entries(agg)) {
    result[poem] = {
      count: data.count,
      avg: Math.round((data.total / data.count) * 10) / 10,
    };
  }

  cache = { data: result, timestamp: Date.now() };
  return result;
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    const ratings = await fetchRatings();

    // If ?poem=xxx is provided, return only that poem
    const poem = (event.queryStringParameters || {}).poem;
    if (poem) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(ratings[poem] || { count: 0, avg: 0 }),
      };
    }

    return { statusCode: 200, headers, body: JSON.stringify(ratings) };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
