"""Local contract/security tests. Synthetic provider fixtures are NOT live AI acceptance."""

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from conftest import create_user
from fastapi import HTTPException
from sqlalchemy import select

from app.config import settings
from app.database import transaction
from app.models import AIConnection, AIRun, ChatMessage, ChatSession, Model, now
from app.one import providers, vault
from app.one.chat import generate

KEY = "UNIT-TEST-API-KEY-not-a-real-credential"


def connect(client, name="Primary", provider="openai"):
    r = client.post("/api/v2/connections", json={"name": name, "provider": provider, "api_key": KEY})
    assert r.status_code == 201, r.text
    return r.json()


def ready(client, monkeypatch, name="Primary"):
    async def listing(provider, key):
        assert key == KEY
        return ["contract-model"]

    monkeypatch.setattr(providers, "available_models", listing)
    c = connect(client, name)
    assert client.post(f"/api/v2/connections/{c['id']}/test").json()["status"] == "ready"
    with transaction() as s:
        if not s.get(Model, "contract-model"):
            s.add(
                Model(
                    id="contract-model",
                    provider="openai",
                    capabilities=["text"],
                    input_cents_per_million=100,
                    output_cents_per_million=200,
                )
            )
    return c


def new_session(client):
    r = client.post("/api/v2/sessions", json={})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def send(client, sid, cid, **extra):
    return client.post(
        f"/api/v2/sessions/{sid}/messages",
        json={"connection_id": cid, "model_id": "contract-model", "content": "Contract test message", **extra},
    )


async def successful_stream(provider, key, model, messages, max_tokens):
    assert key == KEY
    yield ("delta", "Contract fixture output")
    yield ("usage", {"input_tokens": 21, "output_tokens": 6})
    yield ("complete", None)


def test_key_encryption_and_aad_binding(regular):
    result = connect(regular)
    assert KEY not in json.dumps(result)
    with transaction() as s:
        c = s.get(AIConnection, result["id"])
        assert c.encrypted_key.startswith("v1:") and KEY not in c.encrypted_key
        assert vault.unseal(c.encrypted_key, c.owner_id, c.id) == KEY
        for owner, connection in [(c.owner_id + 1, c.id), (c.owner_id, c.id + 1)]:
            with pytest.raises(HTTPException):
                vault.unseal(c.encrypted_key, owner, connection)
    assert KEY not in regular.get("/api/v2/connections").text


def test_encryption_key_required_and_no_insert(regular, monkeypatch):
    monkeypatch.setattr(settings, "ai_encryption_key", "")
    assert (
        regular.post("/api/v2/connections", json={"name": "A", "provider": "openai", "api_key": KEY}).status_code == 503
    )
    assert regular.get("/api/v2/connections").json()["connections"] == []


def test_cli_passwords_and_custom_base_urls_rejected(regular):
    for extra in [{"connection_type": "cli"}, {"base_url": "http://127.0.0.1"}, {"password": "consumer-password"}]:
        r = regular.post("/api/v2/connections", json={"name": "A", "provider": "openai", "api_key": KEY, **extra})
        assert r.status_code == 422
        assert KEY not in r.text and "consumer-password" not in r.text


def test_personal_records_private_even_from_administrator(admin):
    other = create_user()
    with transaction() as s:
        c = AIConnection(owner_id=other, name="Private", provider="openai", encrypted_key="unreadable")
        s.add(c)
        s.flush()
        cid = c.id
        s.add(ChatSession(id="private-conversation", owner_id=other, title="Private conversation"))
    assert admin.get("/api/v2/connections").json()["connections"] == []
    assert admin.get("/api/v2/sessions?q=Private").json()["sessions"] == []
    for action in ["default", "test", "revoke"]:
        assert admin.post(f"/api/v2/connections/{cid}/{action}").status_code == 404
    assert admin.delete(f"/api/v2/connections/{cid}").status_code == 404
    assert admin.patch(f"/api/v2/connections/{cid}", json={"name": "No", "budget_cents": 5}).status_code == 404
    assert admin.get("/api/v2/sessions/private-conversation").status_code == 404
    assert admin.patch("/api/v2/sessions/private-conversation", json={"title": "No"}).status_code == 404
    assert admin.delete("/api/v2/sessions/private-conversation").status_code == 404


def test_parallel_defaults_serialized(regular):
    a, b = connect(regular, "A"), connect(regular, "B")
    assert a["is_default"] and not b["is_default"]
    with ThreadPoolExecutor(2) as pool:
        responses = list(pool.map(lambda cid: regular.post(f"/api/v2/connections/{cid}/default"), [a["id"], b["id"]]))
    assert all(r.status_code == 200 for r in responses)
    assert sum(c["is_default"] for c in regular.get("/api/v2/connections").json()["connections"]) == 1


