# The AI assistant

The assistant is optional. With it off, the platform works the same, and every campaign page still has its delivery check, which uses no AI.

## Turning it on

### From the dashboard

A platform admin opens **Assistant**, where a **Settings** card appears only for admins:

1. **Choose a provider:** a local model, Claude, or an OpenAI-compatible API.
2. **Fill in what it needs:**
   - **Claude or OpenAI:** paste the key. It's stored encrypted with `ENCRYPTION_KEY`, shown afterwards only as its last four characters, and never sent back to the browser.
   - **Local:** the page checks whether Ollama is running and lists the models it already has. Any model from [Ollama's library](https://ollama.com/library) can be downloaded from the page, with a progress bar.
3. **Test connection.** This sends one tiny request and shows "Live" with the time it took, or the reason it failed in plain words (key refused, model not found, server not reachable).
4. **Save and turn on.** It applies straight away, with no restart. Other API processes pick it up within 30 seconds.

**Turn off** keeps the settings, so turning it back on doesn't need the key again. Every change is recorded in the activity log, without the key.

**Installing Ollama itself is a manual step.** A web page that downloads and runs installers on the server would be a serious risk if an admin account were ever misused. When Ollama isn't found, the page links to [ollama.com/download](https://ollama.com/download), gives the one-line `winget` command, and offers **Check again**.

Settings can't be changed in the public demo.

### From `.env`

`AI_PROVIDER` in `.env` takes priority over the dashboard and locks its settings. That suits Docker and servers. Whoever runs the platform sets these and restarts the API:

| Setting | Meaning |
|---|---|
| `AI_PROVIDER` | Empty (off), `anthropic`, `openai` or `local` |
| `AI_API_KEY` | The runner's own key, for `anthropic` and `openai` |
| `AI_MODEL` | Optional. Defaults to `claude-opus-5-5` for `anthropic` and `qwen2.5:7b` for `local`; required for `openai` |
| `AI_BASE_URL` | Optional. For `openai`-compatible servers, or a local server on another port |
| `AI_TIMEOUT_MS` | How long to wait for the model. Defaults to 60 seconds, and at least 3 minutes for local models |
| `AI_RATE_LIMIT` | Model requests per person per 15 minutes. Defaults to 30 |

**A free local model.** Install [Ollama](https://ollama.com), run `ollama pull qwen2.5:7b` (about 5 GB), and set `AI_PROVIDER=local`. Nothing leaves the machine and no key is needed. On a laptop GPU, a 7B model answers in a few seconds once it's loaded. The first answer after a quiet spell takes longer while the model loads into memory. Raising Ollama's `OLLAMA_CONTEXT_LENGTH` to 16384 gives the model room for longer campaign data.

**Claude.** Set `AI_PROVIDER=anthropic` and `AI_API_KEY` to your own key from the [Claude Console](https://console.anthropic.com). Usage is billed to that account.

`.env` is ignored by git, so keys stay on the machine that runs the platform.

## What it can see

The assistant answers through read-only tools that call the same services as the dashboard, as the signed-in person:

| Tool | What it returns |
|---|---|
| `list_campaigns` | Campaigns with their status, pacing and totals |
| `diagnose_campaign` | The delivery check: the main reason a campaign is behind, with its numbers |
| `campaign_details` | Settings, a recent period against the one before, reach, frequency and breakdowns |
| `run_report` | Any report the report builder can run |
| `list_alerts` | Open or recent alerts |

So an analyst's question only reaches their organisation's campaigns, and another company's data is out of reach. The tools return no email addresses and no internal user IDs. Text that people typed, such as campaign names and briefs, is passed to the model as data, with an instruction never to follow instructions found in it.

## Why a campaign is behind

The delivery check (`GET /campaigns/:id/diagnosis`) does the analysis, and the model explains it. It forecasts the rest of the flight and compares each limit by how many impressions it allows:

- **Matching traffic:** ad requests that fit the targeting, minus what other guaranteed campaigns need
- **Budget** and **daily budget**
- **Daily impression target**
- **Frequency cap:** viewers available times views allowed per viewer

The smallest one is the main reason. It also reports blockers (paused, not started, no approved ad, a bid below the auction floor) and the outlook at the recent pace. Because the numbers are computed, the assistant's answer is only as good as its explanation of them, and the tool puts its conclusion first so smaller models lead with it.

## Changes need a person

The assistant can't change anything on its own.

- **Suggested changes** are stored as pending, with the values they would replace. Only owners and managers can ask for them, approve or turn them down.
- **An approval is refused** if any of those values changed since the suggestion was made, and the change goes through the normal campaign update and its rules.
- **Suggestions that would slow a campaign that's behind are dropped** before anyone sees them: a lower budget, a new or lower daily limit, a lower frequency cap or bid, or narrower targeting. Small models sometimes describe one change and fill in another, so this checks the numbers, not the words.
- **Drafts from a brief** only fill the campaign form. Values that can't be right, such as a frequency cap in the millions or a daily budget above the total, are left out with a note, and every assumption is listed above the form.
- **Ad checks** never change an ad's status. The reviewer sees the result as advice.
- Approvals and rejections appear in the activity log.

## Background work

When the assistant is on:

- **New alerts** get a short explanation, saved with the alert and added to its email. If the model is slow or fails, the alert is sent without one.
- **Scheduled reports** get a "what changed and why" paragraph, from the report's own numbers and the delivery check of campaigns at risk.
- **New ads** get a first look at their poster frame once converted. Models that can't read images record that the check was unavailable.

## How it was tested

- **Automated tests** run against local stand-in servers for the Claude and OpenAI-compatible APIs, so they need no key and cost nothing. They check the requests (model, tools, structured output, prompt caching) and every safeguard above, and each safeguard was broken on purpose to confirm a test fails.
- **With a real local model** (`qwen2.5:7b` through Ollama), on the demo data:
  - "Why is Electric City Car behind?" was answered correctly in 6 of 7 runs, naming the frequency cap and its numbers. The one miss came before the delivery check's conclusion was put first in its output; every run after that change was right. Questions about Family Breakfast (matching traffic) and Spring Teaser (paused) were also right.
  - Its suggested changes were all unhelpful (for example, a lower budget described as a higher one), and the delivery guard dropped every one.
  - Drafts filled the form sensibly after the safeguards above, but dates were sometimes a day off.
- **Dashboard settings,** walked through in a browser against the real local Ollama:
  - An admin found Ollama, tested `qwen2.5:7b` ("Live"), turned it on with no restart, and got a correct answer.
  - Downloading a small model showed progress and finished.
  - A made-up Claude key was refused by the real API with "The key was refused". That costs nothing.
  - Owners don't see the settings.
  - Automated tests cover admin-only access, the encrypted key never being returned, `.env` taking priority, the demo lock, the connection test and the Ollama helpers.
- **In a browser:** the assistant page, the delivery check, approving a change, drafting from a brief, the disabled state, phone width, and an accessibility check with axe. The suggestion shown in the screenshot was added by hand to show the approval step, since the local model didn't produce a usable one.

## Limits

- **Claude was not run against the live API.** Its requests were tested against a stand-in server that follows the API's format. The prompts and safeguards were tuned with a 7B local model.
- **Small local models are weak at suggestions, dates and arithmetic.** The safeguards stop harmful results, but a larger model gives far more useful suggestions and drafts.
- **Answers can be wrong.** The dashboard says so under every answer, and the delivery check next to it shows the computed facts.
- **Alert explanations, report summaries and ad checks** were tested only against the stand-in servers.
