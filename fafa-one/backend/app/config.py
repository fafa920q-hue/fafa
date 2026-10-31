"""Environment-only configuration. No production credentials are stored here."""
import os
from dataclasses import dataclass
from urllib.parse import urlsplit

@dataclass
class Settings:
    database_url: str = os.getenv('DATABASE_URL', 'sqlite:///./fafa-control-center.db')
    secret: str = os.getenv('APP_SECRET', '')
    origin: str = os.getenv('PUBLIC_ORIGIN', 'http://127.0.0.1:5173').rstrip('/')
    secure: bool = os.getenv('COOKIE_SECURE', 'true').lower() == 'true'
    production: bool = os.getenv('APP_ENV', 'production') == 'production'
    require_verified: bool = os.getenv('REQUIRE_VERIFIED_EMAIL', 'true').lower() == 'true'
    session_ttl: int = 43200
    google_id: str = os.getenv('GOOGLE_CLIENT_ID', '')
    google_secret: str = os.getenv('GOOGLE_CLIENT_SECRET', '')
    google_redirect: str = os.getenv('GOOGLE_REDIRECT_URI', '')
    smtp_host: str = os.getenv('SMTP_HOST', '')
    smtp_port: int = int(os.getenv('SMTP_PORT', '587'))
    smtp_user: str = os.getenv('SMTP_USER', '')
    smtp_password: str = os.getenv('SMTP_PASSWORD', '')
    smtp_from: str = os.getenv('SMTP_FROM', '')
    secrets_dir: str = os.getenv('SECRETS_DIR', '/run/secrets')
    agent_url: str = os.getenv('NODE_AGENT_URL', '')
    agent_token_ref: str = os.getenv('NODE_AGENT_TOKEN_REF', 'node_agent_token')
    worker_url: str = os.getenv('CODEX_WORKER_URL', '')
    worker_token_ref: str = os.getenv('CODEX_WORKER_TOKEN_REF', 'codex_worker_token')
    ai_encryption_key: str = os.getenv('AI_KEY_ENCRYPTION_KEY', '')
    surface: str = os.getenv('APP_SURFACE', 'user')

    @property
    def google_configured(self):
        return bool(self.google_id and self.google_secret and self.google_redirect == self.origin + '/api/v1/auth/google/callback')

    def validate(self):
        if len(self.secret) < 32:
            raise RuntimeError('APP_SECRET must contain at least 32 random characters')
        url = urlsplit(self.origin)
        if url.path or url.query or url.fragment or not url.hostname:
            raise RuntimeError('PUBLIC_ORIGIN must be an origin without a path')
        if self.production and (url.scheme != 'https' or not self.secure):
            raise RuntimeError('Production requires HTTPS PUBLIC_ORIGIN and COOKIE_SECURE=true')
        if self.surface not in ('user', 'admin'):
            raise RuntimeError('APP_SURFACE must be user or admin')
        if self.production:
            # This candidate cannot be deployed before the actual legacy schema and
            # the administrator MFA integration have been verified.
            raise RuntimeError('FAFA ONE alpha is not production approved; see docs/RELEASE_GATES.md')

settings = Settings()
