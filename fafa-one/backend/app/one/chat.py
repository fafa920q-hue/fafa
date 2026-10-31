import asyncio
import calendar
import json
import logging
import math
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import or_, select

from ..admin import record
from ..database import serialize_security, transaction
from ..models import AIConnection, AIRequest, AIRun, ChatMessage, ChatSession, Model, User, now
from ..security import current_user, rate_limit
from . import providers, vault
from .connections import owned

router = APIRouter(prefix="/api/v2", tags=["Conversations"])
ACTIVE = ["pending", "running", "cancel_requested"]


class SessionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(default="新对话", min_length=1, max_length=100)


class MessageIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connection_id: int
    model_id: str = Field(pattern=r"^[a-zA-Z0-9._-]{1,100}$")
    content: str = Field(min_length=1, max_length=16_000)
    max_tokens: int = Field(default=1024, ge=16, le=4096)
    confirm_handoff: bool = False


def session_view(session):
    return {k: getattr(session, k) for k in ("id", "title", "created_at", "updated_at")}


def run_view(run):
    return {
        k: getattr(run, k)
        for k in (
            "id",
            "session_id",
            "connection_id",
            "model_id",
            "status",
            "input_tokens",
            "output_tokens",
            "cost_cents",
            "reserved_cents",
            "error",
            "created_at",
            "finished_at",
        )
    }


def current_session(s, sid, uid):
    session = owned(s, ChatSession, sid, uid)
    if session.archived_at:
        raise HTTPException(404, "Conversation not found")
    return session


@router.get("/sessions")
def list_sessions(q: str = Query("", max_length=100), page: int = Query(1, ge=1), user=Depends(current_user)):
    with transaction() as s:
        query = select(ChatSession).where(ChatSession.owner_id == user["id"], ChatSession.archived_at.is_(None))
        if q:
            # Escape SQL wildcards so user text has literal search semantics.
            text = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            matching = select(ChatMessage.session_id).where(
                ChatMessage.owner_id == user["id"], ChatMessage.content.ilike(text, escape="\\")
            )
            query = query.where(or_(ChatSession.title.ilike(text, escape="\\"), ChatSession.id.in_(matching)))
        rows = list(
            s.scalars(query.order_by(ChatSession.updated_at.desc(), ChatSession.id).offset((page - 1) * 30).limit(31))
        )
        return {"sessions": [session_view(row) for row in rows[:30]], "has_more": len(rows) > 30}


@router.post("/sessions", status_code=201)
def create_session(data: SessionIn, request: Request, user=Depends(current_user)):
    rate_limit(request, "sessions:" + str(user["id"]), 30, 60)
    if not data.title.strip():
        raise HTTPException(422, "Title cannot be blank")
    with transaction() as s:
        session = ChatSession(id=str(uuid.uuid4()), owner_id=user["id"], title=data.title.strip())
        s.add(session)
        s.flush()
        return session_view(session)


@router.patch("/sessions/{sid}")
def rename_session(sid: str, data: SessionIn, user=Depends(current_user)):
    if not data.title.strip():
        raise HTTPException(422, "Title cannot be blank")
    with transaction() as s:
        row = current_session(s, sid, user["id"])
        row.title, row.updated_at = data.title.strip(), now()
        return session_view(row)


@router.delete("/sessions/{sid}")
def archive_session(sid: str, user=Depends(current_user)):
    with transaction() as s:
        serialize_security(s)
        row = current_session(s, sid, user["id"])
        if s.scalar(select(AIRun.id).where(AIRun.session_id == sid, AIRun.status.in_(ACTIVE))):
            raise HTTPException(409, "Stop or recover the active run before archiving")
        row.archived_at = now()
        record(s, user["id"], f"conversation:{sid}", "conversation_archive")
    return {"status": "archived"}


