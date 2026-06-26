const https = require('https');
const http = require('http');

// ── Fetch a URL ────────────────────────────────────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Cache-Control': 'no-cache',
      }
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

// ── Strip HTML tags ────────────────────────────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 8000); // Limit to avoid token overflow
}

// ── Call Anthropic API ─────────────────────────────────────────────────────
function callAnthropic(apiKey, prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          reject(new Error('Failed to parse Anthropic response'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Anthropic request timed out')); });
    req.write(body);
    req.end();
  });
}

// ── Main handler ───────────────────────────────────────────────────────────
exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  let listingUrl;
  try {
    const body = JSON.parse(event.body);
    listingUrl = body.url;
  } catch (e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!listingUrl) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'No URL provided' }) };
  }

  // ── Step 1: Fetch the listing page ───────────────────────────────────────
  let pageContent;
  try {
    const result = await fetchUrl(listingUrl);
    if (result.status !== 200) {
      return { statusCode: 422, headers, body: JSON.stringify({ error: `Listing page returned ${result.status}` }) };
    }
    pageContent = stripHtml(result.body);
  } catch (e) {
    return { statusCode: 422, headers, body: JSON.stringify({ error: `Could not fetch listing: ${e.message}` }) };
  }

  // ── Step 2: Send to Anthropic for extraction + description ───────────────
  const prompt = `You are a property data extractor for a UK rental property tracker.

Extract data from this property listing page content and return ONLY a valid JSON object with no markdown, no code fences, no explanation.

Listing URL: ${listingUrl}
Page content: ${pageContent}

Return exactly this JSON structure:
{
  "address": "full address with postcode if available",
  "price": 0,
  "beds": "2",
  "baths": "1",
  "type": "house|flat|maisonette|other",
  "parking": "yes|no|unknown",
  "outdoor": "garden|courtyard|none|unknown",
  "townwalk": "under10|10to20|over20|unknown",
  "stationwalk": "under10|10to20|over20|unknown",
  "photos_url": "",
  "floorplan_url": "",
  "description": "2-3 sentence natural description of the property highlighting key features, location benefits, and any standout qualities. Write as if summarising for a busy house hunter.",
  "score": 0,
  "available_from": ""
}

Rules:
- price: monthly rent as integer (no symbols)
- beds/baths: integer as string
- type: must be house, flat, maisonette, or other
- parking: yes if any parking mentioned, no if explicitly none, unknown if unclear
- outdoor: garden if garden mentioned, courtyard if balcony/courtyard, none if explicitly no outdoor space, unknown if unclear
- townwalk/stationwalk: estimate based on location description. St Albans town centre and City station are key references. under10 = under 10 min walk, 10to20 = 10-20 min, over20 = over 20 min
- photos_url: direct URL to photos if found, else empty string
- floorplan_url: direct URL to floorplan if found, else empty string
- description: 2-3 natural sentences, no bullet points, no estate agent clichés like "stunning" or "immaculate"
- score: calculate 0-100 based on these weighted criteria:
  * rent max £2000 hard cap - if over £2000 return score 0
  * no parking = instant score 0
  * rent £1700 or under = 25pts, £1800 = 20pts, £1900 = 14pts, £2000 = 8pts
  * 3-4 beds = 20pts, 2 beds = 12pts, 1 bed = 0pts
  * house = 12pts, flat = 8pts, maisonette = 5pts
  * 2+ baths = 10pts, 1 bath = 5pts
  * town centre under 10 min = 10pts, 10-20 min = 6pts, over 20 min = 2pts
  * garden = 10pts, courtyard = 6pts, none = 0pts
  * station under 10 min = 8pts, 10-20 min = 5pts, over 20 min = 2pts
  * max possible = 95pts, return as percentage of 95

Return ONLY the JSON object. No other text whatsoever.`;

  let extractedData;
  try {
    const anthropicResponse = await callAnthropic(apiKey, prompt);
    const responseText = anthropicResponse.content?.[0]?.text || '';

    // Strip any accidental markdown fences
    const cleaned = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    extractedData = JSON.parse(cleaned);
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: `AI extraction failed: ${e.message}` }) };
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      success: true,
      data: extractedData
    })
  };
};
