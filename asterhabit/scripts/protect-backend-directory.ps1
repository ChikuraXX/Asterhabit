param([Parameter(Mandatory=$true)][string]$Directory)
$ErrorActionPreference='Stop'
# 只保护后台令牌目录，保留应用其他目录与系统权限配置。
$taskPath=(Resolve-Path -LiteralPath $Directory).Path
$taskIdentity=[Security.Principal.WindowsIdentity]::GetCurrent().User
$taskAcl=[Security.AccessControl.DirectorySecurity]::new()
$taskAcl.SetAccessRuleProtection($true,$false)
foreach($taskSid in @($taskIdentity,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){$taskAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($taskSid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))}
Set-Acl -LiteralPath $taskPath -AclObject $taskAcl
