/**
 * @license Copyright 2026 Felix SPDX-License-Identifier: Apache-2.0
 */
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import {
  BaseTool, ToolResult, ToolCallConfirmationDetails,
  Icon, ToolLocation,
} from './tools.js';
import { Type } from '@google/genai';
import { SchemaValidator } from '../utils/schemaValidator.js';
import { Config, ApprovalMode } from '../config/config.js';
import { ProcessGuard } from '../utils/process-guard.js';

const execAsync = promisify(exec);

export interface DiagnoseSystemToolParams {
  action: 'system_info'|'disk_health'|'disk_usage'|'memory'|'network'|'processes'|'cleanup'|'battery'|'startup'|'bluetooth'|'printer'|'brew_doctor'|'repair_permissions';
}

type DiagFn = () => Promise<string>;

export class DiagnoseSystemTool extends BaseTool<DiagnoseSystemToolParams, ToolResult> {
  static readonly Name: string = 'diagnose_system';

  constructor(private readonly config: Config) {
    const desc = `Cross-platform system diagnosis (macOS + Windows).

EXAMPLES:
  System info: {action:"system_info"}
  Disk health: {action:"disk_health"}
  Disk usage: {action:"disk_usage"}
  Memory: {action:"memory"}
  Network: {action:"network"}
  Processes: {action:"processes"}
  Cleanup analysis: {action:"cleanup"}
  Battery: {action:"battery"}
  Startup items: {action:"startup"}
  Bluetooth: {action:"bluetooth"}
  Printer: {action:"printer"}
  Brew doctor: {action:"brew_doctor"}  (macOS only)

All actions except repair_permissions are read-only and auto-approved.
No prerequisites -- uses built-in OS tools on both macOS and Windows.`;
    super(DiagnoseSystemTool.Name, 'DiagnoseSystem', desc, Icon.Wrench,
      {
        type: Type.OBJECT,
        properties: {
          action: { type: Type.STRING, description: 'Diagnostic check to run', enum: ['system_info','disk_health','disk_usage','memory','network','processes','cleanup','battery','startup','bluetooth','printer','brew_doctor','repair_permissions'] },
        },
        required: ['action'],
      },
    );
  }

  validateToolParams(p: DiagnoseSystemToolParams): string | null {
    const e = SchemaValidator.validate(this.schema.parameters!, p, DiagnoseSystemTool.Name);
    return e || null;
  }
  toolLocations(): ToolLocation[] { return []; }
  getDescription(p: DiagnoseSystemToolParams): string { return 'diagnose: '+p.action; }

  async shouldConfirmExecute(p: DiagnoseSystemToolParams, _s: AbortSignal): Promise<ToolCallConfirmationDetails | false> {
    if (p.action === 'repair_permissions') {
      return { type:'exec', title:'[WARN] Repair disk permissions? May require sudo.', command:'diskutil repairPermissions /', rootCommand:'diagnose_system', onConfirm: async ()=>{}};
    }
    return false; // read-only actions are auto-approved
  }

  async execute(p: DiagnoseSystemToolParams, _s: AbortSignal): Promise<ToolResult> {
    const logLabel = 'diagnose_system.'+p.action;
    console.time(logLabel);
    const err = this.validateToolParams(p);
    if (err) return { llmContent: 'diagnose_system FAIL: '+err, returnDisplay: 'diagnose_system FAIL: '+err };
    try {
      const r = await this.dispatch(p.action);
      console.timeEnd(logLabel);
      return { llmContent: r, returnDisplay: 'diagnose_system OK: '+p.action+' complete' };
    } catch (e: unknown) {
      console.timeEnd(logLabel);
      const m = e instanceof Error ? e.message : String(e);
      return { llmContent: 'diagnose_system FAIL: '+m, returnDisplay: 'diagnose_system FAIL: '+m };
    }
  }

