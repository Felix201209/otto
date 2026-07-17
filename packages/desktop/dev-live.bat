@echo off
echo ============================================
echo  Otto Live Dev —— 浏览器里跑 Otto 桌面版
echo ============================================
echo.
echo  1. 构建前端 (webpack)...
cd /d "D:\otto\otto-repo\packages\desktop"
call npx webpack --config webpack.live.cjs
echo.
echo  2. 启动 Otto Server + 静态服务器...
start "Otto-Live" node serve-live.js
echo.
echo  ✅ 打开浏览器: http://127.0.0.1:3300
echo.
echo  改代码后：重新运行本脚本（或只跑 webpack 那行）→刷新浏览器
echo  按 Ctrl+C 停止服务器
pause
