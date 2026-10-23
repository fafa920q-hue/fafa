"""Deterministic source-only ZIP with content hashes, inventory and post-read validation."""
import argparse,hashlib,json,re,stat,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
EXCLUDED={'.git','.venv','node_modules','dist','__pycache__','.pytest_cache','.cache','test-results','playwright-report','backups','secrets','htmlcov','.mypy_cache','.ruff_cache'}
EXACT={'.env','.coverage','.DS_Store'}
SUFFIXES={'.pyc','.pyo','.db','.sqlite','.sqlite3','.log','.tsbuildinfo','.pem','.key','.zip'}
PATTERNS=[re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),re.compile(r'\bsk-[A-Za-z0-9]{20,}\b'),re.compile(r'\bAIza[A-Za-z0-9_-]{30,}\b'),re.compile(r'\bgh[pousr]_[A-Za-z0-9]{30,}\b'),re.compile(r'\bAKIA[A-Z0-9]{16}\b')]

def source_files():
    for p in sorted(ROOT.rglob('*')):
        rel=p.relative_to(ROOT)
        if any(x in EXCLUDED for x in rel.parts) or p.name in EXACT or p.suffix in SUFFIXES:continue
        if p.name.startswith('.env') and p.name!='.env.example':continue
        if p.is_symlink():raise RuntimeError('Symlink not allowed: '+str(rel))
        if p.is_file() and p.name not in {'ARCHIVE_FILES.txt','SHA256SUMS.txt'}:yield p

def scan(files):
    for p in files:
        raw=p.read_bytes()
        try:content=raw.decode('utf-8')
        except UnicodeDecodeError:continue
        for pattern in PATTERNS:
            if pattern.search(content):raise RuntimeError('Sensitive credential pattern: '+str(p.relative_to(ROOT)))
    return {'status':'PASS','scanned_files':len(files),'excluded':'dependencies, builds, caches, env, databases, logs, credentials','note':'Pattern scan plus source review; not proof that every arbitrary secret can be detected.'}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('destination',type=Path);parser.add_argument('--scan-only',action='store_true');args=parser.parse_args()
    files=list(source_files());result=scan(files)
    if args.scan_only:print(json.dumps(result));return
    sums=''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+str(p.relative_to(ROOT))+'\n' for p in files)
    (ROOT/'SHA256SUMS.txt').write_text(sums)
    names=[str(p.relative_to(ROOT)) for p in files]+['SHA256SUMS.txt','ARCHIVE_FILES.txt']
    (ROOT/'ARCHIVE_FILES.txt').write_text('\n'.join(sorted(names))+'\n')
    files+= [ROOT/'SHA256SUMS.txt',ROOT/'ARCHIVE_FILES.txt']
    args.destination.parent.mkdir(parents=True,exist_ok=True)
    prefix='fafa-control-center-v1.0.0/'
    with zipfile.ZipFile(args.destination,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for p in sorted(files):
            name=prefix+str(p.relative_to(ROOT));info=zipfile.ZipInfo(name,date_time=(2026,10,23,0,0,0))
            info.compress_type=zipfile.ZIP_DEFLATED;info.create_system=3
            mode=0o755 if p.suffix=='.sh' else 0o644
            info.external_attr=(stat.S_IFREG|mode)<<16
            z.writestr(info,p.read_bytes())
    with zipfile.ZipFile(args.destination) as z:
        assert z.testzip() is None
        assert sorted(z.namelist())==sorted(prefix+n for n in names)
        for line in z.read(prefix+'SHA256SUMS.txt').decode().splitlines():
            expected,name=line.split('  ',1);assert hashlib.sha256(z.read(prefix+name)).hexdigest()==expected
        for name in z.namelist():
            path=Path(name)
            assert not path.is_absolute() and '..' not in path.parts
            assert not any(part in EXCLUDED for part in path.parts)
    print(json.dumps(result|{'archive':str(args.destination),'bytes':args.destination.stat().st_size,'files':len(names),'sha256':hashlib.sha256(args.destination.read_bytes()).hexdigest(),'integrity':'PASS','inventory':'ARCHIVE_FILES.txt'}))
if __name__=='__main__':main()