  private async dispatch(action: string): Promise<string> {
    const isMac = os.platform() === 'darwin';
    const map: Record<string, DiagFn> = {
      system_info:  ()=>isMac?this.macSystemInfo():this.winSystemInfo(),
      disk_health:  ()=>isMac?this.macDiskHealth():this.winDiskHealth(),
      disk_usage:   ()=>isMac?this.macDiskUsage():this.winDiskUsage(),
      memory:       ()=>isMac?this.macMemory():this.winMemory(),
      network:      ()=>isMac?this.macNetwork():this.winNetwork(),
      processes:    ()=>isMac?this.macProcesses():this.winProcesses(),
      cleanup:      ()=>isMac?this.macCleanup():this.winCleanup(),
      battery:      ()=>isMac?this.macBattery():this.winBattery(),
      startup:      ()=>isMac?this.macStartup():this.winStartup(),
      bluetooth:    ()=>isMac?this.macBluetooth():this.winBluetooth(),
      printer:      ()=>isMac?this.macPrinter():this.winPrinter(),
      brew_doctor:  ()=>{ if(os.platform()!=='darwin') return Promise.resolve('brew_doctor: macOS only action'); return this.macBrewDoctor(); },
      repair_permissions: ()=>{ if(os.platform()!=='darwin') return Promise.resolve('repair_permissions: macOS only action'); return this.macRepairPerms(); },
    };
    const fn = map[action];
    if (!fn) throw new Error('Unknown action: '+action);
    return fn();
  }

  private async sh(c: string, opts?: {maxBuffer?:number}): Promise<string> {
    const result = await ProcessGuard.exec({ command: c, maxBuffer: opts?.maxBuffer??5*1024*1024, timeoutMs: 30000 });
    return result.stdout.trim();
  }
  private async ps(c: string): Promise<string> {
    const enc = Buffer.from(c, 'utf16le').toString('base64');
    const result = await ProcessGuard.exec({ command: 'powershell -NoProfile -NonInteractive -EncodedCommand '+enc, maxBuffer: 10*1024*1024, timeoutMs: 60000 });
    return result.stdout.trim();
  }

  // ===== macOS =====
  private hf(t:string,b:string):string{return '## '+t+'\n```\n'+b+'\n```\n';}
  private async macSystemInfo():Promise<string>{return this.hf('System Info',await this.sh('system_profiler SPHardwareDataType SPSoftwareDataType 2>/dev/null')+'\n\nUptime: '+await this.sh('uptime'));}
  private async macDiskHealth():Promise<string>{return this.hf('Disk Health',await this.sh('diskutil info / 2>/dev/null'))+this.hf('Verify',await this.sh('diskutil verifyVolume / 2>&1 | head -30'));}
  private async macDiskUsage():Promise<string>{
    const df=await this.sh('df -h /');
    const top=await this.sh('du -sh ~/Library/Caches ~/Library/Logs /tmp ~/Downloads ~/Desktop 2>/dev/null');
    const big=await this.sh('find ~ -type f -size +100M -exec ls -lh {} \\; 2>/dev/null | sort -k5 -h -r | head -20');
    return this.hf('Disk Usage',df)+this.hf('Common dirs',top)+this.hf('Large files (>100MB)',big||'None');
  }
  private async macMemory():Promise<string>{
    const gb=(parseInt(await this.sh('sysctl -n hw.memsize'))/1024/1024/1024).toFixed(1);
    return 'Total: '+gb+' GB\n\n'+this.hf('VM Stats',await this.sh('vm_stat'))+this.hf('Top CPU',await this.sh('ps aux -c -r | head -20'));
  }
  private async macNetwork():Promise<string>{
    const ports=await this.sh('networksetup -listallhardwareports 2>/dev/null');
    const ip=await this.sh('ifconfig en0 2>/dev/null | grep "inet "');
    const wifi=await this.sh('networksetup -getairportnetwork en0 2>/dev/null || echo "N/A"');
    const dns=await this.sh('scutil --dns 2>/dev/null | grep nameserver | head -5');
    let ping='';try{ping=await this.sh('ping -c 2 -t 3 8.8.8.8 2>&1 | tail -3');}catch{ping='Ping failed';}
    return this.hf('Interfaces',ports)+'en0: '+ip+'\nWiFi: '+wifi+'\n'+this.hf('DNS',dns)+this.hf('Ping 8.8.8.8',ping);
  }
  private async macProcesses():Promise<string>{return this.hf('Top CPU',await this.sh('ps aux -c -r | head -25'));}
  private async macCleanup():Promise<string>{
    const h=os.homedir();const p:string[]=[];
    try{p.push(this.hf('Caches',await this.sh('du -sh "'+h+'/Library/Caches"/*/ 2>/dev/null | sort -rh | head -10')));}catch{}
    try{p.push(this.hf('/tmp',await this.sh('du -sh /tmp/*/ 2>/dev/null | sort -rh | head -10')));}catch{}
    try{p.push(this.hf('Trash',await this.sh('du -sh "'+h+'/.Trash/" 2>/dev/null || echo "Empty"')));}catch{}
    return p.join('\n')+'\nSafe cleanup: brew cleanup --prune=all | rm -rf ~/.Trash/* | docker system prune -a';
  }
  private async macBattery():Promise<string>{
    try{return this.hf('Battery',await this.sh('pmset -g batt'))+await this.sh('ioreg -r -c AppleSmartBattery | grep -E "MaxCapacity|DesignCapacity|CycleCount" | head -5');}
    catch{return 'Battery info not available (desktop Mac?).';}
  }
  private async macStartup():Promise<string>{
    return this.hf('Launch Agents',await this.sh('ls ~/Library/LaunchAgents /Library/LaunchAgents /Library/LaunchDaemons 2>/dev/null'))+
      this.hf('Login Items',await this.sh("osascript -e 'tell application \"System Events\" to get name of every login item' 2>/dev/null || echo 'N/A'"));
  }
  private async macBluetooth():Promise<string>{
    try{return this.hf('Bluetooth',await this.sh('system_profiler SPBluetoothDataType 2>/dev/null | head -40'));}
    catch{return 'Bluetooth info not available.';}
  }
  private async macPrinter():Promise<string>{
    try{return this.hf('Printers',await this.sh('lpstat -p 2>/dev/null || echo "No printers configured"'))+this.hf('CUPS',await this.sh('lpstat -t 2>/dev/null | head -20'));}
    catch{return 'Printer check requires CUPS.';}
  }
  private async macBrewDoctor():Promise<string>{
    try{return this.hf('Brew Doctor',await this.sh('brew doctor 2>&1')||'All OK');}
    catch{return 'Homebrew not installed.';}
  }
  private async macRepairPerms():Promise<string>{
    try{return this.hf('Repair',await this.sh('sudo diskutil repairPermissions / 2>&1'));}
    catch{return 'Requires sudo: sudo diskutil repairPermissions /';}
  }

