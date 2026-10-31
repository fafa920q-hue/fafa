"""Authenticated encryption with per-user/per-connection associated data.

Encryption key lives in the deployment secret store, independently of APP_SECRET.
Rotation and recovery require retaining this key alongside encrypted backups.
"""

import base64
import binascii
import secrets

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException

from ..config import settings


def cipher():
    try:
        key = base64.b64decode(settings.ai_encryption_key, altchars=b"-_", validate=True)
        if len(key) != 32:
            raise ValueError("length")
    except (ValueError, binascii.Error):
        raise HTTPException(503, "Personal AI encryption key not configured") from None
    return AESGCM(key)


def aad(owner_id, connection_id):
    return f"fafa-one:ai-connection:v1:{owner_id}:{connection_id}".encode()


def seal(plaintext, owner_id, connection_id):
    nonce = secrets.token_bytes(12)
    encrypted = cipher().encrypt(nonce, plaintext.encode(), aad(owner_id, connection_id))
    return "v1:" + base64.urlsafe_b64encode(nonce + encrypted).decode()


def unseal(value, owner_id, connection_id):
    aes = cipher()
    try:
        if not value.startswith("v1:"):
            raise ValueError("version")
        data = base64.b64decode(value[3:], altchars=b"-_", validate=True)
        return aes.decrypt(data[:12], data[12:], aad(owner_id, connection_id)).decode()
    except Exception:
        raise HTTPException(503, "Connection credential could not be decrypted") from None
