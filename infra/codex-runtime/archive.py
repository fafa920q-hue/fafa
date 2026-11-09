"""Fetch one approved public GitHub snapshot and unpack regular files only."""
import pathlib
import re
import stat
import sys
import urllib.request
import zipfile

LIMIT = 24 * 1024 * 1024

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def download(owner, repo, sha, workspace, archive):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}", owner):
        raise ValueError("owner")
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}", repo):
        raise ValueError("repo")
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise ValueError("sha")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
    url = f"https://codeload.github.com/{owner}/{repo}/zip/{sha}"
    with opener.open(url, timeout=15) as response, archive.open("xb") as out:
        size = 0
        while chunk := response.read(65536):
            size += len(chunk)
            if size > LIMIT:
                raise ValueError("archive limit")
            out.write(chunk)
    unpack(archive, workspace)

def unpack(archive, workspace):
    size = 0
    with zipfile.ZipFile(archive) as src:
        entries = src.infolist()
        if len(entries) > 4000:
            raise ValueError("file count limit")
        for member in entries:
            parts = member.filename.rstrip("/").split("/")
            if any(x in ("", ".", "..") or "\\" in x or len(x) > 200 for x in parts):
                raise ValueError("archive path")
            mode = stat.S_IFMT(member.external_attr >> 16)
            if mode not in (0, stat.S_IFREG, stat.S_IFDIR):
                raise ValueError("unsupported archive entry")
            rel = parts[1:]
            if member.is_dir() or not rel or any(x.startswith(".") for x in rel):
                continue
            if rel[-1].endswith((".pem", ".key", ".p12")):
                continue
            size += member.file_size
            if size > LIMIT or member.file_size > 2 * 1024 * 1024:
                raise ValueError("workspace size limit")
            dest = workspace.joinpath(*rel)
            dest.parent.mkdir(parents=True, exist_ok=True)
            with dest.open("xb") as out:
                out.write(src.read(member))

if __name__ == "__main__":
    args = sys.argv[1:]
    try:
        download(*args[:3], pathlib.Path(args[3]), pathlib.Path(args[4]))
    except Exception:
        print("repository snapshot unavailable", file=sys.stderr)
        sys.exit(1)

