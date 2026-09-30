# 函館市電 AR

机の黒いケーブルカバー（約90×20cm）をスマホのカメラで写すと、函館市電500形が溝に沿って走るWeb ARです。

- 画像認識: OpenCV.js（黒い長方形を検出 → solvePnP で姿勢推定）
- 3D表示: Three.js + GLB

## ローカル開発
```
python dev_server.py
```
http://localhost:8765/?test&debug でテスト画像（test/table.jpg）を使った確認ができます。
