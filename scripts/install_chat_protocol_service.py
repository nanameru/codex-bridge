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
from patch_chat_protocol import apply
from switch_config import atomic_write
import time


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
    module=target.with_name('chat-protocol.mjs')
    manifest=target.with_name('.chat-protocol.sha256')
    saved={p:p.read_bytes() if p.exists() else None for p in [module,manifest]}
    apply(target)
    revision=hashlib.sha256(target.read_bytes()+module.read_bytes()+target.with_name('local-security.mjs').read_bytes()).hexdigest()
    payload['EnvironmentVariables']={**payload.get('EnvironmentVariables',{}),'CODEX_BRIDGE_SECURITY_REVISION':revision}
    def verify():
        for _ in range(30):
            try:
                verify_service(8788,revision)
                return
            except (OSError,ValueError):
                time.sleep(.2)
        raise ValueError('Chat protocolの稼働を確認できません')
    try:
        replace_registration(path,payload,service,previous,active,verify)
    except Exception:
        atomic_write(target,before.decode(),target.stat().st_mode&0o777)
        for p,data in saved.items():
            if data is None:
                p.unlink(missing_ok=True)
            else:
                atomic_write(p,data.decode())
        subprocess.run(['launchctl','kickstart','-k',service],check=True)
        raise
    print('Chat bridge revisionと認証拒否401を確認しました: '+revision)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--target',type=Path,default=Path.home()/'home-runner/bridge/codex-bridge.mjs')
    parser.add_argument('--update-now',action='store_true')
    args=parser.parse_args()
    install(args.target,args.update_now)
