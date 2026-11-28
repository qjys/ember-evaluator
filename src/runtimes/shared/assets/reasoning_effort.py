"""Apply an explicit service effort to OpenAI-compatible AgentX replay."""

def apply_reasoning_effort(payload, effort):
    body = dict(payload)
    body["reasoning_effort"] = effort
    if isinstance(body.get("reasoning"), dict) and "effort" in body["reasoning"]:
        body["reasoning"] = {**body["reasoning"], "effort": effort}
    if body.get("enable_thinking") is False:
        body["enable_thinking"] = True
    if isinstance(body.get("thinking"), dict) and body["thinking"].get("type") == "disabled":
        body["thinking"] = {**body["thinking"], "type": "enabled"}
    if isinstance(body.get("chat_template_kwargs"), dict):
        template = dict(body["chat_template_kwargs"])
        if "reasoning_effort" in template:
            template["reasoning_effort"] = effort
        if template.get("enable_thinking") is False:
            template["enable_thinking"] = True
        body["chat_template_kwargs"] = template
    return body
