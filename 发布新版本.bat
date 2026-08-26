@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ================================================================
echo   发布 MyCursor 换号助手 新版本
echo   会改版本号 - 提交 - 打 tag - 推送，GitHub 自动出 Win/Mac 包
echo ================================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0release.ps1"
