/** Provider text is untrusted and may contain request data. Only return a fixed notice. */
export class AssistantModelUnavailable extends Error {
  constructor() { super('This model is not available for your connected account. Choose another model, then send your message again. No automatic retry was made.'); }
}

export function isModelUnavailable(message: string) {
  return /\bmodel\b/i.test(message) && /not supported|not available|does not exist|model_not_found/i.test(message);
}