def test_failed_check_does_not_leak_provider_exception(regular, monkeypatch, caplog):
    c = connect(regular)

    async def failure(*args):
        raise ValueError("provider body with " + KEY)

    monkeypatch.setattr(providers, "available_models", failure)
    r = regular.post(f"/api/v2/connections/{c['id']}/test")
    assert r.status_code == 200 and r.json()["status"] == "check_failed"
    assert KEY not in r.text and KEY not in caplog.text


def test_successful_stream_persisted_and_costed(regular, monkeypatch):
    c = ready(regular, monkeypatch)
    monkeypatch.setattr(providers, "stream", successful_stream)
    sid = new_session(regular)
    response = send(regular, sid, c["id"])
    assert response.status_code == 200, response.text
    assert "event: delta" in response.text and "event: done" in response.text and KEY not in response.text
    conversation = regular.get("/api/v2/sessions/" + sid).json()
    assert [m["role"] for m in conversation["messages"]] == ["user", "assistant"]
    assert conversation["messages"][1]["content"] == "Contract fixture output"
    run = conversation["runs"][0]
    assert run["status"] == "succeeded" and run["cost_cents"] == 1
    assert run["connection_id"] == c["id"]
    usage = regular.get("/api/v2/usage").json()["personal_api"]
    assert usage["cost_cents_reserved"] == 0 and usage["requests"] == 1


def test_switch_requires_context_confirmation(regular, monkeypatch):
    a, b = ready(regular, monkeypatch, "A"), ready(regular, monkeypatch, "B")
    monkeypatch.setattr(providers, "stream", successful_stream)
    sid = new_session(regular)
    assert send(regular, sid, a["id"]).status_code == 200
    assert send(regular, sid, b["id"]).status_code == 409
    assert send(regular, sid, b["id"], confirm_handoff=True).status_code == 200


def test_default_switch_does_not_retarget_running_connection(regular, monkeypatch):
    a, b = ready(regular, monkeypatch, "A"), ready(regular, monkeypatch, "B")

    async def switch_during_stream(provider, key, model, messages, max_tokens):
        with transaction() as s:
            for c in s.scalars(select(AIConnection)):
                c.is_default = c.id == b["id"]
        async for event in successful_stream(provider, key, model, messages, max_tokens):
            yield event

    monkeypatch.setattr(providers, "stream", switch_during_stream)
    sid = new_session(regular)
    assert send(regular, sid, a["id"]).status_code == 200
    run = regular.get("/api/v2/sessions/" + sid).json()["runs"][0]
    assert run["connection_id"] == a["id"]


@pytest.mark.parametrize("reason", ["revoked", "unpriced", "budget"])
def test_admission_guards_do_not_store_unsent_messages(regular, monkeypatch, reason):
    c = ready(regular, monkeypatch)
    with transaction() as s:
        if reason == "revoked":
            s.get(AIConnection, c["id"]).revoked_at = now()
        if reason == "unpriced":
            s.get(Model, "contract-model").input_cents_per_million = None
        if reason == "budget":
            s.get(AIConnection, c["id"]).budget_cents = 0
    sid = new_session(regular)
    assert send(regular, sid, c["id"]).status_code in (409, 429, 503)
    assert regular.get("/api/v2/sessions/" + sid).json()["messages"] == []


def test_ambiguous_stream_failure_retains_reservation(regular, monkeypatch, caplog):
    c = ready(regular, monkeypatch)

    async def failure(*args):
        yield ("delta", "Partial response")
        raise ValueError(KEY)

    monkeypatch.setattr(providers, "stream", failure)
    sid = new_session(regular)
    r = send(regular, sid, c["id"])
    assert "event: error" in r.text and KEY not in r.text and KEY not in caplog.text
    run = regular.get("/api/v2/sessions/" + sid).json()["runs"][0]
    assert run["status"] == "failed" and run["cost_cents"] is None and run["reserved_cents"] > 0
    assert regular.get("/api/v2/usage").json()["personal_api"]["cost_cents_reserved"] > 0


def test_search_literal_and_pagination(regular):
    sid = new_session(regular)
    assert regular.patch("/api/v2/sessions/" + sid, json={"title": "100% private"}).status_code == 200
    new_session(regular)
    assert len(regular.get("/api/v2/sessions?q=%25").json()["sessions"]) == 1
    with transaction() as s:
        uid = s.get(ChatSession, sid).owner_id
        for i in range(65):
            s.add(ChatMessage(session_id=sid, owner_id=uid, role="user", content=str(i)))
    first = regular.get("/api/v2/sessions/" + sid).json()
    assert len(first["messages"]) == 50 and first["has_older"]
    second = regular.get(f"/api/v2/sessions/{sid}?before={first['messages'][0]['id']}").json()
    assert len(second["messages"]) == 15 and not second["has_older"]


def test_revoke_scrubs_key_and_prevents_reuse(regular, monkeypatch):
    c = ready(regular, monkeypatch)
    assert regular.post(f"/api/v2/connections/{c['id']}/revoke").status_code == 200
    with transaction() as s:
        assert s.get(AIConnection, c["id"]).encrypted_key == ""
    assert regular.post(f"/api/v2/connections/{c['id']}/default").status_code == 409
    assert regular.delete(f"/api/v2/connections/{c['id']}").status_code == 200
    assert regular.get("/api/v2/connections").json()["connections"] == []