@router.get("/sessions/{sid}")
def read_session(sid: str, before: int | None = Query(None, ge=1), user=Depends(current_user)):
    with transaction() as s:
        row = current_session(s, sid, user["id"])
        query = select(ChatMessage).where(ChatMessage.session_id == sid, ChatMessage.owner_id == user["id"])
        if before:
            query = query.where(ChatMessage.id < before)
        messages = list(s.scalars(query.order_by(ChatMessage.id.desc()).limit(51)))
        runs = list(
            s.scalars(
                select(AIRun)
                .where(AIRun.session_id == sid, AIRun.owner_id == user["id"])
                .order_by(AIRun.created_at.desc(), AIRun.id)
                .limit(20)
            )
        )
        return session_view(row) | {
            "messages": [
                {k: getattr(m, k) for k in ("id", "role", "content", "created_at")} for m in reversed(messages[:50])
            ],
            "has_older": len(messages) > 50,
            "runs": [run_view(r) for r in runs],
        }


def month_start():
    d = datetime.now(UTC)
    return calendar.timegm((d.year, d.month, 1, 0, 0, 0))


def usage_totals(rows):
    return {
        "requests": len(rows),
        "cost_cents_known": sum(r.cost_cents or 0 for r in rows),
        "cost_cents_reserved": sum(r.reserved_cents for r in rows if r.cost_cents is None),
        "tokens_used_or_reserved": sum(
            r.input_tokens + r.output_tokens
            if r.input_tokens is not None and r.output_tokens is not None
            else r.reserved_tokens
            for r in rows
        ),
        "unknown_usage_requests": sum(r.cost_cents is None for r in rows),
    }


@router.get("/usage")
def usage(user=Depends(current_user)):
    with transaction() as s:
        runs = list(s.scalars(select(AIRun).where(AIRun.owner_id == user["id"], AIRun.created_at >= month_start())))
        legacy = list(
            s.scalars(select(AIRequest).where(AIRequest.user_id == user["id"], AIRequest.created_at >= month_start()))
        )
        u = s.get(User, user["id"])
        return {
            "personal_api": usage_totals(runs),
            "all_api": usage_totals(runs + legacy),
            "limits": {
                "budget_cents": u.budget_cents,
                "monthly_requests": u.monthly_requests,
                "monthly_tokens": u.monthly_tokens,
            },
            "provider_remaining_quota": None,
            "currency": "USD",
            "cost_source": "reviewed prices and provider token usage",
        }


@router.get("/models")
def models(user=Depends(current_user)):
    with transaction() as s:
        return {
            "models": [
                {k: getattr(m, k) for k in ("id", "provider", "input_cents_per_million", "output_cents_per_million")}
                for m in s.scalars(select(Model).where(Model.enabled.is_(True)))
            ]
        }


def event(name, value):
    return "event: " + name + "\ndata: " + json.dumps(value, ensure_ascii=False) + "\n\n"


