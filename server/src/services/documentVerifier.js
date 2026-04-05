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

async function verifyDocument(extractedText, registeredFlight) {
  if (!isAvailable()) {
    return { genuine: null, confidence: null, passengerName: null, reason: 'AI verification not configured' };
  }

  try {
    const { AzureOpenAI } = require('@azure/openai');
    const { ManagedIdentityCredential } = require('@azure/identity');

    const credential = new ManagedIdentityCredential({ clientId: config.azureOpenAI.clientId });
    const client     = new AzureOpenAI({
      endpoint:    config.azureOpenAI.endpoint,
      deployment:  config.azureOpenAI.deployment,
      apiVersion:  '2024-10-21',
      azureADTokenProvider: async () => {
        const token = await credential.getToken('https://cognitiveservices.azure.com/.default');
        return token.token;
      },
    });

    const flightInfo = registeredFlight
      ? `Flight: ${registeredFlight.flight_number}, Date: ${String(registeredFlight.dep_date).slice(0, 10)}`
      : 'No flight details provided';

    const prompt = `You are a fraud detection assistant for a flight delay insurance platform.
Analyse the following text extracted from a document uploaded by a customer to support a claim.

${flightInfo}

Extracted document text:
---
${extractedText.slice(0, 4000)}
---

Respond with a JSON object (no markdown) with these fields:
- genuine: true if this appears to be an authentic travel booking confirmation, e-ticket, or itinerary from a real travel company or airline; false if it appears fabricated, minimal, or suspicious
- confidence: "high" or "medium"
- passengerName: the full passenger name found in the document, or null if not found
- reason: one sentence explaining your assessment

A genuine document will typically have: a booking reference, passenger name, airline/travel company branding or name, origin/destination airports, and flight number. Be suspicious of documents with only a flight number and date and nothing else.`;

    const response = await client.chat.completions.create({
      model:       config.azureOpenAI.deployment,
      messages:    [{ role: 'user', content: prompt }],
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
