'use strict';

/**
 * AI-powered document authenticity verification using Azure OpenAI (gpt-4o-mini).
 * Uses managed identity — no API key required.
 *
 * Returns:
 *   { genuine: true,  confidence: 'high'|'medium', passengerName: string|null, reason: string }
 *   { genuine: false, confidence: 'high'|'medium', passengerName: null,        reason: string }
 *   { genuine: null,  confidence: null,             passengerName: null,        reason: string }
 *     ↑ null = AI unavailable (local dev or endpoint not configured) — caller should not block payment
 */

const config = require('../config');

function isAvailable() {
  return Boolean(config.azureOpenAI.endpoint);
}

function buildPrompt(flightInfo) {
  return `You are a fraud detection assistant for a flight delay insurance platform.
Analyse the document provided by a customer to support a delay benefit claim.

${flightInfo}

Respond with a JSON object (no markdown) with these fields:
- genuine: true if this appears to be an authentic travel booking confirmation, e-ticket, or itinerary from a real travel company or airline; false if it appears fabricated, minimal, or suspicious
- confidence: "high" or "medium"
- passengerName: the full passenger name found in the document, or null if not found
- reason: one sentence explaining your assessment

A genuine document will typically have: a booking reference, passenger name, airline/travel company branding or name, origin/destination airports, and flight number. Be suspicious of documents with only a flight number and date and nothing else.`;
}

async function getClient() {
  const { AzureOpenAI }               = require('openai');
  const { ManagedIdentityCredential } = require('@azure/identity');
  const credential = new ManagedIdentityCredential({ clientId: config.azureOpenAI.clientId });
  return new AzureOpenAI({
    endpoint:   config.azureOpenAI.endpoint,
    deployment: config.azureOpenAI.deployment,
    apiVersion: '2024-10-21',
    azureADTokenProvider: async () => {
      const token = await credential.getToken('https://cognitiveservices.azure.com/.default');
      return token.token;
    },
  });
}

/**
 * Verify a document using AI.
 * parsed: output from documentParser.parseDocument()
 * registeredFlight: { flight_number, dep_date }
 */
async function verifyDocument(parsed, registeredFlight) {
  if (!isAvailable()) {
    return { genuine: null, confidence: null, passengerName: null, reason: 'AI verification not configured' };
  }

  try {
    const client = await getClient();

    const flightInfo = registeredFlight
      ? `Flight being claimed: ${registeredFlight.flight_number} on ${String(registeredFlight.dep_date).slice(0, 10)}`
      : 'No flight details provided';

    const prompt = buildPrompt(flightInfo);

    let messages;

    if (parsed.parseMethod === 'image') {
      // Vision path — base64Image is set in local dev; in blob mode it's read here
      let base64Image = parsed.base64Image;
      if (!base64Image && parsed.blobKey) {
        const blobStorage = require('./blobStorage');
        const buf = await blobStorage.downloadToBuffer(parsed.blobKey);
        base64Image = buf.toString('base64');
      }
      if (!base64Image) {
        return { genuine: null, confidence: null, passengerName: null, reason: 'Image data unavailable' };
      }
      messages = [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${parsed.imageMime};base64,${base64Image}`, detail: 'low' } },
        ],
      }];
    } else if (parsed.rawText) {
      // Text path — standard completion
      messages = [{
        role: 'user',
        content: `${prompt}\n\nExtracted document text:\n---\n${parsed.rawText.slice(0, 4000)}\n---`,
      }];
    } else {
      return { genuine: null, confidence: null, passengerName: null, reason: 'No content to verify' };
    }

    // Use gpt-4o for vision (images), gpt-4o-mini for text
    const model = (parsed.parseMethod === 'image') ? 'gpt4o-prd' : config.azureOpenAI.deployment;

    const response = await client.chat.completions.create({
      model,
      messages,
      temperature: 0,
      max_tokens:  256,
    });

    const raw = response.choices[0]?.message?.content?.trim() || '';

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('[documentVerifier] Could not parse AI response:', raw);
      return { genuine: null, confidence: null, passengerName: null, reason: 'AI response parse error' };
    }

    return {
      genuine:       Boolean(parsed.genuine),
      confidence:    parsed.confidence || 'medium',
      passengerName: parsed.passengerName || null,
      reason:        parsed.reason       || '',
    };

  } catch (err) {
    console.error('[documentVerifier] Azure OpenAI error:', err.message);
    return { genuine: null, confidence: null, passengerName: null, reason: `AI error: ${err.message}` };
  }
}

module.exports = { verifyDocument, isAvailable };
