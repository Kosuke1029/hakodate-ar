"""モデル (.glb) を、HTML を直接開いた (file://) 時にも読めるよう .glb.js に埋め込む。

Blender で .glb を書き出し直したり、新しく足したりしたら実行する:  python embed_model.py
  - models/avatar/<種類>/*.glb  … アバターのパーツ (必要な時に自動で読み込まれる)
  - models/*_white.glb          … 旧デザイン用モデル
アバターのパーツを足したら、js/models.js の CATEGORIES の items に名前も足すこと。
"""
import base64, os, pathlib

root = pathlib.Path(os.path.dirname(os.path.abspath(__file__)))
files = sorted((root / "models").glob("*_white.glb")) + sorted((root / "models" / "avatar").glob("*/*.glb"))
total = 0
for glb in files:
    b64 = base64.b64encode(glb.read_bytes()).decode()
    key = glb.relative_to(root).as_posix()
    out = glb.with_name(glb.name + ".js")
    out.write_text(
        "// 自動生成 (python embed_model.py)。直接編集しない\n"
        f"(window.EMBEDDED_GLB ??= {{}})['{key}'] = '{b64}';\n",
        encoding="utf-8",
    )
    total += len(b64)
print(f"{len(files)} files embedded ({total // 1024} KB)")