async def generate(rid, messages, provider, max_tokens, request):
    output = []
    usage = {}
    status, error = "interrupted", "stream_interrupted"
    key = None
    iterator = None
    pending = None
    try:
        with transaction() as s:
            serialize_security(s)
            run = s.get(AIRun, rid)
            c = s.get(AIConnection, run.connection_id)
            if run.status != "pending" or c.revoked_at:
                status, error = "cancelled", None
                return
            key = vault.unseal(c.encrypted_key, run.owner_id, c.id)
            run.status = "running"
            model = run.model_id
        yield event("start", {"run_id": rid, "connection_id": run.connection_id, "model_id": model})
        iterator = providers.stream(provider, key, model, messages, max_tokens).__aiter__()
        size = 0
        async with asyncio.timeout(120):
            while True:
                with transaction() as s:
                    cancelled = s.get(AIRun, rid).status == "cancel_requested"
                if cancelled or await request.is_disconnected():
                    status, error = "cancelled", None
                    break
                if pending is None:
                    pending = asyncio.create_task(anext(iterator))
                done, _ = await asyncio.wait([pending], timeout=0.5)
                if not done:
                    continue
                try:
                    kind, value = pending.result()
                except StopAsyncIteration:
                    break
                pending = None
                if kind == "delta":
                    if not isinstance(value, str):
                        raise ValueError("Invalid delta")
                    size += len(value.encode())
                    if size > 200_000:
                        raise ValueError("Output limit")
                    output.append(value)
                    yield event("delta", {"text": value})
                elif kind == "usage":
                    for field in ("input_tokens", "output_tokens"):
                        if type(value.get(field)) is int and 0 <= value[field] <= 100_000_000:
                            usage[field] = value[field]
                elif kind == "complete":
                    if output:
                        status, error = "succeeded", None
                    else:
                        status, error = "failed", "empty_response"
                    break
    except asyncio.CancelledError:
        status, error = "cancelled", None
        raise
    except Exception:
        status, error = "failed", "provider_stream_failed"
        yield event("error", {"error": error, "retry": "manual", "usage": "unknown; reservation retained"})
    finally:
        key = None
        with transaction() as s:
            serialize_security(s)
            run = s.get(AIRun, rid)
            # A stop/revoke arriving with the completion chunk must win the race.
            if run.status in ("cancel_requested", "cancelled"):
                status, error = "cancelled", None
            run.status, run.error, run.finished_at = status, error, now()
            run.input_tokens, run.output_tokens = usage.get("input_tokens"), usage.get("output_tokens")
            if status == "succeeded" and run.input_tokens is not None and run.output_tokens is not None:
                run.cost_cents = math.ceil(
                    (run.input_tokens * run.input_price + run.output_tokens * run.output_price) / 1_000_000
                )
            if output:
                s.add(
                    ChatMessage(
                        session_id=run.session_id, owner_id=run.owner_id, role="assistant", content="".join(output)
                    )
                )
            s.get(ChatSession, run.session_id).updated_at = now()
            result = run_view(run)
        # Persist the terminal state before cancellable network cleanup. A close
        # failure or disconnect must not strand a run or discard partial output.
        if pending:
            pending.cancel()
            try:
                await pending
            except (Exception, asyncio.CancelledError):
                pass
        if iterator:
            try:
                await iterator.aclose()
            except (Exception, asyncio.CancelledError) as exc:
                logging.getLogger("fafa").warning(
                    json.dumps({"event": "provider_stream_cleanup_failed", "type": type(exc).__name__})
                )
    yield event("done", result)


