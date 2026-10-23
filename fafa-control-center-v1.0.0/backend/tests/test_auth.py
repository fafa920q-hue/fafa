import concurrent.futures
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select,update
from app.main import app
from app.config import settings
from app.database import transaction
from app.models import User,Session,Audit,now
from app.bootstrap import bootstrap
from app.security import hash_password,verify_password,digest
from conftest import create_user

PREFIX='/api/v1'
def test_password_hash():
    value=hash_password('long-test-password-123')
    assert value.startswith('$argon2id$')
    assert verify_password('long-test-password-123',value)
    assert not verify_password('wrong',value)
    assert not verify_password('test','malformed')
def test_register_never_elevates(regular):
    u=regular.get(PREFIX+'/auth/me').json()
    assert u['role']=='user' and u['modules']==[] and u['grants']=={}
    assert regular.patch(PREFIX+'/admin/users/'+str(u['id']),json={'role':'super_admin'}).status_code==403
    assert regular.patch(PREFIX+'/auth/me',json={'role':'super_admin'}).status_code==405
@pytest.mark.parametrize('path',['/admin/users','/admin/roles','/admin/security','/admin/audit','/admin/operations','/admin/openapi'])
def test_admin_read_forbidden(regular,path):assert regular.get(PREFIX+path).status_code==403
@pytest.mark.parametrize('path,method,body',[
('/admin/roles','put',{'name':'boss','modules':['ai']}),('/admin/security','put',{'open_registration':False}),
('/admin/users/1','patch',{'active':False}),('/admin/users/1/disable','post',{}),('/admin/users/1/restore','post',{}),
('/nodes','post',{'name':'x'}),('/ai/accounts','post',{'name':'x'}),('/ai/models','put',{'id':'x'}),('/codex/tasks/1/approve','post',{})])
def test_privileged_mutations_forbidden(regular,path,method,body):assert getattr(regular,method)(PREFIX+path,json=body).status_code==403
@pytest.mark.parametrize('module',['nodes','ai/catalog','codex/projects'])
def test_default_modules_forbidden(regular,module):assert regular.get(PREFIX+'/'+module).status_code==403

def test_csrf_and_origin(client):
    body={'email':'x@example.com','password':'long-test-password','display_name':'X'}
    client.headers.pop('X-CSRF-Token')
    assert client.post(PREFIX+'/auth/register',json=body).status_code==403
    client.headers['X-CSRF-Token']=client.get(PREFIX+'/auth/csrf').json()['csrf_token']
    assert client.post(PREFIX+'/auth/register',json=body,headers={'Origin':'https://evil.example'}).status_code==403
    client.headers['X-CSRF-Token']='forged'
    assert client.post(PREFIX+'/auth/login',json=body).status_code==403

def test_rate_limit_login(client):
    body={'email':'missing@example.com','password':'invalid'}
    for _ in range(10):assert client.post(PREFIX+'/auth/login',json=body).status_code==401
    assert client.post(PREFIX+'/auth/login',json=body).status_code==429

def test_registration_limit(client):
    for i in range(5):assert client.post(PREFIX+'/auth/register',json={'email':f'p{i}@example.com','password':'test-password-123','display_name':'P'}).status_code==200
    assert client.post(PREFIX+'/auth/register',json={'email':'extra@example.com','password':'test-password-123','display_name':'P'}).status_code==429

def test_logout_revokes_stolen_cookie(regular):
    stolen=regular.cookies.get('fafa_session')
    assert regular.post(PREFIX+'/auth/logout').status_code==200
    with TestClient(app) as attacker:
        attacker.cookies.set('fafa_session',stolen)
        assert attacker.get(PREFIX+'/auth/me').status_code==401

def test_session_expiry(regular):
    with transaction() as s:s.execute(update(Session).values(expires_at=now()-1))
    assert regular.get(PREFIX+'/auth/me').status_code==401

def test_revoke_all(regular):
    assert regular.post(PREFIX+'/auth/sessions/revoke-all').status_code==200
    assert regular.get(PREFIX+'/auth/me').status_code==401

def test_superadmin_list_search_pagination(admin):
    create_user('wanted@example.com');create_user('other@example.com')
    r=admin.get(PREFIX+'/admin/users?q=wanted&page_size=1').json()
    assert r['total']==1 and r['users'][0]['email']=='wanted@example.com'
    assert 'password_hash' not in str(r)

def test_last_admin_protection_and_audit(admin):
    uid=admin.get(PREFIX+'/auth/me').json()['id']
    assert admin.patch(PREFIX+'/admin/users/'+str(uid),json={'active':False}).status_code==409
    assert admin.patch(PREFIX+'/admin/users/'+str(uid),json={'role':'user'}).status_code==409
    assert admin.get(PREFIX+'/auth/me').status_code==200
    logs=admin.get(PREFIX+'/admin/audit').json()['logs']
    assert any(l['result']=='denied' and l['actor_id']==uid for l in logs)