  // ===== Windows =====
  private async winSystemInfo():Promise<string>{
    const info=await this.ps('Get-ComputerInfo|Select CsName,OsName,OsVersion,OsArchitecture,CsTotalPhysicalMemory|Format-List|Out-String');
    const gpu=await this.ps('Get-CimInstance Win32_VideoController|Select Name,DriverVersion|Format-List|Out-String');
    const up=await this.ps('(Get-Date)-(gcim Win32_OperatingSystem).LastBootUpTime');
    return this.hf('System',info)+this.hf('GPU',gpu)+'Uptime: '+up;
  }
  private async winDiskHealth():Promise<string>{
    const smart=await this.ps('Get-PhysicalDisk|Select FriendlyName,MediaType,HealthStatus,OperationalStatus,Size|Format-Table -AutoSize|Out-String -Width 160');
    let chk='';try{chk=await this.ps('chkdsk C: /scan 2>&1|Select -Last 20');}catch{chk='chkdsk requires admin.';}
    return this.hf('Physical Disks',smart)+this.hf('chkdsk C: /scan',chk);
  }
  private async winDiskUsage():Promise<string>{
    const drives=await this.ps('Get-PSDrive -PSProvider FileSystem|Select Name,Used,Free,@{N="SizeGB";E={[math]::Round(($_.Used+$_.Free)/1GB,1)}}|Format-Table -AutoSize|Out-String');
    const top=await this.ps('Get-ChildItem C:\\ -Directory -ErrorAction SilentlyContinue|ForEach-Object{$s=(Get-ChildItem $_.FullName -Recurse -File -ErrorAction SilentlyContinue|Measure-Object -Property Length -Sum).Sum;[PSCustomObject]@{Name=$_.Name;SizeGB=[math]::Round($s/1GB,2)}}|Sort SizeGB -Descending|Select -First 15|Format-Table -AutoSize|Out-String');
    return this.hf('Drives',drives)+this.hf('C:\\ top-level',top);
  }
  private async winMemory():Promise<string>{
    const mem=await this.ps('Get-CimInstance Win32_OperatingSystem|Select TotalVisibleMemorySize,FreePhysicalMemory|Format-List|Out-String');
    const top=await this.ps('Get-Process|Sort WorkingSet64 -Descending|Select -First 15 ProcessName,@{N="MemMB";E={[math]::Round($_.WorkingSet64/1MB,0)}}|Format-Table -AutoSize|Out-String');
    return this.hf('Memory',mem)+this.hf('Top Processes',top);
  }
  private async winNetwork():Promise<string>{
    const ad=await this.ps('Get-NetAdapter|Select Name,Status,LinkSpeed,InterfaceDescription|Format-Table -AutoSize|Out-String -Width 200');
    const ip=await this.ps('Get-NetIPAddress -AddressFamily IPv4|?{$_.IPAddress -ne "127.0.0.1"}|Select InterfaceAlias,IPAddress|Format-Table -AutoSize|Out-String');
    let ping='';try{ping=await this.ps('Test-Connection 8.8.8.8 -Count 2|Format-Table -AutoSize|Out-String');}catch{ping='Ping failed';}
    return this.hf('Adapters',ad)+this.hf('IP',ip)+this.hf('Ping 8.8.8.8',ping);
  }
  private async winProcesses():Promise<string>{
    return this.hf('Top CPU',await this.ps('Get-Process|Sort CPU -Descending|Select -First 25 ProcessName,Id,@{N="CPU(s)";E={[math]::Round($_.CPU,1)}},@{N="MemMB";E={[math]::Round($_.WorkingSet64/1MB,0)}}|Format-Table -AutoSize|Out-String'));
  }
  private async winCleanup():Promise<string>{
    const p:string[]=[];
    try{p.push(this.hf('Temp',await this.ps('Get-ChildItem $env:TEMP -File -Recurse -ErrorAction SilentlyContinue|Measure-Object -Property Length -Sum|%{"Total: "+[math]::Round($_.Sum/1MB,0)+" MB"}')));}catch{}
    try{p.push(this.hf('Recycle Bin',await this.ps('$s=New-Object -ComObject Shell.Application;$s.NameSpace(0x0a).Items()|%{$_.Name+" ("+[math]::Round($_.Size/1MB,1)+" MB)"}|Select -First 10')));}catch{}
    try{p.push(this.hf('WinSxS',await this.ps('Dism.exe /Online /Cleanup-Image /AnalyzeComponentStore 2>&1|Select -Last 10')));}catch{}
    return p.join('\n')+'\nSafe cleanup: cleanmgr /sageset:1 | Dism.exe /Online /Cleanup-Image /StartComponentCleanup | Clear %TEMP%';
  }
  private async winBattery():Promise<string>{
    try{return this.hf('Battery',await this.ps('Get-CimInstance Win32_Battery|Select Name,DesignCapacity,FullChargeCapacity,EstimatedChargeRemaining|Format-List|Out-String'));}
    catch{return 'Battery info not available (desktop?).';}
  }
  private async winStartup():Promise<string>{
    return this.hf('Startup Commands',await this.ps('Get-CimInstance Win32_StartupCommand|Select Name,Command,User|Format-Table -AutoSize|Out-String -Width 200')||'None')+
      this.hf('Scheduled Tasks',await this.ps('Get-ScheduledTask|?{$_.Settings.Hidden -eq $false}|Select TaskName,State|Format-Table -AutoSize|Out-String -Width 160')||'None');
  }
  private async winBluetooth():Promise<string>{
    try{return this.hf('Bluetooth',await this.ps('Get-PnpDevice -Class Bluetooth|Select FriendlyName,Status|Format-Table -AutoSize|Out-String -Width 200')||'None');}
    catch{return 'Bluetooth check requires Windows 10+.';}
  }
  private async winPrinter():Promise<string>{
    try{return this.hf('Printers',await this.ps('Get-Printer|Select Name,DriverName,PortName,PrinterStatus,Shared|Format-Table -AutoSize|Out-String -Width 200')||'None')+
      this.hf('Queue',await this.ps('Get-PrintJob -ErrorAction SilentlyContinue|Select PrinterName,JobId,@{N="SizeKB";E={[math]::Round($_.Size/1KB,0)}}}|Format-Table -AutoSize|Out-String')||'Empty');}
    catch{return 'Printer check requires Windows 10+.';}
  }
}
