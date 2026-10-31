"""Creates TEST-only data in an explicitly selected, temporary browser-test database."""
import os,secrets
from pathlib import Path
if os.getenv('APP_ENV')!='development' or 'fafa-browser-' not in os.getenv('DATABASE_URL',''):raise SystemExit('Refusing non-test database')
from app.bootstrap import bootstrap
bootstrap('browser-admin@example.com','browser-admin-password-123')
