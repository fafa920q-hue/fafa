import base64
import hashlib
import hmac
import secrets
import smtplib
from email.message import EmailMessage
from urllib.parse import urlencode
import httpx
import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from .config import settings
from .database import transaction, serialize_security
from .models import User, Session, Token, OAuthFlow, OAuthIdentity, Setting, now
from .security import (CSRF_COOKIE, SESSION_COOKIE, DUMMY_PASSWORD_HASH, hash_password, verify_password, csrf_value, digest,
                       rate_limit, session_create, revoke_sessions, current_user, user_view, audit)

router = APIRouter(prefix='/api/v1/auth', tags=['Authentication'])
class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=12, max_length=128)
    display_name: str = Field(min_length=1, max_length=80)
    @field_validator('display_name')
    @classmethod
    def not_blank(cls, v):
        if not v.strip(): raise ValueError('Display name must not be blank')
        return v.strip()
class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)
class EmailIn(BaseModel): email: EmailStr
class TokenIn(BaseModel): token: str = Field(min_length=20, max_length=200)
class ResetIn(TokenIn): password: str = Field(min_length=12, max_length=128)

@router.get('/csrf')
def csrf(response: Response):
    value = csrf_value()
    response.set_cookie(CSRF_COOKIE, value, httponly=True, secure=settings.secure, samesite='strict', path='/', max_age=43200)
    response.headers['Cache-Control'] = 'no-store'
    return {'csrf_token':value}

@router.get('/capabilities')
def capabilities():
    return {'google': 'configured' if settings.google_configured else 'not_configured',
            'email': 'configured' if settings.smtp_host and settings.smtp_from else 'not_configured',
            'require_verified_email':settings.require_verified}

@router.get('/me')
def me(user=Depends(current_user)): return user

@router.post('/register')
def register(data:RegisterIn, request:Request):
    rate_limit(request, 'register', 5)
    with transaction() as s:
        flag = s.get(Setting, 'open_registration')
        if flag and not flag.value: raise HTTPException(403, 'Registration closed')
        if s.scalar(select(User.id).where(User.email == str(data.email).lower())):
            raise HTTPException(409, 'Account already exists')
        u = User(email=str(data.email).lower(), display_name=data.display_name, password_hash=hash_password(data.password), role='user')
        s.add(u)
        try: s.flush()
        except IntegrityError: raise HTTPException(409, 'Account already exists')
        uid = u.id
    audit(uid, f'user:{uid}', 'register')
    mail_status = send_token(uid, 'verify')
    return {'status':'registered', 'email_delivery':mail_status}

@router.post('/login')
def login(data:LoginIn, request:Request, response:Response):
    rate_limit(request, 'login', 10)
    with transaction() as s:
        u = s.scalar(select(User).where(User.email == str(data.email).lower()))
        valid = verify_password(data.password, u.password_hash if u else DUMMY_PASSWORD_HASH)
        if not valid or not u or not u.active:
            # Audit after rollback in middleware; no credential is logged.
            raise HTTPException(401, 'Invalid email or password')
        if settings.require_verified and not u.verified: raise HTTPException(403, 'Email verification required')
        if not u.password_hash.startswith('$argon2'): u.password_hash = hash_password(data.password)
        s.execute(delete(Session).where(Session.expires_at <= now()))
        session_create(s, u, response)
        uid = u.id
    audit(uid, f'user:{uid}', 'login')
    return {'status':'authenticated'}

@router.post('/logout')
def logout(request:Request, response:Response):
    with transaction() as s:
        s.execute(delete(Session).where(Session.digest == digest(request.cookies.get(SESSION_COOKIE, ''))))
    response.delete_cookie(SESSION_COOKIE, path='/', secure=settings.secure, httponly=True, samesite='lax')
    return {'status':'logged_out'}

@router.get('/sessions')
def sessions(user=Depends(current_user)):
    with transaction() as s:
        return {'sessions':[{'id':r.digest, 'created_at':r.created_at, 'expires_at':r.expires_at} for r in s.scalars(select(Session).where(Session.user_id==user['id'], Session.expires_at>now()))]}

@router.post('/sessions/revoke-all')
def revoke_all(user=Depends(current_user)):
    with transaction() as s: revoke_sessions(s, user['id'])
    return {'status':'revoked'}

def deliver_email(email, subject, body):
    message = EmailMessage()
    message['From'], message['To'], message['Subject'] = settings.smtp_from, email, subject
    message.set_content(body)
    with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=10) as smtp:
        smtp.starttls()
        if settings.smtp_user: smtp.login(settings.smtp_user, settings.smtp_password)
        smtp.send_message(message)

def send_token(uid, purpose):
    if not settings.smtp_host or not settings.smtp_from: return 'not_configured'
    token = secrets.token_urlsafe(32)
    with transaction() as s:
        s.execute(delete(Token).where(Token.user_id==uid, Token.purpose==purpose))
        s.execute(delete(Token).where(Token.expires_at<=now()))
        s.add(Token(digest=digest(token), user_id=uid, purpose=purpose, expires_at=now()+1800))
        email = s.get(User,uid).email
    try:
        deliver_email(email, 'FAFA account verification' if purpose=='verify' else 'FAFA password reset',
                      f'Open {settings.origin}/#{purpose}={token}\nThis single-use link expires in 30 minutes. Ignore if not requested.')
        return 'sent'
    except Exception:
        with transaction() as s: s.execute(delete(Token).where(Token.digest==digest(token)))
        return 'delivery_failed'

@router.post('/verification/request')
def verification(data:EmailIn, request:Request): return request_token(data, request, 'verify')
@router.post('/password/request')
def password_request(data:EmailIn, request:Request): return request_token(data, request, 'reset')

