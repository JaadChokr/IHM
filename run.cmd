@echo off
rem Lance Fraud Rules (voir run.ps1). Options : run.cmd -Demo, run.cmd -Install, run.cmd -BigQuery
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
