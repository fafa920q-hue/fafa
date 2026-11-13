"""Consistent SQLite backup. PostgreSQL operators should use pg_dump (see manual)."""
import argparse,os,sqlite3
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('database');p.add_argument('destination');a=p.parse_args()
src=Path(a.database).resolve();dst=Path(a.destination).resolve()
if src==dst or not src.is_file() or dst.exists():raise SystemExit('Source missing or destination already exists')
dst.parent.mkdir(parents=True,exist_ok=True)
fd=os.open(dst,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
try:
 with sqlite3.connect('file:'+str(src)+'?mode=ro',uri=True) as source,sqlite3.connect(dst) as target:
  source.backup(target)
  if target.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise RuntimeError('Backup integrity failure')
except BaseException:
 dst.unlink(missing_ok=True);raise
print('Verified backup created:',dst)
