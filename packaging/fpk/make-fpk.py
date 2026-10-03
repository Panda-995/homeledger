#!/usr/bin/env python3
"""家账簿 → 飞牛 fnOS .fpk 打包（Python 实现，显式控制 Unix 权限位）

用法: python make-fpk.py <源码目录> <输出.fpk> [版本号] [--work <工作目录>]
依赖: Node 运行时二进制需已放在 <工作目录>/app/runtime/node
"""
import os
import sys
import tarfile
import shutil
import tempfile

DIR_MODE = 0o755
FILE_MODE = 0o644
EXEC_NAMES = {"node"}
EXEC_RELPATH_PREFIX = ("homeledger/node_modules/.bin/",)
EXEC_SUFFIX = (".sh",)


def add_tree(tf, src_root, arc_root, app_root):
    """递归打包目录，显式设置 mode。路径判断统一用相对 app_root 的完整路径。"""
    for dirpath, dirnames, filenames in os.walk(src_root):
        rel = os.path.relpath(dirpath, src_root)
        arc_dir = arc_root if rel == "." else f"{arc_root}/{rel.replace(os.sep, '/')}"
        info = tf.gettarinfo(dirpath, arc_dir)
        info.mode = DIR_MODE
        info.uid = info.gid = 0
        info.uname = info.gname = "root"
        tf.addfile(info)
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            rel_app = os.path.relpath(full, app_root).replace(os.sep, "/")
            arc = arc_dir + "/" + name
            info = tf.gettarinfo(full, arc)
            info.mode = FILE_MODE
            base = os.path.basename(rel_app)
            if (base in EXEC_NAMES or rel_app.startswith(EXEC_RELPATH_PREFIX)
                    or rel_app.endswith(EXEC_SUFFIX) or rel_app == "homeledger/server.js"):
                info.mode = DIR_MODE  # 755
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            info.mtime = 0
            tf.addfile(info, open(full, "rb") if info.size else None)


def build_app_tgz(app_dir, out_path):
    node = os.path.join(app_dir, "runtime", "node")
    if not os.path.isfile(node):
        raise SystemExit(f"❌ 缺少 Node 运行时: {node}（需先准备 linux-x64 的 node 二进制）")
    with tarfile.open(out_path, "w:gz", compresslevel=6) as tf:
        for top in ("homeledger", "runtime", "ui"):
            add_tree(tf, os.path.join(app_dir, top), top, app_dir)


CALLBACK_STUBS = {
    name: f"#!/bin/bash\n\n### This script is called {when} the user {verb} the application.\n\nexit 0\n"
    for name, when, verb in (
        ("config_callback", "after", "changes environment variables in"),
        ("config_init", "before", "changes environment variables in"),
        ("install_callback", "after", "installs"),
        ("install_init", "before", "installs"),
        ("uninstall_callback", "after", "uninstalls"),
        ("uninstall_init", "before", "uninstalls"),
        ("upgrade_callback", "after", "upgrades"),
        ("upgrade_init", "before", "upgrades"),
    )
}

MANIFEST_TMPL = """appname               = homeledger
version               = {version}
display_name          = 家账簿
desc                  = 纯后端家庭记账网站：账号密码登录，支持支出/收入/转账/借贷/投资/报销/退款等全类型记账；AI 截图/文本自动记账（支持 OpenAI 兼容接口与规则兜底）；支付宝/微信账单导入；多人共享账本、预算、周期账单、储蓄目标、报表图表；开放 API 可对接小龙虾等自动化工具。数据全部存储在本机 SQLite，不上传云端。
platform              = x86
source                = thirdparty
maintainer            = Panda-995
maintainer_url        = https://github.com/Panda-995/homeledger
distributor           = Panda-995
distributor_url       = https://github.com/Panda-995/homeledger
os_min_version        = 0.8.0
desktop_uidir         = ui
desktop_applaunchname = homeledger.Application
service_port          = 5111
checkport             = true
disable_authorization_path = true
changelog             = v{version}
"""

PRIVILEGE = '{\n    "defaults":\n    {\n        "run-as": "package"\n    }\n}\n'

RESOURCE = '''{
  "data-share": {
    "shares": [
      {
        "name": "homeledger"
      },
      {
        "name": "homeledger/data"
      }
    ]
  }
}
'''


