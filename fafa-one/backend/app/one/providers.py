"""Fixed official endpoints. No consumer cookies, custom base URLs or silent retry."""

import json
import re

import httpx

from ..adapters.ai import ProviderFailure

MODEL_ID = re.compile(r"^[a-zA-Z0-9._-]{1,100}$")
ENDPOINTS = {
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com/v1",
    "google": "https://generativelanguage.googleapis.com/v1beta",
}


def headers(provider, key):
    if provider == "openai":
        return {"Authorization": "Bearer " + key}
    if provider == "anthropic":
        return {"x-api-key": key, "anthropic-version": "2023-06-01"}
    if provider == "google":
        return {"x-goog-api-key": key}
    raise ValueError("Unsupported provider")


async def available_models(provider, key):
    async with httpx.AsyncClient(timeout=20, follow_redirects=False) as client:
        async with client.stream("GET", ENDPOINTS[provider] + "/models", headers=headers(provider, key)) as response:
            if response.status_code != 200:
                raise ProviderFailure(response.status_code)
            buf = bytearray()
            async for chunk in response.aiter_bytes():
                buf.extend(chunk)
                if len(buf) > 2_000_000:
                    raise ValueError("Model response too large")
    data = json.loads(buf)
    # These are actual returned IDs, never inferred from provider names or stars.
    models = []
    for item in data.get("models" if provider == "google" else "data", [])[:1000]:
        mid = item.get("name" if provider == "google" else "id", "")
        if provider == "google":
            mid = mid.removeprefix("models/")
            if "generateContent" not in item.get("supportedGenerationMethods", []):
                continue
        if MODEL_ID.fullmatch(mid):
            models.append(mid)
    return sorted(set(models))


def payload(provider, model, messages, max_tokens):
    if not MODEL_ID.fullmatch(model):
        raise ValueError("Invalid model ID")
    if provider == "openai":
        return "/responses", {
            "model": model,
            "input": messages,
            "max_output_tokens": max_tokens,
            "store": False,
            "stream": True,
        }
    if provider == "anthropic":
        return "/messages", {"model": model, "messages": messages, "max_tokens": max_tokens, "stream": True}
    return "/models/" + model + ":streamGenerateContent?alt=sse", {
        "contents": [
            {"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]}
            for m in messages
        ],
        "generationConfig": {"maxOutputTokens": max_tokens},
    }


def decode(provider, data):
    """Normalize provider SSE into text and actual usage, with no guessed counters."""
    if data.get("type") in ("error", "response.failed", "response.incomplete") or data.get("error"):
        raise ValueError("Provider stream rejected")
    if provider == "openai":
        if data.get("type") == "response.output_text.delta":
            return [("delta", data.get("delta", ""))]
        if data.get("type") == "response.completed":
            return [("usage", data.get("response", {}).get("usage", {})), ("complete", None)]
    elif provider == "anthropic":
        kind = data.get("type")
        if kind == "content_block_delta" and data.get("delta", {}).get("type") == "text_delta":
            return [("delta", data["delta"].get("text", ""))]
        if kind == "message_start":
            return [("usage", data.get("message", {}).get("usage", {}))]
        if kind == "message_delta":
            return [("usage", data.get("usage", {}))]
        if kind == "message_stop":
            return [("complete", None)]
    else:
        events = [
            ("delta", part.get("text", ""))
            for candidate in data.get("candidates", [])
            for part in candidate.get("content", {}).get("parts", [])
            if not part.get("thought")
        ]
        if "usageMetadata" in data:
            usage = data["usageMetadata"]
            output = usage.get("candidatesTokenCount")
            if isinstance(output, int):
                output += usage.get("thoughtsTokenCount", 0)
            events.append(("usage", {"input_tokens": usage.get("promptTokenCount"), "output_tokens": output}))
        if any(c.get("finishReason") for c in data.get("candidates", [])):
            events.append(("complete", None))
        return events
    return []


async def stream(provider, key, model, messages, max_tokens):
    path, body = payload(provider, model, messages, max_tokens)
    async with httpx.AsyncClient(timeout=httpx.Timeout(60, connect=15), follow_redirects=False) as client:
        async with client.stream(
            "POST", ENDPOINTS[provider] + path, headers=headers(provider, key), json=body
        ) as response:
            if response.status_code != 200:
                raise ProviderFailure(response.status_code)
            # Read bounded chunks ourselves: a malicious/unexpected upstream must not
            # make an unbounded aiter_lines buffer before an application size check.
            pending = bytearray()
            total = 0
            async for chunk in response.aiter_bytes():
                total += len(chunk)
                if total > 2_000_000:
                    raise ValueError("Provider stream too large")
                pending.extend(chunk)
                while b"\n" in pending:
                    line, _, tail = pending.partition(b"\n")
                    pending = bytearray(tail)
                    if len(line) > 100_000:
                        raise ValueError("SSE line too large")
                    if not line.startswith(b"data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw or raw == b"[DONE]":
                        continue
                    for event in decode(provider, json.loads(raw)):
                        yield event
                if len(pending) > 100_000:
                    raise ValueError("SSE line too large")
