from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator
from sqlalchemy import func, select

from ..admin import record
from ..database import serialize_security, transaction
from ..models import AIConnection, AIRun, now
from ..security import current_user, rate_limit
from . import providers, vault

router = APIRouter(prefix="/api/v2", tags=["Personal AI"])


class ConnectionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)
    provider: str = Field(pattern="^(openai|anthropic|google)$")
    api_key: SecretStr = Field(min_length=8, max_length=4096)
    budget_cents: int = Field(default=1000, ge=0, le=10_000_000)

    @field_validator("name")
    @classmethod
    def name_not_blank(cls, value):
        if not value.strip():
            raise ValueError("Name cannot be blank")
        return value.strip()


class ConnectionEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)
    budget_cents: int = Field(ge=0, le=10_000_000)


def owned(s, model, resource_id, uid):
    row = s.get(model, resource_id)
    if not row or row.owner_id != uid:
        raise HTTPException(404, "Resource not found")
    return row


def view(connection):
    return {
        k: getattr(connection, k)
        for k in (
            "id",
            "name",
            "provider",
            "is_default",
            "budget_cents",
            "status",
            "models",
            "tested_at",
            "revoked_at",
            "created_at",
        )
    } | {
        "connection_type": "personal_api",
        "provider_remaining_quota": None,
        "credential_exportable": False,
        "billing_currency": "USD",
    }


@router.get("/capabilities")
def capabilities(user=Depends(current_user)):
    return {
        "version": "2.0.0-alpha.1",
        "personal_api": True,
        "chat_streaming": True,
        "cli_device_authorization": "not_implemented",
        "attachments": "not_implemented",
        "google_oauth": "see /api/v1/auth/capabilities",
        "wechat": "not_configured",
        "qq": "not_configured",
        "account_types": ["platform_identity", "personal_api", "device_cli", "authorized_platform_service"],
        "costs": "reviewed model pricing and provider usage; not a provider invoice",
    }


@router.get("/connections")
def list_connections(user=Depends(current_user)):
    with transaction() as s:
        return {
            "connections": [
                view(c)
                for c in s.scalars(
                    select(AIConnection)
                    .where(AIConnection.owner_id == user["id"], AIConnection.deleted_at.is_(None))
                    .order_by(AIConnection.id)
                )
            ]
        }


@router.post("/connections", status_code=201)
def create_connection(data: ConnectionIn, request: Request, user=Depends(current_user)):
    rate_limit(request, "connection:" + str(user["id"]), 20, 60)
    vault.cipher()  # Fail before any write when the separate encryption key is absent.
    with transaction() as s:
        serialize_security(s)
        count = s.scalar(
            select(func.count())
            .select_from(AIConnection)
            .where(AIConnection.owner_id == user["id"], AIConnection.deleted_at.is_(None))
        )
        if count >= 30:
            raise HTTPException(409, "Connection limit reached")
        default = not s.scalar(
            select(AIConnection.id).where(
                AIConnection.owner_id == user["id"],
                AIConnection.is_default.is_(True),
                AIConnection.revoked_at.is_(None),
            )
        )
        c = AIConnection(
            owner_id=user["id"],
            provider=data.provider,
            name=data.name,
            encrypted_key="",
            is_default=default,
            budget_cents=data.budget_cents,
        )
        s.add(c)
        s.flush()
        c.encrypted_key = vault.seal(data.api_key.get_secret_value(), user["id"], c.id)
        record(s, user["id"], f"connection:{c.id}", "personal_ai_create")
        return view(c)


@router.patch("/connections/{cid}")
def edit_connection(cid: int, data: ConnectionEdit, user=Depends(current_user)):
    if not data.name.strip():
        raise HTTPException(422, "Name cannot be blank")
    with transaction() as s:
        serialize_security(s)
        c = owned(s, AIConnection, cid, user["id"])
        if c.deleted_at:
            raise HTTPException(404, "Resource not found")
        c.name, c.budget_cents = data.name.strip(), data.budget_cents
        record(s, user["id"], f"connection:{c.id}", "personal_ai_edit")
        return view(c)


@router.post("/connections/{cid}/default")
def set_default(cid: int, user=Depends(current_user)):
    with transaction() as s:
        serialize_security(s)
        c = owned(s, AIConnection, cid, user["id"])
        if c.revoked_at or c.deleted_at:
            raise HTTPException(409, "Connection is revoked")
        for item in s.scalars(select(AIConnection).where(AIConnection.owner_id == user["id"])):
            item.is_default = item.id == cid
        record(s, user["id"], f"connection:{cid}", "personal_ai_default")
    return {"status": "saved", "connection_id": cid, "running_tasks_changed": False}


@router.post("/connections/{cid}/test")
async def test_connection(cid: int, request: Request, user=Depends(current_user)):
    rate_limit(request, "connection_test:" + str(user["id"]), 10, 60)
    with transaction() as s:
        c = owned(s, AIConnection, cid, user["id"])
        if c.revoked_at or c.deleted_at:
            raise HTTPException(409, "Connection is revoked")
        key = vault.unseal(c.encrypted_key, user["id"], cid)
        provider = c.provider
    error = None
    try:
        models = await providers.available_models(provider, key)
    except Exception:
        # Do not expose upstream bodies, key substrings or exception messages.
        models, error = [], "Official provider connection check failed"
    finally:
        key = None
    with transaction() as s:
        serialize_security(s)
        c = owned(s, AIConnection, cid, user["id"])
        if c.revoked_at or c.deleted_at:
            raise HTTPException(409, "Connection was revoked during check")
        c.status, c.models, c.tested_at = ("check_failed" if error else "ready"), models, now()
        record(s, user["id"], f"connection:{cid}", "personal_ai_test", "failed" if error else "success")
        result = view(c)
    return result | {"error": error, "check_scope": "official model listing; generation not verified"}


def revoke(cid, uid, delete=False):
    with transaction() as s:
        serialize_security(s)
        c = owned(s, AIConnection, cid, uid)
        c.revoked_at, c.is_default, c.status, c.encrypted_key = now(), False, "revoked", ""
        if delete:
            c.deleted_at = now()
            c.name, c.models = "Deleted connection", []
        for run in s.scalars(select(AIRun).where(AIRun.connection_id == cid, AIRun.status.in_(["pending", "running"]))):
            run.status = "cancel_requested"
        record(s, uid, f"connection:{cid}", "personal_ai_delete" if delete else "personal_ai_revoke")
    return {
        "status": "deleted" if delete else "revoked",
        "provider_key_revoked": False,
        "notice": "This removes FAFA access. Revoke the API key with its provider separately.",
    }


@router.post("/connections/{cid}/revoke")
def revoke_connection(cid: int, user=Depends(current_user)):
    return revoke(cid, user["id"])


@router.delete("/connections/{cid}")
def delete_connection(cid: int, user=Depends(current_user)):
    return revoke(cid, user["id"], delete=True)
