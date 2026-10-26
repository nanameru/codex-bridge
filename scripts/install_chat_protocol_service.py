"""Deploy the shared Chat helper while retaining legacy guards and rollback."""
import argparse
import hashlib
import os
from pathlib import Path
import plistlib
import subprocess
import sys
from install_router_service import replace_registration, wait_for_idle
from local_security import verify_service
from patch_chat_protocol import HELPERS, MANIFEST, apply
from switch_config import atomic_write
import time


def deployment_revision(target):
    paths=[target, *(target.with_name(name) for name in HELPERS), target.with_name('local-security.mjs')]
    digest=hashlib.sha256()
    for path in paths:
        digest.update(path.name.encode())
        digest.update(b'\0')
        digest.update(path.read_bytes())
        digest.update(b'\0')
    return digest.hexdigest()


def install(target, update_now=False):
    if sys.platform != 'darwin':
        raise ValueError('macOS専用です')
    label='com.kimurataiyou.codex-bridge'
    path=Path.home()/'Library/LaunchAgents'/(label+'.plist')
    if path.is_symlink() or target.is_symlink() or target.parent.is_symlink():
        raise ValueError('リンク先は更新しません')
    previous=path.read_bytes()
    payload=plistlib.loads(previous)
    if payload.get('Label') != label or str(target) not in payload.get('ProgramArguments',[]):
        raise ValueError('対象サービスが一致しません')
    service=f'gui/{os.getuid()}/{label}'
    active=subprocess.run(['launchctl','print',service],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
    if not active:
        raise ValueError('既存のサービスが起動していません')
    if not update_now:
        wait_for_idle(0,ports=(8788,))
    before=target.read_bytes()
    modules=[target.with_name(name) for name in HELPERS]
    manifest=target.with_name(MANIFEST)
    if any(p.is_symlink() for p in [*modules, manifest, target.with_name('local-security.mjs')]):
        raise ValueError('リンクされたhelperを更新しません')
    saved={p:(p.read_bytes(),p.stat().st_mode&0o777) if p.exists() else None for p in [*modules,manifest]}
    def verify():
        for _ in range(30):
            try:
                verify_service(8788,revision)
                return
            except (OSError,ValueError):
                time.sleep(.2)
        raise ValueError('Chat protocolの稼働を確認できません')
    registration_attempted=False
    try:
        apply(target)
        revision=deployment_revision(target)
        payload['EnvironmentVariables']={**payload.get('EnvironmentVariables',{}),'CODEX_BRIDGE_SECURITY_REVISION':revision}
        registration_attempted=True
        replace_registration(path,payload,service,previous,active,verify)
    except Exception:
        atomic_write(target,before.decode(),target.stat().st_mode&0o777)
        for p,data in saved.items():
            if data is None:
                p.unlink(missing_ok=True)
            else:
                content,permissions=data
                atomic_write(p,content.decode(),permissions)
        if registration_attempted:
            subprocess.run(['launchctl','kickstart','-k',service],check=True)
        raise
    print('Chat bridge revisionと認証拒否401を確認しました: '+revision)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--target',type=Path,default=Path.home()/'home-runner/bridge/codex-bridge.mjs')
    parser.add_argument('--update-now',action='store_true')
    args=parser.parse_args()
    install(args.target,args.update_now)