def write_text(path, content):
    if not os.path.isfile(path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(content)


def build_fpk(outer_dir, out_path):
    """外层：app.tgz, cmd/(755), config/, ICON.PNG, ICON_256.PNG, manifest, wizard/"""
    members = []
    for root, dirs, files in os.walk(outer_dir):
        rel = os.path.relpath(root, outer_dir)
        for name in sorted(dirs) + sorted(files):
            full = os.path.join(root, name)
            arc = name if rel == "." else f"{rel.replace(os.sep, '/')}/{name}"
            members.append((full, arc))
    # 保证 app.tgz 在前
    members.sort(key=lambda m: (m[1] != "app.tgz", m[1]))
    with tarfile.open(out_path, "w:gz", compresslevel=6) as tf:
        for full, arc in members:
            info = tf.gettarinfo(full, arc)
            if info.isdir():
                info.mode = DIR_MODE
            elif info.name.startswith("cmd/"):
                info.mode = DIR_MODE
            else:
                info.mode = FILE_MODE
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            tf.addfile(info, open(full, "rb") if info.size else None)


def main():
    src = os.path.abspath(sys.argv[1])
    out = os.path.abspath(sys.argv[2])
    work = os.path.abspath(sys.argv[3]) if len(sys.argv) > 3 else tempfile.mkdtemp(prefix="fpk-")
    print(f"==> 工作目录: {work}")

    app_dir = os.path.join(work, "app")
    outer_dir = os.path.join(work, "outer")
    os.makedirs(app_dir, exist_ok=True)
    os.makedirs(outer_dir, exist_ok=True)

    # 1. 应用文件（从已组装好的 work/app 取，或从源码组装）
    if not os.path.isdir(os.path.join(app_dir, "homeledger")):
        print("==> 复制源码")
        hl = os.path.join(app_dir, "homeledger")
        os.makedirs(hl, exist_ok=True)
        for item in ("server.js", "package.json", "package-lock.json"):
            shutil.copy(os.path.join(src, item), os.path.join(hl, item))
        for item in ("src", "public", "node_modules"):
            shutil.copytree(os.path.join(src, item), os.path.join(hl, item))
    os.makedirs(os.path.join(app_dir, "runtime"), exist_ok=True)
    os.makedirs(os.path.join(app_dir, "ui", "images"), exist_ok=True)
    os.makedirs(os.path.join(outer_dir, "wizard"), exist_ok=True)

    # 2. 外层固定文件（manifest/privilege/resource/回调脚本缺失时自动生成）
    pkg = os.path.join(os.path.dirname(os.path.abspath(__file__)))
    try:
        with open(os.path.join(src, "package.json"), encoding="utf-8") as f:
            import json
            version = json.load(f).get("version", "1.0.0")
    except Exception:
        version = "1.0.0"
    write_text(os.path.join(outer_dir, "manifest"), MANIFEST_TMPL.format(version=version))
    write_text(os.path.join(outer_dir, "config", "privilege"), PRIVILEGE)
    write_text(os.path.join(outer_dir, "config", "resource"), RESOURCE)
    for name, stub in CALLBACK_STUBS.items():
        write_text(os.path.join(outer_dir, "cmd", name), stub)
    for name in ("cmd-main",):
        dst = os.path.join(outer_dir, "cmd", "main")
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy(os.path.join(pkg, name), dst)
    for icon in ("ICON.PNG", "ICON_256.PNG"):
        p = os.path.join(pkg, icon)
        if os.path.isfile(p):
            shutil.copy(p, os.path.join(outer_dir, icon))
            shutil.copy(p, os.path.join(app_dir, "ui", "images",
                        "icon_64.png" if icon == "ICON.PNG" else "icon_256.png"))
    # ui/config 由调用方提供，缺省写出
    ui_cfg = os.path.join(app_dir, "ui", "config")
    if not os.path.isfile(ui_cfg):
        with open(ui_cfg, "w", encoding="utf-8") as f:
            f.write('''{
    ".url": {
        "homeledger.Application": {
            "title": "家账簿",
            "icon": "images/icon_{0}.png",
            "type": "iframe",
            "protocol": "http",
            "port": "5111",
            "url": "/",
            "allUsers": false
        }
    }
}
''')

    # 3. 打包
    print("==> 生成 app.tgz（显式权限位）")
    app_tgz = os.path.join(outer_dir, "app.tgz")
    build_app_tgz(app_dir, app_tgz)
    print("==> 生成 fpk")
    build_fpk(outer_dir, out)
    print(f"✅ 完成: {out} ({os.path.getsize(out)//1048576}MB)")


if __name__ == "__main__":
    main()