def test_foreign_run_stop_denied_and_stale_recovery_keeps_cost(regular, monkeypatch):
    c = ready(regular, monkeypatch)
    sid = new_session(regular)
    foreign = create_user()
    with transaction() as s:
        uid = s.get(ChatSession, sid).owner_id
        s.add(ChatSession(id="foreign", owner_id=foreign, title="Other"))
        s.flush()
        s.add(
            AIRun(
                id="foreign-run",
                owner_id=foreign,
                session_id="foreign",
                connection_id=c["id"],
                model_id="contract-model",
                status="running",
                input_price=1,
                output_price=1,
                reserved_cents=4,
                reserved_tokens=10,
            )
        )
        s.add(
            AIRun(
                id="stale",
                owner_id=uid,
                session_id=sid,
                connection_id=c["id"],
                model_id="contract-model",
                status="running",
                input_price=1,
                output_price=1,
                reserved_cents=4,
                reserved_tokens=10,
                created_at=now() - 200,
            )
        )
    assert regular.post("/api/v2/runs/foreign-run/stop").status_code == 404
    assert regular.post(f"/api/v2/sessions/{sid}/recover").status_code == 200
    with transaction() as s:
        assert s.get(AIRun, "stale").status == "interrupted"
        assert s.get(AIRun, "stale").cost_cents is None and s.get(AIRun, "stale").reserved_cents == 4


def test_stop_silent_upstream_closes_generator_and_persists(regular, monkeypatch):
    c = ready(regular, monkeypatch)
    sid = new_session(regular)
    closed = []

    async def stalled(*args):
        try:
            await asyncio.sleep(5)
            yield ("delta", "should never arrive")
        finally:
            closed.append(True)

    monkeypatch.setattr(providers, "stream", stalled)
    with transaction() as s:
        uid = s.get(ChatSession, sid).owner_id
        s.add(
            AIRun(
                id="stop-test",
                owner_id=uid,
                session_id=sid,
                connection_id=c["id"],
                model_id="contract-model",
                input_price=1,
                output_price=1,
                reserved_cents=4,
                reserved_tokens=10,
            )
        )

    class Connected:
        async def is_disconnected(self):
            return False

    async def run_test():
        g = generate("stop-test", [], "openai", 20, Connected())
        assert "event: start" in await anext(g)
        next_event = asyncio.create_task(anext(g))
        await asyncio.sleep(0.1)
        with transaction() as s:
            s.get(AIRun, "stop-test").status = "cancel_requested"
        assert "event: done" in await asyncio.wait_for(next_event, timeout=2)
        await g.aclose()

    asyncio.run(run_test())
    assert closed
    with transaction() as s:
        assert s.get(AIRun, "stop-test").status == "cancelled"


@pytest.mark.parametrize(
    ("provider", "data", "expected"),
    [
        ("openai", {"type": "response.output_text.delta", "delta": "hi"}, [("delta", "hi")]),
        (
            "anthropic",
            {"type": "content_block_delta", "delta": {"type": "text_delta", "text": "hi"}},
            [("delta", "hi")],
        ),
        (
            "google",
            {"usageMetadata": {"promptTokenCount": 4, "candidatesTokenCount": 3, "thoughtsTokenCount": 2}},
            [("usage", {"input_tokens": 4, "output_tokens": 5})],
        ),
    ],
)
def test_official_protocol_decoders(provider, data, expected):
    assert providers.decode(provider, data) == expected


def test_alpha_fail_closed_for_production(monkeypatch):
    monkeypatch.setattr(settings, "production", True)
    monkeypatch.setattr(settings, "origin", "https://fafa888.uk")
    monkeypatch.setattr(settings, "secure", True)
    with pytest.raises(RuntimeError, match="not production approved"):
        settings.validate()


@pytest.mark.parametrize("close_error", [ValueError, asyncio.CancelledError])
def test_upstream_close_failure_cannot_discard_saved_result(regular, monkeypatch, caplog, close_error):
    c = ready(regular, monkeypatch)

    class ClosingFailure:
        def __init__(self):
            self.events = iter(
                [("delta", "Saved output"), ("usage", {"input_tokens": 3, "output_tokens": 2}), ("complete", None)]
            )

        def __aiter__(self):
            return self

        async def __anext__(self):
            try:
                return next(self.events)
            except StopIteration:
                raise StopAsyncIteration from None

        async def aclose(self):
            raise close_error(KEY)

    monkeypatch.setattr(providers, "stream", lambda *args: ClosingFailure())
    sid = new_session(regular)
    response = send(regular, sid, c["id"])
    assert "event: done" in response.text
    conversation = regular.get("/api/v2/sessions/" + sid).json()
    assert conversation["runs"][0]["status"] == "succeeded"
    assert conversation["messages"][-1]["content"] == "Saved output"
    assert KEY not in response.text and KEY not in caplog.text
