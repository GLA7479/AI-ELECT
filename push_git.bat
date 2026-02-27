@echo off
setlocal EnableDelayedExpansion

echo ===========================================
echo    Auto Git Push - electrician-ai
echo ===========================================
echo.

cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Git is not installed or not in PATH.
  pause
  exit /b 1
)

for /f "delims=" %%b in ('git branch --show-current') do set BRANCH=%%b
if "%BRANCH%"=="" set BRANCH=main

echo Current branch: %BRANCH%
echo.

git status --porcelain > .git\_cursor_git_status_tmp.txt
for %%A in (.git\_cursor_git_status_tmp.txt) do set FILESIZE=%%~zA
del .git\_cursor_git_status_tmp.txt >nul 2>nul

if "%FILESIZE%"=="0" (
  echo [INFO] No changes to commit. Running push anyway...
  git push origin %BRANCH%
  if errorlevel 1 (
    echo [ERROR] Push failed.
  ) else (
    echo [OK] Push completed.
  )
  echo.
  pause
  exit /b 0
)

set COMMIT_MSG=auto: update project files
set /p COMMIT_MSG=Commit message ^(Enter for default^): 
if "%COMMIT_MSG%"=="" set COMMIT_MSG=auto: update project files

echo.
echo [1/3] git add .
git add .
if errorlevel 1 (
  echo [ERROR] git add failed.
  pause
  exit /b 1
)

echo [2/3] git commit -m "%COMMIT_MSG%"
git commit -m "%COMMIT_MSG%"
if errorlevel 1 (
  echo [ERROR] git commit failed.
  pause
  exit /b 1
)

echo [3/3] git push origin %BRANCH%
git push origin %BRANCH%
if errorlevel 1 (
  echo [ERROR] git push failed.
  pause
  exit /b 1
)

echo.
echo [OK] All done: add + commit + push completed.
echo.
pause
exit /b 0
