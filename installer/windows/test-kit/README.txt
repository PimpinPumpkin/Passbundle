PassBundle: try Windows Hello unlock

For a Windows PC with Windows Hello (face, fingerprint, or PIN) set up.
About 10 minutes. Everything stays on this PC and comes off again with -Remove.

1. Unzip this folder anywhere.
2. Open PowerShell as administrator (right-click Start > Terminal (Admin)).
3. Go to this folder and run:

     Set-ExecutionPolicy -Scope Process Bypass
     .\Try-WindowsHello.ps1

4. Follow the steps it prints.
5. When you're done:

     .\Try-WindowsHello.ps1 -Remove

These are test builds, not signed yet: Windows may warn about them, and the
extension loads in Developer mode. Don't keep real passwords in the test
account.
