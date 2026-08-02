# Feature Spec — In-app "Ask OrderHub" AI Chat

**Status:** Ready to build (2026-07-18). OrderHub web (Lovable). Reuses the Weekly-AI-Report machinery.

## Goal
A non-technical lab owner asks plain-English questions about **their own** lab and gets grounded answers, in-app. Uses the org's **own Anthropic API key** (the same one already stored for the Weekly Report), strictly org-scoped via the existing MCP tools, with **per-question cost tracking** so spend is visible.

## Reuse (already built)
- `org_ai_settings` — per-org Anthropic key + model (org-admin managed).
- `_shared/mcp-tools.ts` — org-scoped read-only tools (orders, jobs, film scans, customers, sales, top products, performance, pending pickups, inventory, needs-attention, daily briefing).
- The agentic-loop pattern in `generate-weekly-report` (Anthropic Messages API + tools + dispatch handler).

## Design
1. **Gating:** the chat only appears when the org has an Anthropic key in `org_ai_settings`. No key → no chat (and the existing AI Reporting settings page is where they add one).
2. **Read-only:** expose only the read tools (the weekly-report set) — never `update_job_status` or any write tool.
3. **Cost tracking:** every question logs tokens + computed USD cost per org; the UI shows per-answer cost and a running month-to-date total.
4. **Model:** use the org's configured `org_ai_settings.model` (labs can pick Haiku for cheap Q&A in AI Reporting settings).
5. **Access:** org-admin only initially (matches who manages the key / the reports).

## Prompt A — Lovable — backend (edge function + cost log)
```
Build the backend for an in-app "Ask OrderHub" AI chat — org-scoped, using the org's own Anthropic key
(the same key as the Weekly AI Report). Additive; do not change the weekly report or the MCP server.

1. Migration: table org_ai_chat_log (id uuid pk default gen_random_uuid(), organization_id uuid not null
   references organizations(id), created_at timestamptz default now(), created_by uuid, model_used text,
   input_tokens int, output_tokens int, cost_usd numeric, question text, answer text, tool_calls int).
   RLS: mirror org_ai_settings / org_weekly_reports (org admins of that organization can select/insert;
   service role bypass). Index (organization_id, created_at).

2. Edge function ask-orderhub:
   - Auth org-admin JWT (same pattern as generate-weekly-report); resolve organization_id.
   - Load org_ai_settings; if no Anthropic API key → 400 "No API key configured".
   - Body: { messages } (conversation so far: [{role, content}]) — the last user message is the question.
   - Expose ONLY the read-only tools from _shared/mcp-tools.ts as Anthropic tool defs (the same set the
     weekly report uses; exclude any write tool such as update_job_status). All tools org-scoped to this org.
   - System prompt: "You are an assistant for a photo lab's OrderHub account. Answer the user's questions
     using the available tools. Only state facts returned by the tools; if the data isn't available via a
     tool, say so plainly. Be concise and practical." 
   - Run the Anthropic Messages API agentic loop (cap ~10 steps) with the org's key + org_ai_settings.model,
     dispatching tool_use through the same shared MCP handler as the weekly report.
   - Sum input+output tokens across the loop. Compute cost_usd from a per-model pricing map (USD per 1M:
     haiku {in:1,out:5}, sonnet {in:3,out:15}, opus {in:5,out:25}, fable {in:10,out:50}; match by model name,
     default to sonnet rates if unknown).
   - Insert an org_ai_chat_log row (question, final answer, model_used, tokens, cost_usd, tool_calls).
   - Return { answer, input_tokens, output_tokens, cost_usd, month_to_date_cost_usd } where
     month_to_date_cost_usd = SUM(cost_usd) for this org in the current calendar month.
   - Robust error handling; never leak the API key.
```

## Prompt B — Lovable — chat UI
```
Build the "Ask OrderHub" chat UI, shown ONLY when the org has an Anthropic API key configured in
org_ai_settings. Additive; consistent with existing styling. Org-admin only (match AI Reporting access).

1. Add an "Ask OrderHub" nav/sidebar entry + route (e.g. /ai-assistant), visible only when the org has an
   Anthropic API key set. Hidden otherwise.
2. Chat page: multi-turn conversation. On submit, POST the conversation messages to the ask-orderhub edge
   function; render the assistant's answer as markdown (react-markdown + remark-gfm, like the weekly report
   card). Show a loading/typing state; keep the conversation in state.
3. Empty state: clickable example prompts — "How were sales last week vs the week before?", "What's stuck in
   production?", "Who hasn't collected their order yet?", "What's my best-selling product this month?",
   "Which film rolls are still waiting to be scanned?", "What should I focus on today?".
4. Cost visibility: under each answer show a subtle "~$X.XXX · N tokens"; and on the page show a running
   "This month: $X.XX" from month_to_date_cost_usd. 
5. If the org has no API key, the page/route isn't shown; if somehow reached, show a short note pointing to
   Settings → AI Reporting to add a key.
```

## Notes
- Test in PXDEMO ("Pixfizz Test Lab") — it already has an Anthropic key (weekly report runs there). Ask a range of questions, then check org_ai_chat_log for real cost per question.
- Future levers (not in v1): per-org monthly cap, prompt caching on the static system prompt + tool schemas (~90% off cached input), Pixfizz-provided platform key as an alternative to BYO.
