<script setup>
defineProps({
  timeNow: { type: String, required: true },
  timeZoneLabel: { type: String, default: 'Asia/Shanghai' },
  isProbeEnabled: { type: Boolean, default: false },
  isProbing: { type: Boolean, default: false },
  isMentioned: { type: Boolean, default: false },
  isReplied: { type: Boolean, default: false },
  extraGuideline: { type: String, default: '' },
  triggerReason: { type: String, default: '' },
})
</script>

Current time: {{ timeNow }} ({{ timeZoneLabel }})

Reminder:
- Use `send_message` for user-visible output.
- No `send_message` call means silence.
- Text outside tool calls is private internal monologue.

<div v-if="triggerReason">

Current trigger reason: {{ triggerReason }}

</div>

<div v-if="extraGuideline">

Additional runtime guideline:
{{ extraGuideline }}

</div>

<div v-if="isProbeEnabled && isProbing">

PROBE MODE (decision-only turn):
- Do NOT call tools.
- Decide whether to respond now.
- Return JSON only with schema:
{"action":"respond"|"silent","reason":"short reason"}
- Default to `silent` unless responding is clearly high-value.

</div>
<div v-else-if="isProbeEnabled">

Probe already decided `respond`.
Proceed with normal tool calls and response generation.

</div>
<div v-else-if="isMentioned">

You were directly mentioned. A response is usually expected.

</div>
<div v-else-if="isReplied">

Someone replied to your prior message. A response is usually expected.

</div>
<div v-else>

No direct trigger signal. Prefer silence unless your reply adds clear value.

</div>

When acting:
- Keep responses concise and useful.
- If multiple independent tool calls are needed, run them in parallel.
- Use `await_response=true` when you need to continue after sending a message.
