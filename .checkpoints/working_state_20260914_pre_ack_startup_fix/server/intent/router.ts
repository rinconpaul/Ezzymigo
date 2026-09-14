import { GoogleGenAI } from '@google/genai';
import { intentClassificationSchema } from '../ai/schemas';

export interface IntentRoutingResult {
  intent_class:
    | 'IMMEDIATE_CONTACT_ACTION'
    | 'CONTACT_INFORMATION_QUERY'
    | 'FUTURE_CONTACT_INTENTION'
    | 'CONTACT_FACT'
    | 'GENERAL_THOUGHT';
  action_type: 'call' | 'sms' | 'none';
  target_person: string | null;
  target_role: string | null;
  prefilled_message: string | null;
  has_temporal_anchor: boolean;
  temporal_expression: string | null;
  raw_input: string;
}

export async function routeUserIntent(
  rawInput: string,
  ai: GoogleGenAI
): Promise<IntentRoutingResult> {
  const trimmed = (rawInput || '').trim();
  if (!trimmed) {
    return {
      intent_class: 'GENERAL_THOUGHT',
      action_type: 'none',
      target_person: null,
      target_role: null,
      prefilled_message: null,
      has_temporal_anchor: false,
      temporal_expression: null,
      raw_input: trimmed,
    };
  }

  try {
    const prompt = `You are Ezzymigo's Multilingual Action and Intent Classifier.
Analyze the user's input and classify its semantic intent class across ANY language (English, Spanish, French, German, Italian, etc.).

INTENT CLASSES:
1. IMMEDIATE_CONTACT_ACTION:
   The user gives an imperative command to initiate communication RIGHT NOW with a person or role (call/phone/ring or text/sms/message).
   Crucially, there is NO future temporal anchor, NO delayed time, and NO reminder framing.
   Examples across languages:
   - English: "Ring Barb", "Call Barb", "Phone my electrician", "Text Barb", "Text Barb I'm running late", "Send a message to Barb"
   - Spanish: "Llama a Barb", "Llamar a Barb", "Llama a mi electricista", "Envíale un mensaje a Barb diciendo que llegaré tarde", "Escríbele a Barb"
   - French: "Appelle Barb", "Téléphone à mon électricien", "Envoie un SMS à Barb en disant que j'aurai du retard", "Écris à Barb"
   - German: "Ruf Barb an", "Ruf meinen Elektriker an", "Schreib Barb eine SMS dass ich später komme", "Schick Barb eine Nachricht"

2. FUTURE_CONTACT_INTENTION:
   The user expresses an intention to contact someone in the FUTURE, sets a reminder to contact someone, or includes ANY temporal delay or schedule (e.g. tomorrow, mañana, demain, morgen, at 5pm, tonight, ce soir, heute Abend, later, in 10 minutes, etc.).
   Examples across languages:
   - English: "Call Barb tomorrow", "Remind me to call Barb tomorrow", "Ring Mum tonight", "Text Barb at 5pm", "Don't let me forget to phone Mum"
   - Spanish: "Llama a Barb mañana", "Recuérdame llamar a Barb mañana", "Llamar a mamá esta noche", "Escribir a Barb a las 5", "No me dejes olvidar llamar a mamá"
   - French: "Appelle Barb demain", "Rappelle-moi d'appeler Barb demain", "Téléphoner à maman ce soir", "Envoyer un message à Barb à 17h", "N'oublie pas de m'appeler maman"
   - German: "Ruf Barb morgen an", "Erinnere mich daran Barb morgen anzurufen", "Mama heute Abend anrufen", "Schreib Barb um 17 Uhr", "Lass mich nicht vergessen Mama anzurufen"

3. CONTACT_INFORMATION_QUERY:
   The user is asking a question to find or retrieve a person's phone number, mobile, email, or contact details.
   Examples across languages:
   - English: "What is Barb's phone number?", "Do I have Barb's mobile?", "What's my electrician's number?"
   - Spanish: "¿Cuál es el número de Barb?", "¿Tienes el teléfono de Barb?", "¿Cuál es el número de mi electricista?"
   - French: "Quel est le numéro de Barb ?", "As-tu le portable de Barb ?", "Quel est le numéro de mon électricien ?"
   - German: "Wie ist die Telefonnummer von Barb?", "Habe ich Barbs Handynummer?", "Wie lautet die Nummer von meinem Elektriker?"

4. CONTACT_FACT:
   The user is providing knowledge about a person's role, relationship, or contact details to remember.
   Examples across languages:
   - English: "Barb is my sister", "Barb is my sister, her number is 0412 345 678"
   - Spanish: "Barb es mi hermana", "Barb es mi hermana, su número es 0412 345 678"
   - French: "Barb est ma sœur", "Barb est ma sœur, son numéro est le 0412 345 678"
   - German: "Barb ist meine Schwester", "Barb ist meine Schwester, ihre Nummer ist 0412 345 678"

5. GENERAL_THOUGHT:
   Any general thought, note, task, shopping item, observation, memory, or reflection that is not a direct communication command or contact inquiry.
   Examples across languages:
   - English: "Buy 9V batteries for smoke alarm", "Meeting went well"
   - Spanish: "Comprar pilas de 9V para la alarma de humo", "La reunión salió bien"
   - French: "Acheter des piles 9V pour le détecteur de fumée", "La réunion s'est bien passée"
   - German: "9V-Batterien für den Rauchmelder kaufen", "Das Meeting lief gut"

MANDATORY RULES:
1. PERSON NAMES: Preserve the exact person name without translation or alteration (e.g. "Barb" remains "Barb", "Test_Fred" remains "Test_Fred").
2. TEMPORAL RULE: If there is ANY future or scheduled time/date expression, or reminder framing (in ANY language), has_temporal_anchor MUST be true, and intent_class MUST NOT be IMMEDIATE_CONTACT_ACTION.
3. PREFILLED MESSAGE: For SMS/messages with content (e.g. "Text Barb I'm running late", "Envíale un mensaje a Barb diciendo que llegaré tarde", "Envoie un SMS à Barb en disant que j'aurai du retard", "Schreib Barb dass ich später komme"), extract ONLY the message body itself ("I'm running late", "llegaré tarde", "j'aurai du retard", "ich komme später").
4. TARGET ROLE: Normalize the role into English in lowercase (e.g. "electricista" -> "electrician", "électricien" -> "electrician", "elektriker" -> "electrician", "hermana" -> "sister").

User Input: "${trimmed}"`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-lite',
      contents: prompt,
      config: {
        systemInstruction:
          'You are Ezzymigo\'s Multilingual Action and Intent Router. Accurately classify communication commands, queries, future reminders, facts, and general thoughts across languages. Output strictly valid JSON matching the schema.',
        responseMimeType: 'application/json',
        responseSchema: intentClassificationSchema,
        temperature: 0.1,
      },
    });

    if (response.text) {
      const parsed = JSON.parse(response.text);
      let intentClass = parsed.intent_class as IntentRoutingResult['intent_class'];
      let actionType = (parsed.action_type || 'none') as IntentRoutingResult['action_type'];
      const targetPerson = parsed.target_person?.trim() || null;
      const targetRole = parsed.target_role?.trim() || null;
      let prefilledMessage = parsed.prefilled_message?.trim() || null;
      const hasTemporal = Boolean(parsed.has_temporal_anchor) || Boolean(parsed.temporal_expression?.trim());
      const temporalExpr = parsed.temporal_expression?.trim() || null;

      // Deterministic Safeguard 1: Structured temporal anchor strictly forbids IMMEDIATE_CONTACT_ACTION
      if (hasTemporal && intentClass === 'IMMEDIATE_CONTACT_ACTION') {
        intentClass = 'FUTURE_CONTACT_INTENTION';
        actionType = 'none';
      }

      // Deterministic Safeguard 2: Immediate action must have valid action_type
      if (intentClass === 'IMMEDIATE_CONTACT_ACTION') {
        if (actionType !== 'call' && actionType !== 'sms') {
          actionType = prefilledMessage ? 'sms' : 'call';
        }
      } else {
        // Non-immediate actions do not fire immediate device calls or SMS
        actionType = 'none';
      }

      // Deterministic Safeguard 3: Clean prefilled message carrier artifacts if any
      if (prefilledMessage) {
        prefilledMessage = prefilledMessage
          .replace(/^(?:saying\s+that|saying|that|diciendo\s+que|diciendo|disant\s+que|disant|dass)\s+/i, '')
          .trim();
      }

      return {
        intent_class: intentClass,
        action_type: actionType,
        target_person: targetPerson,
        target_role: targetRole,
        prefilled_message: prefilledMessage,
        has_temporal_anchor: hasTemporal,
        temporal_expression: temporalExpr,
        raw_input: trimmed,
      };
    }
  } catch (err: any) {
    console.error('[IntentRouter] Error in semantic classification:', err?.message || err);
  }

  // Safe Fallback if model fails: Treat as GENERAL_THOUGHT to safely defer to memory pipeline
  return {
    intent_class: 'GENERAL_THOUGHT',
    action_type: 'none',
    target_person: null,
    target_role: null,
    prefilled_message: null,
    has_temporal_anchor: false,
    temporal_expression: null,
    raw_input: trimmed,
  };
}
