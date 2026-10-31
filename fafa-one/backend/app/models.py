import time
from sqlalchemy import Boolean, CheckConstraint, Column, ForeignKey, Integer, JSON, String, Text, UniqueConstraint
from sqlalchemy.orm import declarative_base

Base = declarative_base()
def now(): return int(time.time())

class Role(Base):
    __tablename__ = 'roles'
    name = Column(String(64), primary_key=True)
    modules = Column(JSON, nullable=False, default=list)

class User(Base):
    __tablename__ = 'users'
    id = Column(Integer, primary_key=True)
    email = Column(String(254), nullable=False, unique=True)
    display_name = Column(String(80), nullable=False)
    password_hash = Column(Text, nullable=False)
    role = Column(String(64), ForeignKey('roles.name'), nullable=False, default='user')
    active = Column(Boolean, nullable=False, default=True)
    verified = Column(Boolean, nullable=False, default=False)
    grants = Column(JSON, nullable=False, default=dict)
    monthly_requests = Column(Integer, nullable=False, default=100)
    monthly_tokens = Column(Integer, nullable=False, default=100000)
    budget_cents = Column(Integer, nullable=False, default=1000)
    created_at = Column(Integer, nullable=False, default=now)
    __table_args__ = (CheckConstraint('monthly_requests >= 0 AND monthly_tokens >= 0 AND budget_cents >= 0'),)

