# One line of `ork agent sessions events stream` in, two lines out:
#   1. control fields, separated by \u001f: frame, event id, old?, type, stop reason, blocking ids, error
#   2. what to print for the participant (may be empty, may span lines)
# A stream line is either {"id": <frame>, "event": ..., "data": <event>} or the bare event.
# $since is the processed_at of our own message: anything older is from an earlier turn.

def wrapped: type == "object" and has("data") and (.data | type) == "object";

# Timestamps compare as strings once the fraction has exactly six digits.
def ts_key: (capture("^(?<base>[^.Z+]+)(\\.(?<frac>[0-9]+))?") // {base: ., frac: ""})
  | .base + "." + ((.frac // "") + "000000")[0:6];

def shorten: if length > 160 then .[0:159] + "…" else . end;

# Python's json.dumps spacing, so every language prints the same line.
def pyjson:
  if type == "object" then "{" + ([to_entries[] | (.key | tojson) + ": " + (.value | pyjson)] | join(", ")) + "}"
  elif type == "array" then "[" + (map(pyjson) | join(", ")) + "]"
  else tojson end;

def clean: tostring | gsub("[\n\r\u001f]"; " ");

# Servers report a retry in one of two places: beside the error, or inside it.
def will_retry: (.retry_status.will_retry == true) or (.error.retry_status.type == "retrying");

(if wrapped then (.id // "" | tostring) else "" end) as $frame
| (if wrapped then .data else . end) as $e
| ($e.processed_at // "") as $at
| ($e.error.message // $e.error.type // "unknown error") as $error
| [
    $frame,
    ($e.id // ""),
    (($since != "" and $at != "" and (($at | ts_key) < ($since | ts_key))) | tostring),
    ($e.type // ""),
    (if $e.type == "session.status_idle" then $e.stop_reason.type // "" else "" end),
    (if $e.type == "session.status_idle" then ($e.stop_reason.event_ids // []) | join(" ") else "" end),
    (if $e.type == "session.error" then $error else "" end)
  ]
| map(clean) | join("\u001f"),
(
  if $e.type == "agent.message" then
    "[agent]  " + ([($e.content // [])[] | select(type == "object" and .type == "text") | .text // ""] | join(""))
  elif $e.type == "agent.mcp_tool_use" then
    "[tool]   \($e.name) \(($e.input // {}) | pyjson)" | shorten
  elif $e.type == "agent.mcp_tool_result" then
    ((if $e.is_error then "[error] " else "[result] " end)
      + ([($e.content // [])[] | select(type == "object") | .text // ""] | join(" "))) | shorten
  elif $e.type == "session.error" then
    "[error]  " + $error + (if ($e | will_retry) then " (retrying)" else "" end)
  else "" end
)
