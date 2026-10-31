import base64
import hashlib
import hmac
import logging
import re
import secrets
from pathlib import Path
from fastapi import Depends, HTTPException, Request, Response
from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, InvalidHashError
from sqlalchemy import delete, select
from .config import settings
from .database import transaction, serialize_security
from .models import User, Role, Session, RateBucket, Audit, now

SESSION_COOKIE = 'fafa_session'
CSRF_COOKIE = 'fafa_csrf'
ph = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=2)
log = logging.getLogger('fafa')

def digest(text): return hashlib.sha256(text.encode()).hexdigest()
def hash_password(password): return ph.hash(password)
def verify_password(password, stored):
    try:
        if stored.startswith('$argon2'):
            return ph.verify(stored, password)
        # Read-only v0.3 compatibility. Successful login upgrades to Argon2id.
        salt, expected = stored.split('$', 1)
        value = hashlib.pbkdf2_hmac('sha256', password.encode(), base64.urlsafe_b64decode(salt), 310000)
        return hmac.compare_digest(value, base64.urlsafe_b64decode(expected))
    except (VerificationError, InvalidHashError, ValueError, TypeError): return False

DUMMY_PASSWORD_HASH = ph.hash(secrets.token_urlsafe(24))

def csrf_value():
    token = secrets.token_urlsafe(32)
    return token + '.' + hmac.new(settings.secret.encode(), token.encode(), hashlib.sha256).hexdigest()

def check_csrf(request):
    origin = request.headers.get('origin')
    if origin and origin != settings.origin:
        raise HTTPException(403, 'Untrusted origin')
    cookie = request.cookies.get(CSRF_COOKIE, '')
    header = request.headers.get('x-csrf-token', '')
    if not cookie or not hmac.compare_digest(cookie, header):
        raise HTTPException(403, 'CSRF token required')
    token, sep, sig = cookie.partition('.')
    expected = hmac.new(settings.secret.encode(), token.encode(), hashlib.sha256).hexdigest()
    if not sep or not hmac.compare_digest(sig, expected):
        raise HTTPException(403, 'Invalid CSRF token')

def session_create(s, user, response):
    token = secrets.token_urlsafe(48)
    s.add(Session(digest=digest(token), user_id=user.id, expires_at=now() + settings.session_ttl))
    response.set_cookie(SESSION_COOKIE, token, max_age=settings.session_ttl, httponly=True, secure=settings.secure, samesite='lax', path='/')
    return token

def revoke_sessions(s, user_id):
    s.execute(delete(Session).where(Session.user_id == user_id))

def user_view(u, modules=None):
    return {k:getattr(u,k) for k in ('id','email','display_name','role','active','verified','grants','monthly_requests','monthly_tokens','budget_cents','created_at')} | {'modules':modules or []}

def current_user(request: Request):
    token = request.cookies.get(SESSION_COOKIE, '')
    with transaction() as s:
        row = s.get(Session, digest(token)) if token else None
        u = s.get(User, row.user_id) if row and row.expires_at > now() else None
        if not u or not u.active:
            raise HTTPException(401, 'Authentication required')
        role = s.get(Role, u.role)
        modules = sorted(set(role.modules + u.grants.get('modules', [])))
        result = user_view(u, modules)
        request.state.user_id = u.id
        return result

def audit(actor, target, action, result='success'):
    with transaction() as s:
        s.add(Audit(actor_id=actor, target=str(target)[:100], action=action[:100], result=result[:32]))

def require_admin(request: Request, user=Depends(current_user)):
    request.state.admin_access = True
    if user['role'] != 'super_admin':
        audit(user['id'], request.url.path, 'admin_access', 'denied')
        raise HTTPException(403, 'Super administrator required')
    return user

def require_module(name):
    def dependency(user=Depends(current_user)):
        if user['role'] != 'super_admin' and name not in user['modules']:
            raise HTTPException(403, f'{name} permission required')
        return user
    return dependency

def allowed(user, kind, resource):
    return user['role'] == 'super_admin' or str(resource) in [str(v) for v in user['grants'].get(kind, [])]

def rate_limit(request, purpose, limit, seconds=900):
    # The socket peer comes from the trusted front proxy; client X-Forwarded-For is never trusted.
    address = request.client.host if request.client else 'unknown'
    key = digest(purpose + ':' + address)
    window = now() // seconds
    denied = False
    with transaction() as s:
        serialize_security(s)
        s.execute(delete(RateBucket).where(RateBucket.window < (now() - 86400) // seconds))
        b = s.get(RateBucket, key)
        if not b: s.add(RateBucket(key=key, window=window, count=1))
        elif b.window != window: b.window, b.count = window, 1
        elif b.count >= limit: denied = True
        else: b.count += 1
    if denied: raise HTTPException(429, 'Rate limit exceeded', headers={'Retry-After':str(seconds)})

def secret_value(ref):
    if not re.fullmatch(r'[a-z][a-z0-9_]{0,63}', ref):
        raise HTTPException(422, 'Invalid secret reference')
    root = Path(settings.secrets_dir).resolve()
    candidate = root / ref
    if candidate.is_symlink() or not candidate.is_file() or candidate.stat().st_size > 16384:
        raise HTTPException(503, 'Secret reference not configured')
    if candidate.resolve().parent != root:
        raise HTTPException(503, 'Secret reference not configured')
    value = candidate.read_text().strip()
    if not value: raise HTTPException(503, 'Secret reference not configured')
    return value

def safe_error(exc):
    # Provider/worker exceptions can contain credentials or user content. Never persist str(exc).
    return type(exc).__name__