class Session(Base):
    __tablename__ = 'sessions'
    digest = Column(String(64), primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
    expires_at = Column(Integer, nullable=False)
    created_at = Column(Integer, nullable=False, default=now)

class Token(Base):
    __tablename__ = 'auth_tokens'
    digest = Column(String(64), primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    purpose = Column(String(16), nullable=False)
    expires_at = Column(Integer, nullable=False)

class OAuthFlow(Base):
    __tablename__ = 'oauth_flows'
    digest = Column(String(64), primary_key=True)
    nonce = Column(String(100), nullable=False)
    verifier = Column(String(100), nullable=False)
    expires_at = Column(Integer, nullable=False)

class OAuthIdentity(Base):
    __tablename__ = 'oauth_identities'
    subject = Column(String(255), primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False)

class RateBucket(Base):
    __tablename__ = 'rate_buckets'
    key = Column(String(64), primary_key=True)
    window = Column(Integer, nullable=False)
    count = Column(Integer, nullable=False, default=0)

class Audit(Base):
    __tablename__ = 'audit_logs'
    id = Column(Integer, primary_key=True)
    actor_id = Column(Integer, nullable=True)  # retained after account removal
    target = Column(String(100), nullable=False)
    action = Column(String(100), nullable=False)
    result = Column(String(32), nullable=False)
    created_at = Column(Integer, nullable=False, default=now, index=True)

class Lock(Base):
    __tablename__ = 'security_lock'
    id = Column(Integer, primary_key=True)
    value = Column(Integer, nullable=False, default=0)

class Setting(Base):
    __tablename__ = 'settings'
    key = Column(String(64), primary_key=True)
    value = Column(JSON, nullable=False)

class Node(Base):
    __tablename__ = 'nodes'
    id = Column(Integer, primary_key=True)
    name = Column(String(80), nullable=False)
    engine = Column(String(20), nullable=False)
    group = Column(String(80), nullable=False, default='default')
    region = Column(String(80), nullable=False, default='')
    metadata_json = Column(JSON, nullable=False, default=dict)
    agent_ref = Column(String(64), nullable=False)
    enabled = Column(Boolean, nullable=False, default=True)
    health = Column(String(32), nullable=False, default='unknown')
    metrics = Column(JSON, nullable=True)
    latency_ms = Column(Integer, nullable=True)
    last_error = Column(String(250), nullable=True)
    checked_at = Column(Integer, nullable=True)
    version = Column(Integer, nullable=False, default=0)
    __table_args__ = (CheckConstraint("engine IN ('xray','v2ray','sing-box','TEST')"),)

class NodeVersion(Base):
    __tablename__ = 'node_versions'
    id = Column(Integer, primary_key=True)
    node_id = Column(Integer, ForeignKey('nodes.id'), nullable=False)
    version = Column(Integer, nullable=False)
    config = Column(JSON, nullable=False)
    created_at = Column(Integer, nullable=False, default=now)
    __table_args__ = (UniqueConstraint('node_id', 'version'),)

class NodeOperation(Base):
    __tablename__ = 'node_operations'
    id = Column(Integer, primary_key=True)
    node_id = Column(Integer, ForeignKey('nodes.id'), nullable=False)
    actor_id = Column(Integer, nullable=False)
    action = Column(String(24), nullable=False)
    status = Column(String(32), nullable=False)
    attempts = Column(Integer, nullable=False, default=0)
    message = Column(String(250), nullable=True)
    created_at = Column(Integer, nullable=False, default=now)

class AIAccount(Base):
    __tablename__ = 'ai_accounts'
    id = Column(Integer, primary_key=True)
    name = Column(String(80), nullable=False)
    provider = Column(String(20), nullable=False)
    secret_ref = Column(String(64), nullable=False)
    enabled = Column(Boolean, nullable=False, default=True)
    __table_args__ = (CheckConstraint("provider IN ('openai','anthropic','google')"),)

class Model(Base):
    __tablename__ = 'ai_models'
    id = Column(String(100), primary_key=True)
    provider = Column(String(20), nullable=False)
    capabilities = Column(JSON, nullable=False)
    input_cents_per_million = Column(Integer, nullable=True)
    output_cents_per_million = Column(Integer, nullable=True)
    enabled = Column(Boolean, nullable=False, default=True)

class AIRequest(Base):
    __tablename__ = 'ai_requests'
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id'), nullable=False, index=True)
    account_id = Column(Integer, ForeignKey('ai_accounts.id'), nullable=False)
    model_id = Column(String(100), nullable=False)
    fallback_used = Column(Boolean, nullable=False, default=False)
    status = Column(String(32), nullable=False)
    input_tokens = Column(Integer, nullable=True)
    output_tokens = Column(Integer, nullable=True)
    reserved_tokens = Column(Integer, nullable=False, default=0)
    cost_cents = Column(Integer, nullable=True)
    reserved_cents = Column(Integer, nullable=False, default=0)
    error = Column(String(80), nullable=True)
    created_at = Column(Integer, nullable=False, default=now)

class Project(Base):
    __tablename__ = 'projects'
    id = Column(Integer, primary_key=True)
    owner_id = Column(Integer, ForeignKey('users.id'), nullable=False)
    name = Column(String(100), nullable=False)
    repository = Column(String(255), nullable=False)
    created_at = Column(Integer, nullable=False, default=now)

class Task(Base):
    __tablename__ = 'tasks'
    id = Column(Integer, primary_key=True)
    owner_id = Column(Integer, ForeignKey('users.id'), nullable=False)
    project_id = Column(Integer, ForeignKey('projects.id'), nullable=False)
    prompt = Column(Text, nullable=False)
    status = Column(String(32), nullable=False, default='pending_approval', index=True)
    approved_by = Column(Integer, nullable=True)
    timeout_seconds = Column(Integer, nullable=False, default=300)
    attempts = Column(Integer, nullable=False, default=0)
    remote_id = Column(String(100), nullable=True)
    logs = Column(Text, nullable=False, default='')
    changes = Column(JSON, nullable=False, default=list)
    diff = Column(Text, nullable=False, default='')
    tests = Column(JSON, nullable=True)
    error = Column(String(250), nullable=True)
    created_at = Column(Integer, nullable=False, default=now)
    started_at = Column(Integer, nullable=True)
    finished_at = Column(Integer, nullable=True)
    __table_args__ = (CheckConstraint('timeout_seconds BETWEEN 30 AND 3600'),)

# V2 personal API connections are intentionally separate from administrator-owned
# AIAccount, platform login identities and device-local CLI credentials.
class AIConnection(Base):
    __tablename__ = 'ai_connections'
    id = Column(Integer, primary_key=True)
    owner_id = Column(Integer, ForeignKey('users.id'), nullable=False, index=True)
    provider = Column(String(20), nullable=False)
    name = Column(String(80), nullable=False)
    encrypted_key = Column(Text, nullable=False)
    is_default = Column(Boolean, nullable=False, default=False)
    budget_cents = Column(Integer, nullable=False, default=1000)
    status = Column(String(24), nullable=False, default='untested')
    models = Column(JSON, nullable=False, default=list)
    tested_at = Column(Integer, nullable=True)
    revoked_at = Column(Integer, nullable=True)
    deleted_at = Column(Integer, nullable=True)
    created_at = Column(Integer, nullable=False, default=now)
    __table_args__ = (CheckConstraint("provider IN ('openai','anthropic','google')"), CheckConstraint('budget_cents >= 0'))

class ChatSession(Base):
    __tablename__ = 'chat_sessions'
    id = Column(String(36), primary_key=True)
    owner_id = Column(Integer, ForeignKey('users.id'), nullable=False, index=True)
    title = Column(String(100), nullable=False, default='新对话')
    created_at = Column(Integer, nullable=False, default=now)
    updated_at = Column(Integer, nullable=False, default=now, index=True)
    archived_at = Column(Integer, nullable=True)

class ChatMessage(Base):
    __tablename__ = 'chat_messages'
    id = Column(Integer, primary_key=True)
    session_id = Column(String(36), ForeignKey('chat_sessions.id'), nullable=False, index=True)
    owner_id = Column(Integer, ForeignKey('users.id'), nullable=False, index=True)
    role = Column(String(12), nullable=False)
    content = Column(Text, nullable=False)
    created_at = Column(Integer, nullable=False, default=now)

class AIRun(Base):
    __tablename__ = 'ai_runs'
    id = Column(String(36), primary_key=True)
    owner_id = Column(Integer, ForeignKey('users.id'), nullable=False, index=True)
    session_id = Column(String(36), ForeignKey('chat_sessions.id'), nullable=False, index=True)
    connection_id = Column(Integer, ForeignKey('ai_connections.id'), nullable=False, index=True)
    model_id = Column(String(100), nullable=False)
    status = Column(String(24), nullable=False, default='pending')
    input_price = Column(Integer, nullable=False)
    output_price = Column(Integer, nullable=False)
    reserved_cents = Column(Integer, nullable=False)
    reserved_tokens = Column(Integer, nullable=False)
    input_tokens = Column(Integer, nullable=True)
    output_tokens = Column(Integer, nullable=True)
    cost_cents = Column(Integer, nullable=True)
    error = Column(String(80), nullable=True)
    created_at = Column(Integer, nullable=False, default=now)
    finished_at = Column(Integer, nullable=True)
