import time
from urllib.parse import urlparse,parse_qs
import pytest,jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from app import auth
from app.config import settings
from app.database import transaction
from app.models import User,Token
from app.security import digest
from conftest import create_user
P='/api/v1/auth'

def test_email_unconfigured(client):
    assert client.post(P+'/password/request',json={'email':'nobody@example.com'}).status_code==503

def test_email_verification_reset_single_use(regular,monkeypatch):
    messages=[];monkeypatch.setattr(settings,'smtp_host','TEST');monkeypatch.setattr(settings,'smtp_from','test@example.com')
    monkeypatch.setattr(auth,'deliver_email',lambda *args:messages.append(args))
    assert regular.post(P+'/verification/request',json={'email':'person@example.com'}).status_code==200
    token=messages[-1][2].split('#verify=')[1].split()[0]
    assert regular.post(P+'/verification/confirm',json={'token':token}).status_code==200
    assert regular.post(P+'/verification/confirm',json={'token':token}).status_code==400
    assert regular.get(P+'/me').json()['verified'] is True
    assert regular.post(P+'/password/request',json={'email':'person@example.com'}).status_code==200
    token=messages[-1][2].split('#reset=')[1].split()[0]
    assert regular.post(P+'/password/reset',json={'token':token,'password':'new-test-password-123'}).status_code==200
    assert regular.get(P+'/me').status_code==401
    assert regular.post(P+'/password/reset',json={'token':token,'password':'new-test-password-123'}).status_code==400
    assert regular.post(P+'/login',json={'email':'person@example.com','password':'new-test-password-123'}).status_code==200

def test_oauth_unconfigured(client):assert client.get(P+'/google/start').status_code==503
@pytest.fixture
def google(monkeypatch):
    monkeypatch.setattr(settings,'google_id','TEST_CLIENT');monkeypatch.setattr(settings,'google_secret','TEST_SECRET')
    monkeypatch.setattr(settings,'google_redirect',settings.origin+'/api/v1/auth/google/callback')

def flow(client):
    r=client.get(P+'/google/start',follow_redirects=False);assert r.status_code==302
    return {k:v[0] for k,v in parse_qs(urlparse(r.headers['location']).query).items()}

def test_google_mock_callback_state_nonce_replay(client,google,monkeypatch):
    f=flow(client)
    assert f['code_challenge_method']=='S256'
    monkeypatch.setattr(auth,'exchange_google',lambda code,verifier:{'sub':'TEST_GOOGLE_SUB','email':'google@example.com','email_verified':True,'nonce':f['nonce'],'name':'Google test'})
    assert client.get(P+'/google/callback?state=evil&code=TEST').status_code==400
    r=client.get(P+'/google/callback?state='+f['state']+'&code=TEST',follow_redirects=False)
    assert r.status_code==303 and client.get(P+'/me').json()['role']=='user'
    assert client.get(P+'/google/callback?state='+f['state']+'&code=TEST',follow_redirects=False).status_code==400

@pytest.mark.parametrize('bad', ['nonce','email_verified'])
def test_google_identity_rejected(client,google,monkeypatch,bad):
    f=flow(client);claims={'sub':'TEST_SUB','email':'google@example.com','email_verified':True,'nonce':f['nonce']}
    claims[bad]='bad' if bad=='nonce' else False
    monkeypatch.setattr(auth,'exchange_google',lambda *args:claims)
    assert client.get(P+'/google/callback?state='+f['state']+'&code=TEST',follow_redirects=False).status_code==400

def test_callback_redirect_configuration(client,google,monkeypatch):
    monkeypatch.setattr(settings,'google_redirect','https://evil.example/callback')
    assert client.get(P+'/google/start').status_code==503

def test_google_cannot_link_existing_email(client,google,monkeypatch):
    create_user('existing@example.com');f=flow(client)
    monkeypatch.setattr(auth,'exchange_google',lambda *args:{'sub':'TEST','email':'existing@example.com','email_verified':True,'nonce':f['nonce']})
    assert client.get(P+'/google/callback?state='+f['state']+'&code=TEST',follow_redirects=False).status_code==409

@pytest.mark.parametrize('variant',['valid','bad_audience','expired','bad_issuer','bad_signature','bad_crit'])
def test_google_jwt_verification(client,google,monkeypatch,variant):
    key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    jwk=jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key(),as_dict=True)|{'kid':'TEST_KEY'}
    claims={'sub':'TEST','email':'g@example.com','email_verified':True,'nonce':'TEST_NONCE','iss':'https://accounts.google.com','aud':settings.google_id,'iat':int(time.time()),'exp':int(time.time())+300}
    if variant=='bad_audience':claims['aud']='WRONG'
    if variant=='expired':claims['exp']=int(time.time())-100
    if variant=='bad_issuer':claims['iss']='https://evil.example'
    signing=rsa.generate_private_key(public_exponent=65537,key_size=2048) if variant=='bad_signature' else key
    token=jwt.encode(claims,signing,algorithm='RS256',headers={'kid':'TEST_KEY',**({'crit':['TEST_UNSUPPORTED_EXTENSION']} if variant=='bad_crit' else {})})
    class Response:
        def __init__(self,data):self.data=data
        def raise_for_status(self):pass
        def json(self):return self.data
    class MockClient:
        def __init__(self,**kwargs):pass
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def post(self,*args,**kwargs):return Response({'id_token':token})
        def get(self,*args,**kwargs):return Response({'keys':[jwk]})
    monkeypatch.setattr(auth.httpx,'Client',MockClient)
    if variant=='valid':assert auth.exchange_google('TEST_CODE','TEST_VERIFIER')['sub']=='TEST'
    else:
        with pytest.raises(Exception):auth.exchange_google('TEST_CODE','TEST_VERIFIER')
