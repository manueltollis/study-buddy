/**
 * Shared settings, provider metadata and prompt construction.
 * ES module - imported by the service worker and the extension's own pages.
 */

/**
 * Every provider here speaks the Anthropic Messages API, so switching one is a
 * base-URL swap. Prices are USD per million tokens, used for the cost readout.
 */
export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic',
    wire: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    keysUrl: 'https://platform.claude.com/settings/keys',
    keyHint: 'sk-ant-…',
    native: true,
    models: [
      { id: 'claude-opus-5', label: 'Opus 5', hint: 'most capable', price: [5, 25] },
      { id: 'claude-sonnet-5', label: 'Sonnet 5', hint: 'balanced', price: [2, 10] },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', hint: 'fast, cheap', price: [1, 5] }
    ]
  },
  zai: {
    label: 'Z.ai (GLM)',
    wire: 'anthropic',
    baseUrl: 'https://api.z.ai/api/anthropic',
    keysUrl: 'https://z.ai/manage-apikey/apikey-list',
    keyHint: 'your Z.ai API key',
    models: [
      { id: 'glm-5.3-flash', label: 'GLM-5.3-Flash', hint: 'cheapest by far', price: [0.075, 0.25] },
      { id: 'glm-5.3', label: 'GLM-5.3', hint: 'flagship', price: [1.4, 4.4] },
      { id: 'glm-5.3[1m]', label: 'GLM-5.3 (1M context)', hint: 'long documents', price: [1.4, 4.4] }
    ]
  },
  openrouter: {
    label: 'OpenRouter',
    // OpenRouter's Anthropic "skin" is documented as Anthropic-models-only, so
    // use its OpenAI-compatible wire, which every model on the gateway speaks.
    wire: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    keysUrl: 'https://openrouter.ai/keys',
    keyHint: 'sk-or-…',
    catalogUrl: 'https://openrouter.ai/api/v1/models',
    defaultModel: 'z-ai/glm-5.3-flash',
    models: []
  },
  custom: {
    label: 'Custom endpoint',
    wire: 'anthropic',
    baseUrl: '',
    keysUrl: '',
    keyHint: 'API key for that endpoint',
    models: []
  }
};

export const DEFAULT_SETTINGS = {
  provider: 'anthropic',
  keys: { anthropic: '', zai: '', openrouter: '', custom: '' },
  models: {
    anthropic: 'claude-opus-5',
    zai: 'glm-5.3-flash',
    openrouter: 'z-ai/glm-5.3-flash',
    custom: ''
  },
  /** modelId -> [inputPricePerMTok, outputPricePerMTok], filled from a provider catalog. */
  prices: {},
  customBaseUrl: '',
  customWire: 'anthropic',
  workspaceId: '',
  effort: 'medium',
  maxTokens: 4000,
  level: 'student',
  contextChars: 1500,
  showReasoning: false,
  autoHighlight: true,
  bubbleEnabled: true,
  useFallbacks: true,
  /** Open PDFs in the extension's own viewer, where text can be selected. */
  pdfViewer: true,
  /** File every answer in the study notes without waiting for "Save note". */
  autoSaveNotes: true,
  /** 'auto' follows the system; 'light' or 'dark' pins it. */
  theme: 'auto'
};

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

export const LEVELS = {
  simple: 'a curious 12-year-old - plain words, no jargon',
  student: 'an undergraduate student who is new to this specific topic',
  expert: 'a working professional who knows the field - be precise and technical'
};

/** Models that take `output_config.effort` and adaptive thinking. */
const MODERN = new Set(['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-opus-4-8']);
/** Models where a server-side refusal fallback is worth requesting. */
const FALLBACK_CAPABLE = new Set(['claude-opus-5', 'claude-fable-5']);

export const isAnthropic = (settings) => settings.provider === 'anthropic';
/** Which request/response shape this provider speaks. */
export const wireOf = (settings) =>
  settings.provider === 'custom' ? settings.customWire || 'anthropic' : providerOf(settings).wire;
export const activeKey = (settings) => (settings.keys || {})[settings.provider] || '';
export const activeModel = (settings) => (settings.models || {})[settings.provider] || '';
export const providerOf = (settings) => PROVIDERS[settings.provider] || PROVIDERS.anthropic;

export function activeBaseUrl(settings) {
  const base = settings.provider === 'custom' ? settings.customBaseUrl : providerOf(settings).baseUrl;
  return String(base || '').trim().replace(/\/+$/, '');
}

export const supportsEffort = (settings) => isAnthropic(settings) && MODERN.has(activeModel(settings));
export const supportsFallbacks = (settings) => isAnthropic(settings) && FALLBACK_CAPABLE.has(activeModel(settings));

export function modelsFor(providerId) {
  return (PROVIDERS[providerId] || PROVIDERS.anthropic).models;
}