def request_token(data, request, purpose):
    rate_limit(request, 'email', 5)
    if not settings.smtp_host or not settings.smtp_from: raise HTTPException(503, 'Email delivery not configured')
    with transaction() as s:
        u = s.scalar(select(User).where(User.email==str(data.email).lower(), User.active.is_(True)))
    if u and not (purpose=='verify' and u.verified): send_token(u.id, purpose)
    # Uniform response avoids email enumeration.
    return {'status':'accepted'}

def consume_token(data, purpose):
    with transaction() as s:
        serialize_security(s)
        t = s.get(Token, digest(data.token))
        if not t or t.purpose!=purpose or t.expires_at<=now(): raise HTTPException(400, 'Invalid or expired token')
        u = s.get(User,t.user_id)
        if not u or not u.active: raise HTTPException(400, 'Invalid or expired token')
        if purpose=='verify': u.verified=True
        else:
            u.password_hash=hash_password(data.password)
            revoke_sessions(s,u.id)
        s.delete(t)
        uid=u.id
    audit(uid, f'user:{uid}', purpose)
    return {'status':'complete'}

@router.post('/verification/confirm')
def verify(data:TokenIn): return consume_token(data,'verify')
@router.post('/password/reset')
def reset(data:ResetIn): return consume_token(data,'reset')

@router.get('/google/start')
def google_start(request:Request):
    rate_limit(request,'oauth',10)
    if not settings.google_configured: raise HTTPException(503, 'Google OAuth not configured')
    state, nonce, verifier = [secrets.token_urlsafe(32) for _ in range(3)]
    with transaction() as s:
        s.execute(delete(OAuthFlow).where(OAuthFlow.expires_at<=now()))
        s.add(OAuthFlow(digest=digest(state),nonce=nonce,verifier=verifier,expires_at=now()+600))
    challenge=base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    params={'client_id':settings.google_id,'redirect_uri':settings.google_redirect,'response_type':'code','scope':'openid email profile',
            'state':state,'nonce':nonce,'code_challenge':challenge,'code_challenge_method':'S256'}
    response=RedirectResponse('https://accounts.google.com/o/oauth2/v2/auth?'+urlencode(params),status_code=302)
    response.set_cookie('fafa_oauth',state,max_age=600,httponly=True,secure=settings.secure,samesite='lax',path='/api/v1/auth/google')
    return response

def exchange_google(code, verifier):
    with httpx.Client(timeout=15,follow_redirects=False,trust_env=True) as client:
        r=client.post('https://oauth2.googleapis.com/token',data={'code':code,'client_id':settings.google_id,'client_secret':settings.google_secret,
            'redirect_uri':settings.google_redirect,'grant_type':'authorization_code','code_verifier':verifier})
        r.raise_for_status()
        token=r.json()['id_token']
        jwks=client.get('https://www.googleapis.com/oauth2/v3/certs'); jwks.raise_for_status()
        kid=jwt.get_unverified_header(token).get('kid')
        keys=[k for k in jwks.json()['keys'] if k.get('kid')==kid and k.get('kty')=='RSA']
        if len(keys)!=1: raise ValueError('Unknown signing key')
        key=jwt.PyJWK.from_dict(keys[0]).key
        claims=jwt.decode(token,key,algorithms=['RS256'],audience=settings.google_id,
                          options={'require':['exp','iat','iss','aud','sub','nonce','email','email_verified']})
        if claims['iss'] not in ('https://accounts.google.com','accounts.google.com'): raise ValueError('Invalid issuer')
        return claims

@router.get('/google/callback')
def google_callback(request:Request, state:str='', code:str='', error:str=''):
    if not settings.google_configured: raise HTTPException(503,'Google OAuth not configured')
    if not state or not hmac.compare_digest(state,request.cookies.get('fafa_oauth','')): raise HTTPException(400,'Invalid OAuth state')
    with transaction() as s:
        serialize_security(s)
        flow=s.get(OAuthFlow,digest(state))
        if not flow or flow.expires_at<=now(): raise HTTPException(400,'Expired or reused OAuth state')
        nonce,verifier=flow.nonce,flow.verifier
        s.delete(flow)
    if error or not code: raise HTTPException(400,'OAuth authorization declined')
    try:
        claims=exchange_google(code,verifier)
        if not hmac.compare_digest(claims['nonce'],nonce) or claims['email_verified'] is not True: raise ValueError('Invalid identity')
        email=str(EmailIn(email=claims['email']).email).lower()
    except Exception:
        raise HTTPException(400,'Google identity validation failed')
    response=RedirectResponse(settings.origin+'/#overview',status_code=303)
    with transaction() as s:
        serialize_security(s)
        identity=s.get(OAuthIdentity,claims['sub'])
        u=s.get(User,identity.user_id) if identity else None
        if not identity:
            # Prevent automatic account linking by email; local users must keep their login.
            if s.scalar(select(User.id).where(User.email==email)): raise HTTPException(409,'Email already exists; sign in with your existing account')
            flag=s.get(Setting,'open_registration')
            if flag and not flag.value: raise HTTPException(403,'Registration closed')
            u=User(email=email,display_name=str(claims.get('name','Google user'))[:80],password_hash=hash_password(secrets.token_urlsafe(48)),verified=True)
            s.add(u);s.flush();s.add(OAuthIdentity(subject=claims['sub'],user_id=u.id))
        if not u or not u.active: raise HTTPException(403,'Account disabled')
        session_create(s,u,response);uid=u.id
    response.delete_cookie('fafa_oauth',path='/api/v1/auth/google',secure=settings.secure,httponly=True,samesite='lax')
    audit(uid,f'user:{uid}','google_login')
    return response