@router.post("/sessions/{sid}/messages")
async def send_message(sid: str, data: MessageIn, request: Request, user=Depends(current_user)):
    rate_limit(request, "personal_ai:" + str(user["id"]), 20, 60)
    if not data.content.strip():
        raise HTTPException(422, "Message cannot be blank")
    with transaction() as s:
        serialize_security(s)
        session = current_session(s, sid, user["id"])
        if s.scalar(select(AIRun.id).where(AIRun.session_id == sid, AIRun.status.in_(ACTIVE))):
            raise HTTPException(409, "A run is active; stop it or recover after 180 seconds")
        c = owned(s, AIConnection, data.connection_id, user["id"])
        if c.revoked_at or c.deleted_at or c.status != "ready":
            raise HTTPException(409, "Check the connection before use")
        model = s.get(Model, data.model_id)
        if data.model_id not in c.models or not model or not model.enabled or model.provider != c.provider:
            raise HTTPException(422, "Model must be returned by the connection and enabled by the platform")
        if model.input_cents_per_million is None or model.output_cents_per_million is None:
            raise HTTPException(503, "Reviewed model prices required to enforce the cost cap")
        previous = s.scalar(
            select(AIRun).where(AIRun.session_id == sid).order_by(AIRun.created_at.desc(), AIRun.id.desc()).limit(1)
        )
        if previous and (previous.connection_id != c.id or previous.model_id != model.id) and not data.confirm_handoff:
            raise HTTPException(409, "Confirm context handoff before switching account or model in this conversation")
        history = list(s.scalars(select(ChatMessage).where(ChatMessage.session_id == sid).order_by(ChatMessage.id)))
        if len(history) >= 50:
            raise HTTPException(409, "Context limit reached; start a new conversation. History remains accessible.")
        messages = [{"role": m.role, "content": m.content} for m in history] + [
            {"role": "user", "content": data.content}
        ]
        input_bound = sum(len(m["content"].encode()) + 256 for m in messages) + 1024
        if input_bound > 32_000:
            raise HTTPException(409, "Context byte limit reached; start a new conversation")
        reserved_tokens = input_bound + data.max_tokens
        reserved_cents = math.ceil(
            (input_bound * model.input_cents_per_million + data.max_tokens * model.output_cents_per_million) / 1_000_000
        )
        rows = list(s.scalars(select(AIRun).where(AIRun.owner_id == user["id"], AIRun.created_at >= month_start())))
        legacy = list(
            s.scalars(select(AIRequest).where(AIRequest.user_id == user["id"], AIRequest.created_at >= month_start()))
        )
        totals = usage_totals(rows + legacy)
        connection_totals = usage_totals([r for r in rows if r.connection_id == c.id])
        u = s.get(User, user["id"])
        if (
            totals["requests"] >= u.monthly_requests
            or totals["tokens_used_or_reserved"] + reserved_tokens > u.monthly_tokens
            or totals["cost_cents_known"] + totals["cost_cents_reserved"] + reserved_cents > u.budget_cents
            or connection_totals["cost_cents_known"] + connection_totals["cost_cents_reserved"] + reserved_cents
            > c.budget_cents
        ):
            raise HTTPException(429, "Platform or connection monthly cost/usage cap reached")
        vault.unseal(c.encrypted_key, user["id"], c.id)  # Validate before committing the user message.
        run = AIRun(
            id=str(uuid.uuid4()),
            owner_id=user["id"],
            session_id=sid,
            connection_id=c.id,
            model_id=model.id,
            input_price=model.input_cents_per_million,
            output_price=model.output_cents_per_million,
            reserved_cents=reserved_cents,
            reserved_tokens=reserved_tokens,
        )
        s.add(run)
        s.add(ChatMessage(session_id=sid, owner_id=user["id"], role="user", content=data.content))
        session.updated_at = now()
        if not history and session.title == "新对话":
            session.title = data.content.strip()[:40]
        s.flush()
        rid, provider = run.id, c.provider
    return StreamingResponse(
        generate(rid, messages, provider, data.max_tokens, request),
        media_type="text/event-stream",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-store"},
    )


@router.post("/runs/{rid}/stop")
def stop_run(rid: str, user=Depends(current_user)):
    with transaction() as s:
        serialize_security(s)
        run = owned(s, AIRun, rid, user["id"])
        if run.status == "pending":
            run.status, run.finished_at = "cancelled", now()
        elif run.status == "running":
            run.status = "cancel_requested"
        return run_view(run)


@router.post("/sessions/{sid}/recover")
def recover_session(sid: str, user=Depends(current_user)):
    with transaction() as s:
        serialize_security(s)
        current_session(s, sid, user["id"])
        rows = list(s.scalars(select(AIRun).where(AIRun.session_id == sid, AIRun.status.in_(ACTIVE))))
        if any(r.created_at > now() - 180 for r in rows):
            raise HTTPException(409, "Wait at least 180 seconds; the provider request may still be active")
        for run in rows:
            run.status, run.error, run.finished_at = "interrupted", "manual_recovery_unknown_usage", now()
        record(s, user["id"], f"conversation:{sid}", "recover_interrupted_stream")
    return {"status": "recovered", "usage": "unknown; reservation retained", "provider_cancel_guaranteed": False}
