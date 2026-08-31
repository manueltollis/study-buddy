import { EFFORT_LEVELS, PROVIDERS, activeKey, getSettings, modelsFor, priceOf, saveSettings } from '../lib/config.js';

const $ = (id) => document.getElementById(id);
const TYPICAL = { input: 500, output: 200 };
let settings;

function fill(select, values, labels) {
  select.replaceChildren(
    ...values.map((value, i) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = labels ? labels[i] : value;
      return option;
    })
  );
}

function paintModels() {
  const models = modelsFor(settings.provider);
  if (models.length) {
    fill($('model'), models.map((m) => m.id), models.map((m) => m.label));
    $('model').value = settings.models[settings.provider] || models[0].id;
    $('model').disabled = false;
  } else {
    const current = settings.models[settings.provider] || 'model';
    fill($('model'), [current], [current]);
    $('model').disabled = true;
  }
  $('effortRow').style.display = settings.provider === 'anthropic' ? '' : 'none';

  const price = priceOf($('model').value) || settings.prices[$('model').value];
  $('costline').textContent = price
    ? `≈ ${Math.round(1e6 / (TYPICAL.input * price[0] + TYPICAL.output * price[1])).toLocaleString()} questions / $1`
    : '';
}

async function relay(message) {
  await chrome.runtime.sendMessage(message);
  window.close();
}

async function init() {
  settings = await getSettings();
  const ids = Object.keys(PROVIDERS);
  fill($('provider'), ids, ids.map((id) => PROVIDERS[id].label));
  fill($('effort'), EFFORT_LEVELS);
  $('provider').value = settings.provider;
  $('effort').value = settings.effort;
  paintModels();

  $('provider').addEventListener('change', async () => {
    settings = await saveSettings({ provider: $('provider').value });
    paintModels();
    paintStatus();
  });
  $('model').addEventListener('change', async () => {
    settings = await saveSettings({ models: { [settings.provider]: $('model').value } });
    paintModels();
  });
  $('effort').addEventListener('change', () => saveSettings({ effort: $('effort').value }));

  function paintStatus() {
    const keyline = $('keyline');
    if (activeKey(settings)) {
      keyline.className = 'keyline ok';
      keyline.textContent = 'Select text on any page, then use the bubble or ⌘⇧E.';
    } else {
      keyline.className = 'keyline err';
      keyline.textContent = `No ${PROVIDERS[settings.provider].label} key yet — add one in Settings.`;
    }
  }
  paintStatus();

  $('summarize').addEventListener('click', () => relay({ type: 'proxy-action', action: 'pageSummary' }));
  $('quiz').addEventListener('click', () => relay({ type: 'proxy-action', action: 'pageQuiz' }));
  $('panel').addEventListener('click', () => relay({ type: 'proxy-toggle' }));
  $('notes').addEventListener('click', () => relay({ type: 'open-page', page: 'notes' }));
  $('options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
}

init();
