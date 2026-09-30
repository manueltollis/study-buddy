# Study Buddy — Privacy Policy

_Last updated: September 30, 2026_

Study Buddy is a Chrome extension that explains text you highlight on web pages and PDFs using an AI
model from a provider you choose. This policy explains what data the extension handles and where it
goes. In short: **the developer receives none of your data.** There are no accounts, no analytics and
no servers operated by the developer.

## What is sent, and to whom

Data leaves your browser only when **you** ask for something (click Explain, Quiz me, Summarize, send
a question, and so on). It is sent directly from your browser to the AI provider you selected in
Settings, and nowhere else:

- Anthropic — `api.anthropic.com`
- Z.ai (GLM) — `api.z.ai`
- OpenRouter — `openrouter.ai`
- or a custom endpoint whose address you entered yourself

Each request contains:

- the text you highlighted, and optionally a limited amount of surrounding page text (configurable in
  Settings, and can be set to 0), or the page's text if you ask about the whole page;
- the page's title and address (URL), so the model knows what you are reading;
- any question you type, and the earlier messages of that conversation;
- your API key for that provider, which is how the provider authenticates you.

What the provider does with this data is governed by that provider's own privacy policy and terms,
which you accepted when you created your API key.

The extension also makes these requests, which carry no personal data beyond the address involved:

- When you open a PDF, the extension downloads that PDF from the site it is on so it can display it
  in its own viewer. For some addresses that look like PDFs but do not end in `.pdf`, it first sends
  a lightweight `HEAD` request to that same site to check the file type.
- If you use OpenRouter, the Settings page can download OpenRouter's public list of models.

## What is stored on your device

The following is kept in your browser's extension storage (`chrome.storage.local`). It is never sent
to the developer:

- your settings, including your API keys;
- the passages you highlighted and the address of the page each one is on, so highlights reappear
  when you return;
- answers you chose to save as notes.

You can delete highlights and notes at any time from Settings → Data. Uninstalling the extension
deletes everything it stored.

## What the extension does not do

- It does not collect analytics, telemetry or usage statistics.
- It does not read or send page content in the background; it acts only when you trigger it.
- It does not sell or share your data, or use it for advertising, credit decisions or any purpose
  other than answering your requests.
- It does not load or run code from remote servers.

## Changes

If this policy changes, the updated version will be published at this address with a new date above.

## Contact

Questions about this policy: open an issue at
<https://github.com/manueltollis/study-buddy/issues>.