export const ACTIONS = {
  explain: {
    label: 'Explain',
    instruction:
      'Explain what this passage means. Start with the single sentence that captures it, then unpack the parts that carry real weight.'
  },
  simplify: {
    label: 'Simpler',
    instruction:
      'Re-explain this in the simplest language that is still accurate. Short sentences. Use one everyday analogy if it genuinely helps, and say where the analogy breaks down.'
  },
  keypoints: {
    label: 'Key points',
    instruction:
      'Pull out the key points as a tight bulleted list. Bold the term each bullet is about. No preamble.'
  },
  example: {
    label: 'Example',
    instruction:
      'Give one concrete example that makes this click - a worked example with real numbers if the passage is quantitative, a specific scenario otherwise. Then say in one line what the example demonstrates.'
  },
  terms: {
    label: 'Define terms',
    instruction:
      'List the technical terms and jargon that appear in this passage, each with a one-line definition in context. Skip words a general reader already knows.'
  },
  quiz: {
    label: 'Quiz me',
    instruction:
      'Write 3 questions that test whether the reader actually understood this passage - at least one should require applying the idea, not just recalling it. Number them. Then a `---` line, then an "Answers" section with a short answer for each.'
  },
  pageSummary: {
    label: 'Summarize page',
    page: true,
    instruction:
      'Summarize this page for someone studying it: what it is about, then the main points in a short bulleted list, then anything the reader should be skeptical of or verify elsewhere.'
  },
  pageQuiz: {
    label: 'Quiz me on the page',
    page: true,
    instruction:
      'Write 5 questions covering the main ideas on this page, ordered from recall to application. Number them. Then a `---` line, then an "Answers" section.'
  }
};

export function systemPrompt(settings) {
  const audience = LEVELS[settings.level] || LEVELS.student;
  return [
    'You are a study companion built into the reader\'s web browser. The reader highlights a passage on a page they are reading and asks you about it.',
    '',
    `Pitch every explanation at this audience: ${audience}.`,
    '',
    'How to answer:',
    '- Answer the passage in front of you. Ground the explanation in its actual wording, not in the general topic.',
    '- Be brief. Aim for under 180 words unless the reader asks for depth. No preamble, no restating the question, no "great question".',
    '- Use markdown: short paragraphs, bullets where there is a list, **bold** for the terms that matter, code blocks for code or formulas.',
    '- Define jargon inline the first time you use it.',
    '- The surrounding page context is reference material for disambiguation. Do not summarize it unless asked.',
    '- If the passage is too ambiguous or truncated to explain confidently, say exactly what is missing instead of guessing.',
    '- Never invent facts, numbers, citations, or sources. If you are not sure, say so - a reader who is studying will take you at your word.',
    '- Follow-up questions in the thread are about the same passage unless the reader says otherwise.'
  ].join('\n');
}

function fence(text) {
  return `"""\n${text}\n"""`;
}

/**
 * Builds the first user message of a thread.
 * `payload` = { action, question, selection, context, pageText, title, url }
 */
export function buildUserMessage(payload) {
  const action = ACTIONS[payload.action];
  const parts = [`Page: ${payload.title || 'untitled'}`, `URL: ${payload.url || 'unknown'}`, ''];

  if (action && action.page) {
    parts.push('Text of the page:', fence(payload.pageText || ''), '');
  } else {
    parts.push('Passage the reader highlighted:', fence(payload.selection || ''), '');
    if (payload.context && payload.context !== payload.selection) {
      parts.push('Surrounding context from the page (reference only):', fence(payload.context), '');
    }
  }

  const task = action ? action.instruction : payload.question;
  parts.push(`Task: ${task}`);
  if (action && payload.question) parts.push('', `The reader also asks: ${payload.question}`);
  return parts.join('\n');
}

/** Reads settings, migrating the pre-provider shape (flat apiKey + model). */
export async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  const saved = stored.settings || {};
  const settings = {
    ...DEFAULT_SETTINGS,
    ...saved,
    keys: { ...DEFAULT_SETTINGS.keys, ...(saved.keys || {}) },
    models: { ...DEFAULT_SETTINGS.models, ...(saved.models || {}) },
    prices: { ...(saved.prices || {}) }
  };
  if (saved.apiKey && !saved.keys) settings.keys.anthropic = saved.apiKey;
  if (typeof saved.model === 'string' && !saved.models) settings.models.anthropic = saved.model;
  if (!PROVIDERS[settings.provider]) settings.provider = 'anthropic';
  return settings;
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = {
    ...current,
    ...patch,
    keys: { ...current.keys, ...(patch.keys || {}) },
    models: { ...current.models, ...(patch.models || {}) },
    prices: { ...current.prices, ...(patch.prices || {}) }
  };
  delete next.apiKey;
  delete next.model;
  await chrome.storage.local.set({ settings: next });
  return next;
}

/** Finds a model's price row across every provider - ids are unique. */
export function priceOf(modelId) {
  for (const provider of Object.values(PROVIDERS)) {
    const found = provider.models.find((m) => m.id === modelId);
    if (found) return found.price;
  }
  return null;
}

export function estimateCost(model, usage, settings) {
  const price = priceOf(model) || (settings && settings.prices ? settings.prices[model] : null);
  if (!price || !usage) return null;
  const input = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  return (input * price[0] + (usage.output_tokens || 0) * price[1]) / 1e6;
}