def test_second_admin_can_be_demoted(admin):
    uid=create_user('second@example.com','super_admin')
    assert admin.patch(PREFIX+'/admin/users/'+str(uid),json={'role':'user'}).status_code==200
    with transaction() as s:assert s.get(User,uid).role=='user'

def test_disable_restore_invalidates_old_sessions(admin):
    uid=create_user()
    with TestClient(app) as other:
        other.headers['X-CSRF-Token']=other.get(PREFIX+'/auth/csrf').json()['csrf_token']
        assert other.post(PREFIX+'/auth/login',json={'email':'other@example.com','password':'test-user-password-123'}).status_code==200
        assert admin.post(f'{PREFIX}/admin/users/{uid}/disable').status_code==200
        assert other.get(PREFIX+'/auth/me').status_code==401
        assert other.post(PREFIX+'/auth/login',json={'email':'other@example.com','password':'test-user-password-123'}).status_code==401
        assert admin.post(f'{PREFIX}/admin/users/{uid}/restore').status_code==200
        assert other.get(PREFIX+'/auth/me').status_code==401
        assert other.post(PREFIX+'/auth/login',json={'email':'other@example.com','password':'test-user-password-123'}).status_code==200

def test_roles_and_permissions(admin):
    assert admin.put(PREFIX+'/admin/roles',json={'name':'operator','modules':['nodes']}).status_code==200
    assert admin.put(PREFIX+'/admin/roles',json={'name':'user','modules':['ai']}).status_code==409
    assert admin.put(PREFIX+'/admin/roles',json={'name':'bad','modules':['admin']}).status_code==422
    uid=create_user()
    assert admin.patch(f'{PREFIX}/admin/users/{uid}',json={'role':'operator','grants':{'modules':['codex'],'accounts':[],'models':[],'nodes':[]}}).status_code==200

def test_bootstrap_once_and_no_public_promotion(client):
    create_user('taken@example.com')
    with pytest.raises(ValueError):bootstrap('taken@example.com','test-password-123')
    bootstrap('first@example.com','test-password-123')
    with pytest.raises(ValueError):bootstrap('second@example.com','test-password-123')

def test_cookie_properties(regular,monkeypatch):
    monkeypatch.setattr(settings,'secure',True)
    # Existing development cookie can be sent; response attributes must harden production cookie.
    r=regular.post(PREFIX+'/auth/login',json={'email':'person@example.com','password':'test-person-password-123'})
    cookie=r.headers['set-cookie'].lower()
    assert 'httponly' in cookie and 'secure' in cookie and 'samesite=lax' in cookie

def test_verified_required(regular,monkeypatch):
    monkeypatch.setattr(settings,'require_verified',True)
    assert regular.post(PREFIX+'/auth/login',json={'email':'person@example.com','password':'test-person-password-123'}).status_code==403

def test_close_registration(admin):
    assert admin.put(PREFIX+'/admin/security',json={'open_registration':False}).status_code==200
    assert admin.post(PREFIX+'/auth/register',json={'email':'closed@example.com','password':'test-password-123','display_name':'P'}).status_code==403

def test_validation_never_echoes_password(client):
    r=client.post(PREFIX+'/auth/register',json={'email':'invalid','password':'TEST_SHORT','display_name':'T'})
    assert r.status_code==422 and 'TEST_SHORT' not in r.text

def test_concurrent_last_admin_changes(admin):
    from app.admin import update_user,UserUpdate
    uid=admin.get(PREFIX+'/auth/me').json()['id'];second=create_user('second@example.com','super_admin')
    def demote(target):
        try:return update_user(target,UserUpdate(role='user'),{'id':uid})
        except Exception as e:return getattr(e,'status_code',500)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        result=list(pool.map(demote,[uid,second]))
    with transaction() as s:
        assert len(list(s.scalars(select(User).where(User.role=='super_admin',User.active.is_(True)))))==1
    assert sum(isinstance(r,dict) for r in result)==1 and 409 in result

def test_custom_role_grants_module_without_admin(admin):
    admin.put(PREFIX+'/admin/roles',json={'name':'operator','modules':['nodes']})
    uid=create_user('operator@example.com','operator')
    assert admin.post(PREFIX+'/auth/login',json={'email':'operator@example.com','password':'test-user-password-123'}).status_code==200
    assert admin.get(PREFIX+'/auth/me').json()['modules']==['nodes']
    assert admin.get(PREFIX+'/nodes').status_code==200
    assert admin.get(PREFIX+'/admin/users').status_code==403
