"""One-time, local administrator provisioning. Never exposed as an HTTP endpoint."""
import argparse
import getpass
from sqlalchemy import select
from email_validator import validate_email
from .database import transaction, serialize_security
from .models import User, Audit
from .security import hash_password

def bootstrap(email, password):
    email = validate_email(email, check_deliverability=False).normalized.lower()
    if not 12 <= len(password) <= 128:
        raise ValueError('Password must be 12–128 characters')
    with transaction() as s:
        serialize_security(s)
        if s.scalar(select(User.id).where(User.role == 'super_admin')):
            raise ValueError('Bootstrap already completed; use an existing administrator')
        if s.scalar(select(User.id).where(User.email == email)):
            raise ValueError('Email already registered; bootstrap will not promote a public account')
        u = User(email=email, display_name='Super Admin', password_hash=hash_password(password), role='super_admin', verified=True)
        s.add(u); s.flush()
        s.add(Audit(actor_id=u.id, target=f'user:{u.id}', action='bootstrap', result='success'))
        return u.id

if __name__ == '__main__':
    p = argparse.ArgumentParser(); p.add_argument('--email', required=True)
    a = p.parse_args(); first = getpass.getpass('New administrator password: ')
    if first != getpass.getpass('Repeat password: '):
        raise SystemExit('Passwords do not match')
    print('Created administrator', bootstrap(a.email, first))
