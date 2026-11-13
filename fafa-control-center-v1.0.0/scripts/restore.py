"""Offline restore to a NEW path; never overwrite an active database."""
import argparse,os,sqlite3
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('backup');p.add_argument('destination');a=p.parse_args()
src=Path(a.backup).resolve();dst=Path(a.destination).resolve()
if not src.is_file() or dst.exists():raise SystemExit('Backup missing or destination exists; restore to a new path')
with sqlite3.connect('file:'+str(src)+'?mode=ro',uri=True) as source:
 if source.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise SystemExit('Invalid backup')
 dst.parent.mkdir(parents=True,exist_ok=True)
 fd=os.open(dst,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
 with sqlite3.connect(dst) as target:source.backup(target)
print('Restored to new path:',dst)
